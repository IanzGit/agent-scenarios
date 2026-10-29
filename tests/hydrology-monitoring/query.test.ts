import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { parse } from 'yaml'
import { CubeClient, parseCatalog } from '../../src/scenarios/hydrology-monitoring/client.ts'
import { resolveSettings } from '../../src/scenarios/hydrology-monitoring/config.ts'
import { runQuery, validateQuery } from '../../src/scenarios/hydrology-monitoring/query.ts'
import { errorRecord, parseRecord } from '../../src/scenarios/hydrology-monitoring/protocol.ts'
import { presentQuery } from '../../src/scenarios/hydrology-monitoring/presentation.ts'
import { renderChartResult } from '../../src/shared/chart-result.ts'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { semanticQuerySchema } from '../../src/scenarios/hydrology-monitoring/protocol.ts'
import { cubeMeta, HISTORY, REALTIME, EVENTS, queryFor, startCubeFixture } from '../fixtures/hydrology.ts'

const signal = () => new AbortController().signal

test('真实失败参数在模型可见 Schema 阶段拒绝字段简写、聚合粒度及字符串化查询', () => {
  for (const query of [
    { ...queryFor(), filters: [{ [`${HISTORY}.point_name`]: ['主水平水仓入口明渠（东）流量水流量'] }] },
    { ...queryFor(), filters: [{ or: [{ [`${HISTORY}.point_name`]: ['主斜井水位'] }] }] },
    { ...queryFor(), filters: [{ member: `${HISTORY}.point_name`, operator: 'equals' }] },
    { ...queryFor(), time_dimensions: [{ dimension: `${HISTORY}.observed_at`, date_range: ['2025-09-01', '2025-09-07'], granularity: 'day' }] },
    JSON.stringify(queryFor()),
  ]) assert.ok(validateArgs({ semantic_query: { ...semanticQuerySchema, required: true } }, { semantic_query: query }).length > 0)
})

test('测点部署 View 按唯一测点统计，生成类型分布饼图的数据集', () => {
  const model = 'view_point_deployment_analysis'
  const record = { version: 1 as const, outcome: 'success' as const, terminal: true, query_goal: '全矿测点类型分布', row_count: 194,
    columns: ['point_name_code', 'point_name', 'value_type_name', 'device_name'].map(name => ({ name: `${model}.${name}`, title: name, data_type: 'string' })),
    rows: Array.from({ length: 194 }, (_, index) => ({ [`${model}.point_name_code`]: `P${index % 193}`, [`${model}.point_name`]: `测点${index % 193}`, [`${model}.value_type_name`]: index % 193 < 100 ? '液位' : '水流量', [`${model}.device_name`]: '设备说明'.repeat(100) })) }
  const presented = presentQuery(record)
  assert.deepEqual(presented.datasets.find(dataset => dataset.id === 'point_types')?.rows, [{ category: '液位', count: 100 }, { category: '水流量', count: 93 }])
  assert.equal(presented.value.tables[0].rows.length, 50)
  const modelText = renderChartResult({}, presented.value).map(block => block.text).join('')
  assert.match(modelText, /明细共 194 行，正文仅展示前 50 行，完整数据已保留在查询结果文件中/)
  assert.match(modelText, /监测类型数量/)
  assert.match(modelText, /去重数量：193/)
  assert.match(modelText, /设备说明/)
})

test('完整目录固定 View 投影，只接受公开成员和受治理明细查询', () => {
  const meta = cubeMeta()
  const catalog = parseCatalog(meta)
  assert.equal(validateQuery(queryFor(), catalog).dimensions.length, 11)
  for (const change of [
    { models: [HISTORY, REALTIME] }, { query_mode: 'cube' }, { models: ['unknown'] },
    { measures: [`${HISTORY}.count`] }, { ungrouped: false }, { offset: -1 }, { limit: 0 },
    { filters: [{ member: `${HISTORY}.unknown`, operator: 'equals', values: ['x'] }] },
    { filters: [{ member: `${HISTORY}.count`, operator: 'gt', values: [1] }] },
    { filters: [{ member: `${HISTORY}.value_type_name`, operator: 'equals', values: ['液位'] }] },
    { filters: [{ member: `${HISTORY}.value_type_name`, operator: 'set' }] },
    { filters: [{ member: `${HISTORY}.point_name`, operator: 'set', values: [] }] },
    { filters: [{ or: [{ and: [{ or: [{ member: `${HISTORY}.point_name`, operator: 'set' }] }] }] }] },
  ]) assert.throws(() => validateQuery({ ...queryFor(), ...change }, catalog))
  assert.doesNotThrow(() => validateQuery({ ...queryFor(), filters: [{ member: `${HISTORY}.value_type_id`, operator: 'equals', values: ['12001'] }] }, catalog))
  meta.cubes[0].meta.default_projection.push('not_public')
  assert.throws(() => parseCatalog(meta), /default_projection/)
})

test('Cube 连通性、多个候选对象和日报左闭右开边界经过本地校验', () => {
  const meta = cubeMeta()
  const catalog = parseCatalog({ cubes: meta.cubes.map((model, index) => ({ ...model, type: 'cube', connectedComponent: index < 2 ? 1 : 2 })) })
  const cube = { ...queryFor(), query_mode: 'cube', dimensions: [`${HISTORY}.point_name`] }
  assert.doesNotThrow(() => validateQuery({ ...cube, models: [HISTORY, REALTIME] }, catalog))
  assert.throws(() => validateQuery({ ...cube, models: [HISTORY, EVENTS] }, catalog), /连接组件/)
  assert.throws(() => validateQuery({ ...cube, filters: ['A', 'B'].map(value => ({ member: `${HISTORY}.point_name`, operator: 'equals', values: [value] })) }, catalog), /or 组/)
  assert.doesNotThrow(() => validateQuery({ ...cube, filters: [{ or: ['A', 'B'].map(value => ({ member: `${HISTORY}.point_name`, operator: 'equals', values: [value] })) }] }, catalog))
  const filters = [{ member: `${HISTORY}.observed_at`, operator: 'gte', values: ['2025-09-15T00:00:00+08:00'] }, { member: `${HISTORY}.observed_at`, operator: 'lt', values: ['2025-09-16T00:00:00+08:00'] }]
  assert.deepEqual(validateQuery({ ...cube, filters }, catalog).filters, filters)
  assert.throws(() => validateQuery({ ...cube, time_dimensions: [{ dimension: `${HISTORY}.observed_at`, date_range: ['2025-02-30', '2025-03-01'] }] }, catalog), /自然日/)
})

test('先编译再取数，保留全量重复点、零和空值；按单位绘图和确定性统计', async () => {
  const fixture = await startCubeFixture({ continueWait: 1 })
  try {
    const client = new CubeClient(resolveSettings({ cubeUrl: fixture.url, cubeToken: 'test-token', continueWaitDelaySeconds: 0 }))
    const record = await runQuery(client, queryFor(), '查询主斜井水位历史趋势', signal())
    assert.equal(record.row_count, 4)
    assert.equal(record.rows[0][`${HISTORY}.value`], 1.234567)
    assert.deepEqual(fixture.requests.map(request => request.path), ['meta', 'sql', 'sql', 'load'])
    assert.ok(fixture.requests.every(request => request.authorization === 'test-token'))
    assert.equal(fixture.requests.at(-1)?.query?.limit, undefined)
    const presented = presentQuery(record)
    assert.equal(presented.datasets.length, 2)
    const meters = presented.datasets.find(dataset => dataset.columns.find(column => column.name === 'value')?.unit === 'm')!
    assert.deepEqual(meters.rows.map(row => row.value), [1.234567, 0, null])
    assert.equal(meters.rows[0].time, meters.rows[1].time)
    assert.ok(presented.datasets.every(dataset => dataset.id.startsWith('history_')))
    assert.equal(presented.value.tables[1].rows[0].均值, 1.234567 / 2)
    assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(record))), record)
    assert.throws(() => parseRecord({ ...record, row_count: 99 }), /行数/)
    assert.throws(() => parseRecord({ ...record, version: 2 }), /格式/)
  } finally { await fixture.close() }
})

test('实时分布按测点去重，事件持续情况只按真实起止时间计算', async () => {
  const fixture = await startCubeFixture()
  try {
    const client = new CubeClient(resolveSettings({ cubeUrl: fixture.url }))
    const real = await runQuery(client, queryFor(REALTIME), '实时状态', signal())
    real.rows.push(structuredClone(real.rows[0])); real.row_count++
    const presented = presentQuery(real)
    assert.deepEqual(presented.datasets.find(dataset => dataset.id === 'point_types')?.rows, [{ category: '液位', count: 2 }])
    const events = presentQuery(await runQuery(client, queryFor(EVENTS), '预警报警', signal()))
    assert.equal(events.datasets.length, 0)
    assert.deepEqual(events.value.tables[0].rows.map(row => row['持续时间（小时）']), [2, '未结束'])
  } finally { await fixture.close() }
})

test('历史明细按查询返回的降序截取，图表仍完整按时间排序', async () => {
  const fixture = await startCubeFixture({ rowCount: 51 })
  try {
    const client = new CubeClient(resolveSettings({ cubeUrl: fixture.url }))
    const record = await runQuery(client, { ...queryFor(), order: [{ member: `${HISTORY}.observed_at`, direction: 'desc' }] }, '最近历史', signal())
    // 本地 Cube fixture 不执行排序，在展示边界模拟查询返回的降序行集。
    record.rows.reverse()
    const original = structuredClone(record.rows)
    const presented = presentQuery(record)
    const times = presented.value.tables[0].rows.map(row => row['监测时间'])
    assert.deepEqual(times, original.slice(0, 50).map(row => row[`${HISTORY}.observed_at`]))
    assert.equal(times[0], '2025-09-01T00:25:00.000Z')
    assert.equal(times.at(-1), '2025-09-01T00:00:30.000Z')
    assert.deepEqual(record.rows, original)
    assert.equal(presented.datasets[0].rows.length, 51)
    assert.equal(presented.datasets[0].rows[0].time, '2025-09-01T00:00:00.000Z')
  } finally { await fixture.close() }
})

for (const rowCount of [50, 51]) test(`异常事件${rowCount}行统一截断并保留持续时间`, async () => {
  const fixture = await startCubeFixture({ rowCount })
  try {
    const client = new CubeClient(resolveSettings({ cubeUrl: fixture.url }))
    const record = await runQuery(client, queryFor(EVENTS), '异常事件', signal())
    const presented = presentQuery(record)
    assert.equal(presented.value.tables[0].rows.length, 50)
    assert.equal(presented.value.tables[0].rows[0]['持续时间（小时）'], 2)
    assert.equal(presented.value.tables[0].rows.at(-1)?.['持续时间（小时）'], '未结束')
    assert.equal(record.rows.length, rowCount)
    assert.equal(presented.datasets.length, 0)
    const modelText = renderChartResult({}, presented.value).map(block => block.text).join('')
    assert.equal(modelText.split('\n').filter(line => line.startsWith('|')).length, 52)
    if (rowCount > 50) assert.match(modelText, /明细共 51 行，正文仅展示前 50 行，完整数据已保留在查询结果文件中/)
    else assert.doesNotMatch(modelText, /正文仅展示前/)
  } finally { await fixture.close() }
})

test('无数据、认证、坏响应、Continue wait 耗尽、超时和取消保持不同结果', async () => {
  for (const [options, code] of [[{ empty: true }, null], [{ status: 401 }, 'cube_auth_error'], [{ invalid: true }, 'cube_invalid_response'], [{ continueWait: 9 }, 'cube_continue_wait_exhausted'], [{ delay: 80 }, 'cube_timeout']] as const) {
    const fixture = await startCubeFixture(options)
    try {
      const client = new CubeClient(resolveSettings({ cubeUrl: fixture.url, timeoutSeconds: options.delay ? 0.01 : 2, continueWaitRetries: 1, continueWaitDelaySeconds: 0 }))
      if (!code) assert.equal((await runQuery(client, queryFor(), '查询', signal())).outcome, 'no_data')
      else await assert.rejects(runQuery(client, queryFor(), '查询', signal()), error => errorRecord(error, '查询').error?.code === code)
      const cancelled = new AbortController(); cancelled.abort()
      await assert.rejects(runQuery(client, queryFor(), '查询', cancelled.signal), { name: 'AbortError' })
    } finally { await fixture.close() }
  }
  assert.throws(() => resolveSettings({ timeoutSeconds: 0 }))
  assert.throws(() => resolveSettings({ timezone: 'not-a-timezone' }))
})

test('六个标准 skill 保留业务日期和查询步骤，统一提交父任务并发布报告', async () => {
  const root = new URL('../../skills/hydrology-monitoring/', import.meta.url)
  const names = await readdir(root)
  assert.equal(names.length, 6)
  for (const name of names) {
    const content = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8')
    const frontmatter = parse(content.split('---')[1]) as { name: string; description: string }
    assert.equal(frontmatter.name, name)
    assert.ok(frontmatter.description)
    assert.match(content, /query_hydrology\(\{plan\}\)/)
    assert.match(content, /publish_hydrology_report/)
    assert.match(content, /hydrology-task-ready/)
    assert.match(content, /\[图表:真实chart_id\]/)
    const taskRows = content.split('## 查询步骤与业务口径')[1].split('## 报告分析')[0].split('\n').filter(line => /^\| \d/.test(line))
    const expected = name === 'mine-hydrology-analysis' || name === 'workface-hydrology-analysis' ? 6 : name === 'hydrology-mine-realtime-overview' || name === 'hydrology-single-point-recent' ? 3 : 4
    assert.equal(taskRows.length, expected)
    assert.ok(taskRows.every(line => line.split('|').length === 5 && line.includes('plan.queries 中一个查询')))
    if (name !== 'hydrology-mine-realtime-overview') assert.match(content, /2025 年 9 月/)
  }
})
