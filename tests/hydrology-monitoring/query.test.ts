import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { parse } from 'yaml'
import { CubeClient, parseCatalog } from '../../src/scenarios/hydrology-monitoring/client.ts'
import { resolveSettings } from '../../src/scenarios/hydrology-monitoring/config.ts'
import { runQuery, validateQuery } from '../../src/scenarios/hydrology-monitoring/query.ts'
import { errorRecord, parseRecord } from '../../src/scenarios/hydrology-monitoring/protocol.ts'
import { presentQuery } from '../../src/scenarios/hydrology-monitoring/presentation.ts'
import { cubeMeta, HISTORY, REALTIME, EVENTS, queryFor, startCubeFixture } from '../fixtures/hydrology.ts'

const signal = () => new AbortController().signal

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

test('六个标准 skill 保留业务日期、完整查询步骤及逐项委派和图表要求', async () => {
  const root = new URL('../../skills/hydrology-monitoring/', import.meta.url)
  const names = await readdir(root)
  assert.equal(names.length, 6)
  for (const name of names) {
    const content = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8')
    const frontmatter = parse(content.split('---')[1]) as { name: string; description: string }
    assert.equal(frontmatter.name, name)
    assert.ok(frontmatter.description)
    assert.match(content, /每项必须调用 query_hydrology/)
    assert.match(content, /最终展示轮/)
    assert.match(content, /\[图表:真实chart_id\]/)
    const taskRows = content.split('## 查询步骤与业务口径')[1].split('## 报告分析')[0].split('\n').filter(line => /^\| \d/.test(line))
    const expected = name === 'mine-hydrology-analysis' || name === 'workface-hydrology-analysis' ? 6 : name === 'hydrology-mine-realtime-overview' || name === 'hydrology-single-point-recent' ? 3 : 4
    assert.equal(taskRows.length, expected)
    assert.ok(taskRows.every(line => line.split('|').length === 5 && line.includes('query_hydrology → get_hydrology_query_result')))
    if (name !== 'hydrology-mine-realtime-overview') assert.match(content, /2025 年 9 月/)
  }
})
