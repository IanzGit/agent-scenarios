import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSettings, dateValue } from '../../src/scenarios/water-hazard/config.ts'
import { resolvePeriod } from '../../src/scenarios/water-hazard/api.ts'
import { monitoringValue } from '../../src/scenarios/water-hazard/services/trends.ts'
import { event, mockBusiness, scenarioFixture, statistics } from '../fixtures/water-hazard.ts'

const signal = () => new AbortController().signal

test('日期使用配置参考日，显式范围严格校验并包含首尾', () => {
  const settings = resolveSettings({}, {})
  assert.deepEqual(resolvePeriod(settings), { start: '2026-08-03', end: '2026-09-01' })
  assert.deepEqual(resolvePeriod(settings, '2026-08-01', '2026-08-31'), { start: '2026-08-01', end: '2026-08-31' })
  assert.deepEqual(resolvePeriod(resolveSettings({}, { WATER_HAZARD_CONVERSATION_DATE: '2026-10-23' })), { start: '2026-09-24', end: '2026-10-23' })
  for (const [start, end] of [['2026-02-30', '2026-03-01'], ['2026-09-01', '2026-08-01'], ['2026-08-01', '2026-09-01'], ['', '2026-09-01']]) assert.throws(() => resolvePeriod(settings, start, end))
  assert.throws(() => dateValue('2026-2-01'))
  assert.throws(() => dateValue('0000-01-01'))
  assert.throws(() => resolveSettings({ apiMaxRetries: -1 }, {}))
})

test('分页必须完整，总数变化或空中间页明确失败', async () => {
  const { api, requests } = mockBusiness(({ form }) => ({ totalSize: '3', resultData: form.get('pageNumber') === '1' ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] }))
  assert.equal((await api.devices('按安装区域分', '井下设备', signal())).length, 3)
  assert.equal(requests[1].form.get('pageNumber'), '2')
  assert.equal(requests[0].form.get('isHide'), 'true')
  assert.equal(requests[0].form.has('pageSize'), false)
  for (const next of [{ totalSize: 4, resultData: [] }, { totalSize: 3, resultData: [] }, { totalSize: 1, resultData: [{ id: 3 }] }]) {
    const { api } = mockBusiness(({ form }) => form.get('pageNumber') === '1' ? { totalSize: 3, resultData: [{ id: 1 }] } : next)
    await assert.rejects(api.devices('a', 'b', signal()), /分页/)
  }
})

test('设备按两种分类关联并按设备和传感器去重，未知状态沿用离线计数', async () => {
  const devices = [
    { valueId: '1', deviceName: 'a', sensorName: 'x', alarmState: '正常' },
    { valueId: '1', deviceName: 'a', sensorName: 'x', alarmState: '正常' },
    { valueId: '2', deviceName: 'b', sensorName: 'y', alarmState: '' },
    { valueId: '3', deviceName: 'c', sensorName: 'z', alarmState: '正常' },
  ]
  const { business } = mockBusiness(({ form }) => {
    const child = form.get('labelChild')
    const items = child === '地表设备' ? devices : child === '流量' ? devices.slice(0, 3) : []
    return { totalSize: items.length, resultData: items }
  })
  const report = await business.deviceStatus(signal())
  assert.deepEqual(report.tables[0].rows.at(-1), { 设备区域: '合计', 设备类型: '', 设备数量: 2, 在线设备数量: 1, 离线设备数量: 1 })
})

test('事件 ID 去重、首尾日期包含、全部状态保留；四级阈值保留精度和零', async () => {
  const { business, requests } = mockBusiness(({ path }) => path.endsWith('getSingleData.action') ? [{ singleId: 'sensor', blueValue: '0', yellowValue: '5.7000', redValue: '5.9' }] : [
    event('start'), event('start'), event('end', { warnDate: '2026-09-01 23:59:59.999999', isPositive: '是', state: '未处置' }),
    event('before', { warnDate: '2026-08-02 23:59:59' }), event('after', { warnDate: '2026-09-02 00:00:00' }), event('model', { sourceType: 3 }),
  ])
  const report = await business.deviceAlarm(signal())
  assert.equal(report.tables[0].rows.length, 2)
  assert.equal(report.tables[0].rows[1].是否误报, '是')
  assert.equal(report.tables[0].rows[0].报警阈值, '0 / 5.7000 / 未取得 / 5.9')
  assert.match(report.summary, /已处置1条、未处置1条/)
  assert.deepEqual(report.tables[0].columns, ['预警指标', '当前预警等级', '预警时间', '是否误报', '处置状态', '报警阈值'])
  assert.equal(requests[0].form.get('labelName'), '')
  assert.equal(requests[0].form.has('pageNumber'), false)
})

test('补充配置失败保留事件；发布主接口失败及非法日期不转为空结果', async () => {
  const { business } = mockBusiness(({ path }) => path.endsWith('getSingleData.action') ? Response.json({ code: 400, msg: '配置不可用' }) : [event('kept')])
  assert.equal((await business.deviceAlarm(signal())).tables[0].rows[0].报警阈值, '未取得 / 未取得 / 未取得 / 未取得')
  const failed = mockBusiness(() => Response.json({ code: 401, msg: '主接口失败' }))
  await assert.rejects(failed.business.deviceAlarm(signal()), /主接口失败/)
  const invalid = mockBusiness(() => [event('bad', { warnDate: '2026-02-30 00:00:00' })])
  await assert.rejects(invalid.business.deviceAlarm(signal()), /日期/)
})

test('多因素配置和准则完整翻页，同一来源只描述一次，不返回权重或触发值', async () => {
  const { business, requests } = mockBusiness(({ path, form }) => {
    if (path.endsWith('sendMsgWarnHistory.action')) return [event('m1', { sourceType: 3 }), event('m2', { sourceType: '3', isPositive: '是' })]
    if (path.endsWith('getMultWarnList.action')) return { totalSize: 2, resultData: form.get('pageNumber') === '1' ? [{ multId: 'other', multName: '其他' }] : [{ multId: 'sensor', multName: '目标模型', warnModel: '模型准则' }] }
    return { totalSize: 2, resultData: form.get('pageNumber') === '1' ? [{ name: '涌水量', warnModelName: '方法A' }] : [{ name: '水位', warnModelName: '方法B' }] }
  })
  const report = await business.modelWarning(signal())
  assert.equal(report.tables[0].rows.length, 2)
  assert.equal(report.tables[0].rows[0].判识准则, '模型准则')
  assert.equal(report.summary.match(/基于涌水量采用方法A/g)?.length, 1)
  assert.match(report.summary, /基于水位采用方法B/)
  assert.equal(requests.filter(request => request.path.endsWith('getWarnNormList.action')).length, 2)
  assert.equal(report.tables[0].columns.includes('当前值'), false)
})

test('统计三张表来自相同数据，分类按优先级且缺事件日补零', async () => {
  const events = [event('a', { labelName: '排水量预警,涌水量预警' }), event('b', { riskLevel: '红色预警', warnDate: '2026-09-01 23:59:59', labelName: '多因素' })]
  const { business, requests } = mockBusiness(() => statistics(events))
  const report = await business.warningStatistics(signal())
  assert.match(report.summary, /共2条事件/)
  assert.equal(report.tables.length, 3)
  assert.ok(report.tables.every(table => table.chartOnly))
  const daily = report.tables[2].rows
  assert.ok(Array.isArray(daily))
  assert.equal(daily.length, 30)
  assert.deepEqual(daily[1], { 日期: '2026-08-04', 事件数量: 0 })
  assert.deepEqual(report.tables[0].rows[0], { 预警类型: '涌水量', 事件数量: 1 })
  assert.ok(report.tables.every(table => table.rows.reduce((total, row) => total + Number(row.事件数量), 0) === 2))
  assert.equal(requests[0].form.get('stopTime'), '2026-09-01 23:59:59')
})

test('统计数量不一致和越界事件报错；空统计不生成百分比', async () => {
  for (const data of [{ ...statistics([event('a')]), riskNum: 2 }, { ...statistics([event('a')]), red: 1 }, statistics([event('a', { warnDate: '2026-08-01 00:00:00' })])]) {
    await assert.rejects(mockBusiness(() => data).business.warningStatistics(signal()))
  }
  const report = await mockBusiness(() => statistics([])).business.warningStatistics(signal())
  assert.ok(report.tables.every(table => table.rows.every(row => row.事件数量 === 0)))
  assert.match(report.summary, /无预警统计事件/)
})

test('趋势保留原始精度、重复时间和断点，警告按测点和事件 ID 统计', async () => {
  const { api, business, requests } = mockBusiness(({ path, form }) => {
    if (path.endsWith('sendMsgWarnHistory.action')) return [event('a', { sourceId: api.settings.sensors.inflow }), event('a', { sourceId: api.settings.sensors.inflow }), event('b', { sourceId: api.settings.sensors.inflow, isPositive: '是' }), event('model', { sourceId: api.settings.sensors.inflow, sourceType: 3 })]
    if (path.endsWith('getSensorSSData.action')) return [{ valueId: api.settings.sensors.inflow, unit: 'm³/h' }]
    return form.get('sensorId') === api.settings.sensors.inflow ? { data: [
      { time: '2026-08-04 00:00:00', value: '3.54321' }, { time: '2026-08-03 00:00:00', value: 0 },
      { time: '2026-08-03 00:00:00', value: '1.23456' }, { time: '2026-08-05 00:00:00', value: 'NaN' },
    ] } : { unit: '', data: [] }
  })
  const report = await business.hydrologicalTrend(signal())
  assert.equal(report.series.length, 1)
  assert.deepEqual(report.series[0], { name: '涌水量', unit: 'm³/h', source: '矿井总涌水量', sensor: '涌水量', points: [
    { time: '2026-08-03 00:00:00', value: 0 },
    { time: '2026-08-03 00:00:00', value: 1.23456 },
    { time: '2026-08-04 00:00:00', value: 3.54321 },
    { time: '2026-08-05 00:00:00', value: null },
  ] })
  assert.equal(report.tables[0].rows[0].有效记录数, 3)
  assert.equal(report.tables[0].rows[0].最大值, 3.54321)
  assert.equal(report.tables[0].rows[0].预警次数, 2)
  assert.equal(report.tables[0].rows[1].预警次数, 0)
  assert.match(report.summary, /最大值3.54m³\/h/)
  assert.equal(requests.filter(request => request.path.endsWith('getSensorSSData.action')).length, 1)
})

test('缺单位不会丢弃历史；预警查询失败和全空趋势明确失败', async () => {
  const fixture = mockBusiness(({ path }) => {
    if (path.endsWith('getSensorChartData.action')) return { data: [{ time: '2026-08-03 00:00:00', value: 1 }] }
    if (path.endsWith('getSensorSSData.action')) return Response.json({ code: 403, msg: '单位不可用' })
    return []
  })
  assert.match((await fixture.business.hydrologicalTrend(signal())).summary, /单位未提供/)
  const noData = mockBusiness(() => ({ data: [{ time: '2026-08-03 00:00:00', value: null }] }))
  await assert.rejects(noData.business.hydrologicalTrend(signal()), /无有效水文/)
  const failed = mockBusiness(({ path }) => path.endsWith('getSensorChartData.action') ? { unit: 'm', data: [{ time: '2026-08-03 00:00:00', value: 1 }] } : Response.json({ code: 403, msg: '预警不可用' }))
  await assert.rejects(failed.business.hydrologicalTrend(signal()), /预警不可用/)
  assert.equal(monitoringValue(''), null)
  assert.equal(monitoringValue('Infinity'), null)
  assert.equal(monitoringValue(0), 0)
  assert.equal(monitoringValue('-0'), 0)
  assert.equal(monitoringValue('0xFF'), null)
})

test('五类结果只保留一份表格，均可无损 JSON 序列化', async () => {
  const { business } = scenarioFixture()
  const reports = await Promise.all([business.deviceStatus(signal()), business.deviceAlarm(signal()), business.modelWarning(signal()), business.warningStatistics(signal()), business.hydrologicalTrend(signal())])
  for (const report of reports) {
    assert.equal('data' in report, false)
    assert.equal('charts' in report, false)
    assert.equal('version' in report, false)
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  }
})
