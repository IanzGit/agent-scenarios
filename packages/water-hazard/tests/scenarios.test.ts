import test from 'node:test'
import assert from 'node:assert/strict'
import { scenarioFixture, mockBusiness } from '../../../tests/fixtures/water-hazard.ts'
import { locationWorkface } from '../src/services/workfaces.ts'
import { roofWarning } from '../src/services/roof.ts'
import { hydrologicalReview } from '../src/services/review.ts'
import { inrushSimulation } from '../src/services/simulation.ts'
import { EXTRA_SENSORS } from '../src/services/history.ts'

const signal = () => new AbortController().signal

test('工作面从接口取交集，当前工作面沿用盘区映射，指定未知编号不替换', async () => {
  const { api, requests } = scenarioFixture()
  const result = await locationWorkface(api, signal())
  assert.deepEqual(result.workfaces, ['45208', '85211'])
  assert.equal(result.current_workface, '85211')
  await assert.rejects(inrushSimulation(api, signal(), '99999'), /99999.*45208.*85211/)
  assert.ok(!requests.some(request => request.path.endsWith('getLastGeologyInfo.action')))
})

test('顶板完整链路生成三图、五项动态、八项综合且保留超过31天的显式周期', async () => {
  const { api, requests } = scenarioFixture()
  const { value, documents } = await roofWarning(api, signal(), '85211', '2026-07-01', '2026-08-30')
  assert.ok(value.stages.every(stage => stage.status === '成功'), JSON.stringify(value.stages))
  assert.deepEqual(value.period, {start:'2026-07-01',end:'2026-08-30'})
  assert.equal(value.tables.find(table => table.title === '监测动态指标状态表')!.rows.length, 5)
  assert.equal(value.tables.find(table => table.title === '综合指标等级与判断依据明细表')!.rows.length, 8)
  assert.equal(documents.length, 1)
  assert.equal((documents[0].html.match(/class="map-card"/g) ?? []).length, 3)
  assert.equal((documents[0].html.match(/class="legend"/g) ?? []).length, 3)
  assert.match(documents[0].html, /Content-Security-Policy/)
  assert.match(documents[0].html, /chart-document:height/)
  const history = requests.filter(request => request.path.endsWith('getSensorChartData.action'))
  assert.equal(history.length, 4)
  assert.equal(history.filter(request => request.form.get('sensorId') === EXTRA_SENSORS.pressure).length, 1)
})

test('日期错误、有效记录不足及停用阈值时保留静态三图，跳过综合判定', async () => {
  const { api } = scenarioFixture()
  for (const [start,end] of [['invalid','2026-08-30'],['2026-08-30','2026-08-01'],['',''],['2026-08-01','2026-08-06']]) {
    const { value, documents } = await roofWarning(api, signal(), '85211', start, end)
    assert.deepEqual(value.stages.map(stage => stage.status), ['成功','失败','未执行'])
    assert.equal(documents.length, 1)
    assert.ok(!value.tables.some(table => table.title === '综合指标分析结果表'))
  }
  const original = scenarioFixture()
  const changed = mockBusiness(request => request.path.endsWith('getSingleData.action') ? [{singleId:EXTRA_SENSORS.pressure,isOpenWarn:0}] : original.fetcher(`http://fixture${request.path}`,request.init))
  const { value } = await roofWarning(changed.api, signal(), '85211', '2026-08-01','2026-08-30')
  assert.match(value.stages[1].reason, /未启用/)
  assert.equal(value.stages[2].status, '未执行')
})

test('仿真同次完成两张SVG HTML、全部状态表及抽样路线，底图使用原始JSON GET', async () => {
  const { api, requests } = scenarioFixture()
  const { value, documents } = await inrushSimulation(api, signal(), '85211')
  assert.equal(value.tables[0].rows.reduce((sum,row)=>sum+Number(row.巷道数量),0),2)
  assert.equal(value.tables[1].rows.length,2)
  assert.ok(value.tables[1].rows.every(row=>row.状态==='可撤离'))
  assert.equal(documents.length,2)
  assert.match(documents[0].html, /animation-data/)
  const frames = JSON.parse(documents[0].html.match(/<script id="animation-data" type="application\/json">(.*?)<\/script>/s)![1]).frames as {time:number}[]
  assert.equal(frames.length,12)
  assert.equal(frames.at(-1)!.time,86400)
  assert.match(documents[1].html,/class="escape-route"/)
  assert.ok(requests.some(request=>request.path.endsWith('/js/dxf/fixture.json')&&request.init?.method==='GET'))
  assert.match(value.summary,/最多随机抽取10人/)
  assert.deepEqual(JSON.parse(JSON.stringify(value)),value)
  for(const rate of [0,-1,Infinity,NaN]) await assert.rejects(inrushSimulation(api,signal(),'85211',rate),/inrush_rate/)
  await assert.rejects(inrushSimulation(api,signal(),'85211',1800,0),/simulation_time/)
})

test('无巷道、底图路径异常、定位缺失和主接口失败不会伪造仿真', async () => {
  for(const failure of ['getAllRoadwayData.action','getBasemapJs.action','getLastGeologyInfo.action']) {
    const original=scenarioFixture()
    const fixture=mockBusiness(request=>request.path.endsWith(failure)
      ? failure==='getAllRoadwayData.action'?{totalSize:0,resultData:[]}:failure==='getBasemapJs.action'?{平面底图:'https://elsewhere/example'}:[]
      :original.fetcher(`http://fixture${request.path}`,request.init))
    await assert.rejects(inrushSimulation(fixture.api,signal(),'85211'))
  }
})

test('复盘六项指标有真实范围和单位，长周期不被截断，失败与空数据不作零值', async () => {
  const { api,requests }=scenarioFixture()
  const review=await hydrologicalReview(api,signal(),'85211','2026-07-01','2026-08-30')
  assert.deepEqual(review.period,{start:'2026-07-01',end:'2026-08-30'})
  assert.equal(review.tables[0].rows.length,6)
  assert.equal(review.tables[0].rows.find(row=>row.指标==='密闭水压')!.监测范围,'邻近85209工作面')
  assert.ok(review.tables[0].rows.every(row=>row.周期应有样本数===61))
  assert.equal(requests.filter(request=>request.path.endsWith('getSensorChartData.action')).length,6)
  assert.match(review.summary,/统计拟合，不代表因果/)
  await assert.rejects(hydrologicalReview(api,signal(),'85211','','2026-08-30'),/同时传入/)
  const noData=mockBusiness(({path})=>path.endsWith('getSingleList.action')?{totalSize:1,resultData:[{name:'85211回采最近积水区距离'}]}:{data:[],unit:''})
  await assert.rejects(hydrologicalReview(noData.api,signal(),'85211'),/无有效水文/)
})
