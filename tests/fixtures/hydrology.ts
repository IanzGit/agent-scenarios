/** 本地 Cube 语义目录和明细响应，无数据库或模型密钥依赖。 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { SemanticQuery } from '../../packages/hydrology-monitoring/src/domain/protocol.ts'

export const HISTORY = 'view_historical_trend_analysis'
export const REALTIME = 'view_realtime_monitoring_analysis'
export const EVENTS = 'view_exception_event_analysis'
const columns = ['point_name', 'value', 'point_unit', 'observed_at', 'value_type_name', 'value_status_name', 'device_status_name', 'address_name', 'subsystem_name', 'mine_name', 'point_name_code']
const titles: Record<string, string> = { point_name: '监测点', value: '监测值', current_value: '当前值', point_unit: '单位', observed_at: '监测时间', value_type_name: '监测类型', value_status_name: '监测状态', device_status_name: '设备状态', address_name: '地点', subsystem_name: '系统', mine_name: '煤矿', point_name_code: '名称及编码', started_at: '开始时间', ended_at: '结束时间' }
export function cubeMeta() {
  return { cubes: [HISTORY, REALTIME, EVENTS].map(name => {
    const projection = name === REALTIME ? columns.map(column => column === 'value' ? 'current_value' : column)
      : name === EVENTS ? ['point_name', 'value_type_name', 'value_status_name', 'device_status_name', 'started_at', 'ended_at', 'address_name', 'subsystem_name', 'mine_name', 'point_name_code'] : columns
    return { name, type: 'view', title: name, connectedComponent: 1,
      meta: { default_projection: projection, ai_context: 'value_type_name仅用于展示，液位按value_type_id=12001精确过滤。' },
      dimensions: [...projection, 'value_type_id', 'point_active_state'].map(column => ({ name: `${name}.${column}`, shortTitle: titles[column] ?? column,
        type: ['value', 'current_value'].includes(column) ? 'number' : ['observed_at', 'started_at', 'ended_at'].includes(column) ? 'time' : 'string' })),
      measures: [{ name: `${name}.count`, type: 'number' }], segments: [],
    }
  }) }
}

export function queryFor(model = HISTORY): SemanticQuery {
  return { query_mode: 'view', models: [model], measures: [], dimensions: [], segments: [], filters: [],
    time_dimensions: [], order: [], limit: null, offset: 0, ungrouped: true }
}

export type CubeFixtureOptions = { status?: number; continueWait?: number; invalid?: boolean; empty?: boolean; delay?: number; failModel?: string; rowCount?: number; failLoads?: number; responseGate?: Promise<void> }
export async function startCubeFixture(options: CubeFixtureOptions = {}) {
  const requests: { path: string; query?: Record<string, unknown>; authorization?: string }[] = []
  let waits = 0
  let failedLoads = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { query: Record<string, unknown> } : undefined
    const path = request.url?.split('/').at(-1) ?? ''
    requests.push({ path, query: body?.query, authorization: request.headers.authorization })
    if (options.responseGate) await options.responseGate
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay))
    const failure = options.failModel && Array.isArray(body?.query.dimensions) && body.query.dimensions.some(name => String(name).startsWith(`${options.failModel}.`))
    const transient = path === 'load' && failedLoads < (options.failLoads ?? 0)
    if (transient) failedLoads++
    response.writeHead(failure ? 401 : transient ? 503 : options.status ?? 200, { 'Content-Type': 'application/json' })
    if (transient) { response.end(JSON.stringify({ error: 'temporarily unavailable' })); return }
    if (failure) { response.end(JSON.stringify({ error: 'unauthorized' })); return }
    if (options.invalid) { response.end('invalid JSON'); return }
    if (path === 'meta') { response.end(JSON.stringify(cubeMeta())); return }
    if (waits++ < (options.continueWait ?? 0)) { response.end(JSON.stringify({ error: 'Continue wait' })); return }
    if (path === 'sql') { response.end(JSON.stringify({ sql: { sql: ['SELECT governed_members', []] } })); return }
    const names = body?.query.dimensions as string[]
    const model = names[0].split('.')[0]
    const values = options.rowCount === undefined ? model === HISTORY ? [1.234567, 0, null, 4] : [1.234567, 2]
      : Array.from({ length: options.rowCount }, (_, index) => index % 7 === 0 ? null : index / 100)
    const data = options.empty ? [] : values.map((value, index) => {
      const row: Record<string, string | number | null> = { point_name: '主斜井水位', value, current_value: value, point_unit: index === 3 ? 'cm' : 'm', observed_at: `2025-09-01T0${index < 2 ? 0 : index}:00:00+08:00`, value_type_name: '液位', value_status_name: index === 1 ? '报警' : '正常', device_status_name: '正常', address_name: '130608工作面', subsystem_name: '水文监测', mine_name: '麦垛山煤矿', point_name_code: `主斜井水位（${model === HISTORY ? 'P1' : `P${index + 1}`}）`, started_at: '2025-09-15T01:00:00+08:00', ended_at: index ? null : '2025-09-15T03:00:00+08:00' }
      if (options.rowCount !== undefined) { row.point_unit = 'm'; row.observed_at = new Date(Date.UTC(2025, 8, 1, 0, 0, index * 30)).toISOString() }
      return Object.fromEntries(names.map(name => [name, row[name.split('.')[1]] ?? null]))
    })
    response.end(JSON.stringify({ data }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Cube fixture 未监听 TCP')
  return { url: `http://127.0.0.1:${address.port}`, options, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
