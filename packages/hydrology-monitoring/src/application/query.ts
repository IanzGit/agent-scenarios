/** 查询预检、Cube 请求转换与明细响应归一化。 */
import { CubeClient } from '../infrastructure/cube-client.ts'
import { isObject } from '../domain/catalog.ts'
import { validateQuery } from '../domain/query-validation.ts'
import { QueryError, type SemanticQuery, type QueryRecord } from '../domain/protocol.ts'

/** 转换为 Cube REST 查询；不执行 /sql 返回的 SQL 文本。 */
export function cubeQuery(query: SemanticQuery, timezone: string): object {
  return { measures: [], dimensions: query.dimensions, segments: query.segments, filters: query.filters,
    timeDimensions: query.time_dimensions.map(item => ({ dimension: item.dimension, ...(item.date_range ? { dateRange: item.date_range } : {}) })),
    order: Object.fromEntries(query.order.map(item => [item.member, item.direction])),
    ...(query.limit === null ? {} : { limit: query.limit }), offset: query.offset, ungrouped: true, timezone }
}

/** 以目录声明的列顺序和类型保存全量明细；不会将非法响应当成空数据。 */
export async function runQuery(client: CubeClient, input: unknown, goal: string, signal: AbortSignal): Promise<QueryRecord> {
  const catalog = await client.catalog(signal)
  const query = validateQuery(input, catalog)
  const wire = cubeQuery(query, client.settings.timezone)
  await client.query('/sql', wire, signal)
  let payload = await client.query('/load', wire, signal)
  if (Array.isArray(payload.results)) {
    if (payload.results.length !== 1 || !isObject(payload.results[0])) throw new QueryError('Cube 单查询响应结果数量无效。', 'cube_invalid_response', '/load')
    payload = payload.results[0]
  }
  if (!Array.isArray(payload.data) || payload.data.some(row => !isObject(row))) throw new QueryError('Cube /load 缺少有效 data 行集。', 'cube_invalid_response', '/load')
  const names = [...new Set([...query.dimensions, ...query.time_dimensions.map(item => item.dimension)])]
  const columns = names.map(name => {
    const field = catalog.get(name.slice(0, name.indexOf('.')))!.members.get(name)!
    return { name, title: field.title, data_type: field.type }
  })
  const rows = payload.data.map(raw => {
    const row = raw as Record<string, unknown>
    return Object.fromEntries(columns.map(column => {
      const value = row[column.name]
      if (value === undefined) throw new QueryError(`Cube 返回记录缺少所选字段 ${column.name}。`, 'cube_invalid_response', '/load')
      if (value === null) return [column.name, null]
      if (column.data_type === 'number') {
        if (value === '') return [column.name, null]
        const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
        if (!Number.isFinite(number)) throw new QueryError('Cube 数值字段返回非数值内容。', 'cube_invalid_response', '/load')
        return [column.name, number]
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new QueryError('Cube 明细包含非标量字段。', 'cube_invalid_response', '/load')
      return [column.name, typeof value === 'boolean' ? (value ? '1' : '0') : value]
    }))
  })
  return { version: 1, outcome: rows.length ? 'success' : 'no_data', terminal: true, query_goal: goal,
    semantic_query: query, row_count: rows.length, columns, rows }
}
