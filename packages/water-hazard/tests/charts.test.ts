import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceDatasets } from '../src/services/devices.ts'
import { warningDatasets } from '../src/services/warnings.ts'
import { trendDatasets } from '../src/services/trends.ts'
import { scenarioFixture } from '../../../tests/fixtures/water-hazard.ts'

test('水害适配器排除合计、跨区域汇总；统计和四项趋势忠实复用业务结果', async () => {
  const { business } = scenarioFixture()
  const signal = new AbortController().signal
  const devices = await business.deviceStatus(signal)
  const types = deviceDatasets(devices)[0]
  assert.equal(types.rows.reduce((sum, row) => sum + Number(row.value), 0), devices.tables[0].rows.at(-1)!.设备数量)
  assert.ok(types.rows.every(row => row.category !== '合计'))
  const warnings = await business.warningStatistics(signal)
  assert.deepEqual(warningDatasets(warnings).map(item => item.rows.map(row => row.value)), warnings.tables.map(item => item.rows.map(row => row.事件数量)))
  const trend = await business.hydrologicalTrend(signal)
  const datasets = trendDatasets(trend)
  assert.deepEqual(datasets.map(item => item.id), ['inflow', 'drainage', 'borehole', 'sump'])
  assert.deepEqual(datasets[0].rows, trend.series[0].points)
})

