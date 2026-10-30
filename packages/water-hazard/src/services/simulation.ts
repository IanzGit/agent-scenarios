/** API 网络、人员抽样、本地计算与应急参考资料协调。 */
import { result, table, type Row } from 'dsh-agent-shared'
import { WaterHazardAPI, numeric, text } from '../infrastructure/api.ts'
import { validateWorkface } from './workfaces.ts'
import { documentEvidence, searchDocuments } from './knowledge.ts'
import { generateMesh, flooding, submerge, escapeRoutes, type Node, type Roadway, type Person } from '../domain/simulation.ts'
import { simulationMaps } from '../presentation/simulation-maps.ts'
import { round } from '../domain/numeric.ts'

export function samplePersonnel(personnel: Person[], random = Math.random): Person[] {
  const pool = [...personnel]
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
  return pool.slice(0, 10)
}
export async function inrushSimulation(api: WaterHazardAPI, signal: AbortSignal, workface: string, inrushRate = 1800, simulationTime = 86400) {
  if (!Number.isFinite(inrushRate) || inrushRate <= 0) throw new Error('inrush_rate 必须为有限正数')
  if (!Number.isFinite(simulationTime) || simulationTime <= 0) throw new Error('simulation_time 必须为有限正数')
  workface = await validateWorkface(api, workface, signal)
  const [location, roadwayData, people] = await Promise.all([api.location(workface, signal), api.roadways(signal), api.personnel(signal)])
  const coordinate = { x: numeric(location.x, '工作面X'), y: numeric(location.y, '工作面Y'), z: numeric(location.z, '工作面Z') }
  const lookup = new Map<number, Node>(), roadways: Roadway[] = []
  const id = (value: unknown, field: string) => { const n = numeric(value, field); if (!Number.isSafeInteger(n)) throw new Error(`${field} 必须为整数`); return n }
  for (const row of roadwayData) {
    for (const side of ['start', 'stop']) {
      const nodeId = id(row[`${side}Code`], '巷道端点ID')
      if (lookup.has(nodeId)) continue
      const x = numeric(row[`${side}X`] || 0, '巷道X'), y = numeric(row[`${side}Y`] || 0, '巷道Y')
      if (x === 0 && y === 0) continue
      lookup.set(nodeId, { id: nodeId, x, y, z: numeric(row[`${side}Z`] || 0, '巷道Z'), name: text(row[`${side}PointName`], '').trim() || String(nodeId), exit: Number(row[`${side}IsEnd`] || 0) === 1 })
    }
    const roadwayId = id(row.code, '巷道ID')
    roadways.push({ id: roadwayId, start: id(row.startCode, '巷道起点'), end: id(row.stopCode, '巷道终点'), name: String(roadwayId), width: 3, height: 2, closed: numeric(row.closedState || 0, '巷道关闭状态') })
  }
  const nodes = [...lookup.values()].sort((a, b) => a.id - b.id)
  roadways.sort((a, b) => a.id - b.id)
  if (!nodes.length || !roadways.length) throw new Error('仿真节点或巷道数据为空，无法执行本地仿真')
  const personnel = samplePersonnel(people.map(row => ({ id: id(String(row.personId).replace(/^P/, ''), '人员ID'), name: text(row.personName, '').trim() || String(row.personId).replace(/^P/, ''), x: numeric(row.pointX, '人员X'), y: numeric(row.pointY, '人员Y'), z: numeric(row.pointZ, '人员Z') })))
  const distance = (node: Node) => Math.hypot(coordinate.x - node.x, coordinate.y - node.y, coordinate.z - node.z)
  const source = nodes.reduce((best, node) => distance(node) < distance(best) ? node : best)
  const mesh = await generateMesh(nodes, roadways, signal)
  const entries = await flooding(mesh, source.id, inrushRate / 3600, signal)
  const states = submerge(mesh, entries, simulationTime)
  for (const roadway of roadways) if (!states.has(roadway.id)) states.set(roadway.id, { status: '正常', type: 0, fraction: 0 })
  const routes = await escapeRoutes(mesh, states, personnel, nodes, signal)
  const frames = Array.from({ length: 12 }, (_, i) => {
    const time = i * simulationTime / 11, state = submerge(mesh, entries, time)
    return { time, roadway_final_status: Object.fromEntries(roadways.map(roadway => [roadway.id, { status: state.get(roadway.id)?.status ?? '正常' }])) }
  })
  const basemap = await api.basemap(signal)
  const documents = simulationMaps(workface, { nodes, roadways, personnel, routes, source, time: simulationTime, basemap, states, frames })
  const floodRows: Row[] = ['正常', '半淹', '全淹'].map(status => {
    const count = [...states.values()].filter(state => state.status === status).length
    return { 水淹状态: status, 巷道数量: count, '占比(%)': round(count / (states.size || 1) * 100, 1) }
  })
  const routeRows: Row[] = routes.map(route => ({ 人员: route.person.name, 路线: route.route.length ? `起点${route.route[0]} → 出口${route.exit}` : '-', 出口: route.exit,
    '距离(m)': round(route.distance, 1), '预计时间(min)': round(route.estimated, 1), 状态: route.status }))
  const canEvacuate = routes.filter(route => route.status === '可撤离').length
  const evidence = documentEvidence(searchDocuments('煤矿水害事故 应急处置流程 组织职责 抢险救援 指挥调度', 6, ['应急演练方案']), '应急演练参考', 1500)
  const summary = `工作面：${workface}。突水量${inrushRate}m³/h，仿真时长${simulationTime}秒。水淹仿真与路线分析均已完成本地计算。\n`
    + `抽样${personnel.length}人：可撤离${canEvacuate}人，被困${personnel.length - canEvacuate}人。本次最多随机抽取10人，结果为仿真推演，不代表全矿人员或现场执行状态。\n\n${evidence || '未检索到应急演练参考资料。'}`
  signal.throwIfAborted()
  return { value: result(`${workface}工作面突水仿真与处置预案`, summary, [table('巷道水淹状态统计表', ['水淹状态', '巷道数量', '占比(%)'], floodRows), table('人员避灾路线表', ['人员', '路线', '出口', '距离(m)', '预计时间(min)', '状态'], routeRows)]), documents }
}
