import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Row } from 'dsh-agent-shared'
import { staticAnalysis, staticPoints, type StaticKind, type StaticPoint } from '../src/domain/roof-static.ts'
import { fitVariogram } from '../src/domain/kriging.ts'
import { round } from '../src/domain/numeric.ts'
import { dynamicIndicators, comprehensiveWarning, type Dynamic } from '../src/domain/roof-dynamic.ts'
import { generateMesh, flooding, submerge, escapeRoutes, type Node, type Roadway, type Person } from '../src/domain/simulation.ts'
import { reviewStatistics } from '../src/services/review.ts'
import { reportSummary, searchDocuments } from '../src/services/knowledge.ts'
import { samplePersonnel } from '../src/services/simulation.ts'

type OriginalRecord = { date: string; value: number; metric_name: string; source_name: string; sensor_name: string; unit: string; 监测范围: string }
const reference = JSON.parse(readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8')) as {
  static: Record<StaticKind, { parameters: number[]; points: StaticPoint[]; samples: number[][]; levels: Record<string, number> }>
  dynamic: { input: { inflow: number[]; borehole: number[]; quality: number[]; pressure: number[]; thresholds: number[]; distance: number }; levels: number[]; basis: string[] }[]
  comprehensive: { static: number[]; dynamic: number[]; warning: string; analysis: Row[] }[]
  simulations: { time: number; states: Record<string, { type: number; fraction: number }>; routes: { route: number[]; distance: number; estimated_time: number; status: string }[] }[]
  review: { records: OriginalRecord[]; quality: Row[]; statistics: Row[]; precursors: Row[]; response: Row }
}
const signal = () => new AbortController().signal
function close(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`)
}

test('静态钻孔分级、球状拟合、网格及两个工作面的评分与原 Python 对照', async () => {
  const points = staticPoints()
  for (const kind of ['richness', 'channel', 'hazard'] as const) {
    assert.deepEqual(points[kind], reference.static[kind].points)
    fitVariogram(points[kind]).forEach((value, i) => close(value, reference.static[kind].parameters[i]))
  }
  for (const workface of ['45208', '85211']) {
    const analysis = await staticAnalysis(workface, signal())
    for (const map of analysis.maps) {
      assert.equal(map.level, reference.static[map.kind].levels[workface])
      for (const [i, j, value] of reference.static[map.kind].samples) close(map.grid.z[i][j]!, value)
    }
  }
})

test('动态指标70组边界及综合预警120组组合与原 Python 一致', () => {
  for (const sample of reference.dynamic) {
    const daily = (values: number[], unit: string) => values.map(value => ({ value, unit }))
    const { input } = sample
    const result = dynamicIndicators(daily(input.inflow, 'm³/h'), daily(input.borehole, 'm'), daily(input.quality, 'PH'), daily(input.pressure, 'MPa'), input.thresholds, input.distance)
    assert.deepEqual(result.map(item => item.level), sample.levels)
    assert.deepEqual(result.map(item => item.basis), sample.basis)
  }
  const keys = ['water_inflow', 'aquifer_water_level', 'water_quality', 'structure_distance', 'water_pressure'] as const
  for (const sample of reference.comprehensive) {
    const dynamic: Dynamic[] = keys.map((key, i) => ({ key, name: '', value: 0, unit: '', level: sample.dynamic[i], basis: '', description: '' }))
    const result = comprehensiveWarning('85211', sample.static, dynamic)
    assert.equal(result.warning, sample.warning)
    assert.deepEqual(result.analysis, sample.analysis)
  }
  assert.equal(round(0.5), 0)
  assert.equal(round(1.5), 2)
  assert.equal(round(2.5), 2)
  assert.equal(round(-2.5), -2)
  assert.equal(round(2.675, 2), 2.67)
})

const nodes: Node[] = [[1,100,100,10,0],[2,200,100,8,0],[3,300,100,6,1],[4,200,200,9,0],[5,300,200,9,1]].map(([id,x,y,z,exit]) => ({id,x,y,z,name:`节点${id}`,exit:Boolean(exit)}))
const roadways: Roadway[] = [[11,1,2,0],[12,2,3,0],[13,2,4,0],[14,4,5,1]].map(([id,start,end,closed]) => ({id,start,end,closed,width:3,height:2,name:`巷道${id}`}))
const people: Person[] = [{id:1,name:'甲',x:110,y:100,z:10},{id:2,name:'乙',x:290,y:200,z:9}]

test('50米网格、水淹时刻、路线与撤离时间对照原 Python', async () => {
  const mesh = await generateMesh(nodes, roadways, signal())
  assert.ok(mesh.segments.every(segment => segment.length <= 50 + 1e-9))
  const entries = await flooding(mesh, 1, .5, signal())
  for (const expected of reference.simulations) {
    const states = submerge(mesh, entries, expected.time)
    assert.deepEqual(Object.fromEntries([...states].map(([id, state]) => [id, { type: state.type, fraction: state.fraction }])), expected.states)
    const routes = await escapeRoutes(mesh, states, people, nodes, signal())
    routes.forEach((route, i) => {
      const expectedRoute = expected.routes[i]
      assert.equal(route.status, expectedRoute.status)
      assert.deepEqual(route.route, expectedRoute.route)
      close(route.distance, expectedRoute.distance)
      close(route.estimated, expectedRoute.estimated_time)
    })
  }
})

test('无出口、全淹阻断和抽样不会编造可用路线或扩展人员范围', async () => {
  const mesh = await generateMesh(nodes, roadways, signal())
  const noExits = await escapeRoutes(mesh, new Map(), people, nodes.map(node => ({...node,exit:false})), signal())
  assert.ok(noExits.every(route => route.status === '被困' && !route.route.length))
  const blocked = new Map(roadways.map(roadway => [roadway.id, {type:2,fraction:1,status:'全淹' as const}]))
  assert.equal((await escapeRoutes(mesh, blocked, [people[0]], nodes, signal()))[0].status, '被困')
  const pool = Array.from({length:25},(_,i)=>({...people[0],id:i}))
  const sample = samplePersonnel(pool, () => .5)
  assert.equal(sample.length, 10)
  assert.equal(new Set(sample.map(person => person.id)).size, 10)
  assert.equal(pool.length, 25)
})

test('周期覆盖率、日内极值、日末趋势、前兆与水量响应对照原 Python', () => {
  const records = reference.review.records.map(row => ({ date:row.date,value:row.value,metric:row.metric_name,source:row.source_name,sensor:row.sensor_name,unit:row.unit,scope:row.监测范围 }))
  const actual = reviewStatistics(records, '2026-08-01', '2026-08-10')
  assert.deepEqual(actual.quality, reference.review.quality)
  assert.deepEqual(actual.statistics, reference.review.statistics)
  assert.deepEqual(actual.precursors, reference.review.precursors)
  assert.deepEqual(actual.response, [reference.review.response])
  assert.equal(actual.statistics.find(row => row.指标 === '涌水量')!.最大值, 150)
})

test('本地检索保留来源、标签、地点及空命中，重点表格来自文档原字段', () => {
  assert.equal(searchDocuments('zzzzzz', 5, ['水害分析预报表']).length, 0)
  assert.equal(searchDocuments('85220工作面 水害', 5, ['水害分析预报表'], '99999').length, 0)
  const documents = searchDocuments('85220工作面 水害', 5, ['水害分析预报表'], '85220')
  assert.ok(documents.length > 0)
  assert.ok(documents.every(doc => doc.tags.includes('水害分析预报表') && !doc.source.includes('/')))
  const result = reportSummary('水害分析预报表')
  assert.equal(result.tables.length, 2)
  assert.ok(result.tables.some(table => table.rows.length > 0))
  assert.match(result.summary, /2026年5月/)
  assert.deepEqual(result.tables[0].columns, ['水害类型','预计时间','预计地点','水害评估','处理建议'])
  assert.throws(() => reportSummary(''), /query/)
  assert.throws(() => reportSummary('水害', 101), /n_chunks/)
})

test('运行期长计算支持在途取消', async () => {
  const controller = new AbortController()
  const run = staticAnalysis('85211', controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(run, /abort/i)
})
