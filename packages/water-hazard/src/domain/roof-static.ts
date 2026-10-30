/** 顶板三图的静态取数、钻孔分级和工作面区域评分。 */
import { csv } from '../infrastructure/assets.ts'
import { numeric } from '../infrastructure/api.ts'
import { WATER_LEVELS, HAZARD_RISK_MATRIX } from './constants.ts'
import { interpolate, inside, type XY, type Grid, type Point } from './kriging.ts'
import { round } from './numeric.ts'

export type StaticKind = keyof typeof WATER_LEVELS
export type StaticPoint = Point & { id: string; level: number }
export type StaticMap = { kind: StaticKind; title: string; metric: string; unit: string; points: StaticPoint[]; grid: Grid; level: number }
export type StaticAnalysis = { boundary: XY[]; face: XY[]; maps: StaticMap[] }
export function pointLevel(kind: StaticKind, value: number): number {
  const found = WATER_LEVELS[kind].findIndex(([lo, hi]) => lo <= value && value < hi)
  return found < 0 ? 0 : found
}
export function staticPoints() {
  const richness = csv('water_inflow.csv').map(row => {
    const value = numeric(row.单位涌水量, '单位涌水量')
    return { id: row.编号, x: numeric(row.X, 'X'), y: numeric(row.Y, 'Y'), value, level: pointLevel('richness', value) }
  })
  const channel = csv('borehole_data.csv').map(row => {
    const coal = numeric(row.煤层厚度, '煤层厚度'), thickness = numeric(row.隔水层厚度, '隔水层厚度')
    const [a, b] = row.岩性 === '坚硬' ? [1.2, 2] : row.岩性 === '软弱' ? [3.1, 5] : [1.6, 3.6]
    const protective = thickness - 100 * coal / (a * coal + b)
    return { id: row.编号, x: numeric(row.X, 'X'), y: numeric(row.Y, 'Y'), value: round(protective, 2), level: pointLevel('channel', protective) }
  })
  const channels = new Map(channel.map(point => [point.id, point]))
  const hazard = richness.filter(point => channels.has(point.id)).map(point => ({ ...point,
    value: round(0.4 * point.level + 0.6 * channels.get(point.id)!.level, 2), level: HAZARD_RISK_MATRIX[point.level][channels.get(point.id)!.level],
  }))
  return { richness, channel, hazard }
}
export function workfaceLevel(grid: Grid, face: XY[], kind: StaticKind): number {
  const values = grid.z.flatMap((row, i) => row.filter((value, j): value is number => value !== null && inside(grid.x[j], grid.y[i], face)))
  if (!values.length) return 0
  const value = kind === 'channel' ? Math.min(...values) : Math.max(...values)
  const found = WATER_LEVELS[kind].findIndex(([lo, hi]) => lo <= value && value < hi)
  return found >= 0 ? found : value < WATER_LEVELS[kind][0][0] ? 0 : 4
}
export async function staticAnalysis(workface: string, signal: AbortSignal): Promise<StaticAnalysis> {
  const boundary: XY[] = csv('mine_boundary.csv').map(row => [numeric(row.X, 'X'), numeric(row.Y, 'Y')])
  const bounds = csv('workfaces_boundary.csv').find(row => row.workface_name === workface)
  if (!bounds) throw new Error(`工作面 ${workface} 缺少静态边界`)
  const face: XY[] = Array.from({ length: 4 }, (_, i) => [numeric(bounds[`x${i + 1}`], '工作面X'), numeric(bounds[`y${i + 1}`], '工作面Y')])
  const points = staticPoints(), maps: StaticMap[] = []
  for (const [kind, title, metric, unit] of [
    ['richness', '顶板含水层富水性分区图', '单位涌水量', ''],
    ['channel', '顶板冒裂安全性分区图', '保护层厚度', 'm'],
    ['hazard', '顶板水害危险性分区图', '危险性指数', ''],
  ] as const) {
    const grid = await interpolate(points[kind], boundary, signal)
    maps.push({ kind, title, metric, unit, grid, points: points[kind], level: workfaceLevel(grid, face, kind) })
  }
  return { boundary, face, maps }
}
