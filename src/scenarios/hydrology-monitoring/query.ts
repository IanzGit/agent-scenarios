/** SemanticQuery 本地校验、Cube 请求转换与明细响应归一化。 */
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { CubeClient, isObject, type Catalog, type Member } from './client.ts'
import { QueryError, semanticQuerySchema, type SemanticQuery, type QueryRecord } from './protocol.ts'

const operators = new Set(['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith', 'gt', 'gte', 'lt', 'lte', 'set', 'notSet', 'inDateRange', 'notInDateRange', 'beforeDate', 'beforeOrOnDate', 'afterDate', 'afterOrOnDate'])
const dateOperators = new Set(['inDateRange', 'notInDateRange', 'beforeDate', 'beforeOrOnDate', 'afterDate', 'afterOrOnDate'])
function invalid(message: string, code = 'invalid_query'): never { throw new QueryError(message, code, 'validation', true) }

/** 不接受目录之外的成员；View 的完整默认投影由工具固定。 */
export function validateQuery(input: unknown, catalog: Catalog): SemanticQuery {
  const issues = validateArgs({ query: { ...semanticQuerySchema, required: true } }, { query: input })
  if (issues.length) invalid(issues.join('；'), 'tool_input_validation')
  const query = structuredClone(input) as SemanticQuery
  const unique = (items: string[], label: string) => { if (new Set(items).size !== items.length) invalid(`${label} 不能重复。`) }
  unique(query.models, 'models')
  if (query.models.length < 1 || query.models.length > 4) invalid('必须选择 1～4 个公开模型。')
  const models = query.models.map(name => catalog.get(name) ?? invalid(`不存在公开模型 ${name}。`, 'unknown_model'))
  if (models.some(model => model.type !== query.query_mode)) invalid('禁止混用 View 和 Cube。')
  if (query.measures.length || !query.ungrouped) invalid('只支持 measures=[]、ungrouped=true 的明细查询。')
  if (query.query_mode === 'view') {
    if (models.length !== 1 || !models[0].defaultProjection.length) invalid('View 必须为一个模型且声明 default_projection。')
    query.dimensions = [...models[0].defaultProjection]
  } else if (models.length > 1 && (models[0].connectedComponent === undefined || models.some(model => model.connectedComponent !== models[0].connectedComponent))) invalid('Cube 必须属于同一连接组件。', 'join_unreachable')
  if (!query.dimensions.length && !query.time_dimensions.length) invalid('明细查询至少返回一个字段。')
  if (query.offset < 0 || (query.limit !== null && query.limit < 1)) invalid('offset 必须非负，limit 必须为空或正整数。')
  const member = (name: string, kind?: Member['kind']): Member => {
    const model = models.find(item => name.startsWith(`${item.name}.`))
    const found = model?.members.get(name)
    if (!found || (kind && found.kind !== kind)) invalid(`成员不存在、未公开或类型错误：${name}。`, 'unknown_member')
    return found
  }
  unique(query.dimensions, 'dimensions'); unique(query.segments, 'segments')
  unique(query.order.map(item => item.member), 'order'); unique(query.time_dimensions.map(item => item.dimension), 'time_dimensions')
  for (const name of query.dimensions) member(name, 'dimension')
  for (const name of query.segments) member(name, 'segment')
  const parseDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`无效日期：${value}。`)
    const date = value.slice(0, 10)
    if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) invalid(`不存在的自然日：${date}。`)
  }
  const dateRange = (values: unknown[]) => {
    if (values.length !== 2 || values.some(value => typeof value !== 'string')) invalid('日期范围必须包含两个日期字符串。')
    for (const value of values) parseDate(String(value))
    if (Date.parse(String(values[0])) > Date.parse(String(values[1]))) invalid('日期范围起点不能晚于终点。')
  }
  const filter = (value: unknown, depth: number): void => {
    if (!isObject(value)) invalid('过滤条件必须为对象。')
    if ('and' in value || 'or' in value) {
      const keys = Object.keys(value)
      const children = 'and' in value ? value.and : value.or
      if (keys.length !== 1 || !Array.isArray(children) || !children.length || depth >= 2) invalid('逻辑组只允许非空 and/or，最多嵌套两层。')
      for (const child of children) filter(child, depth + 1)
      return
    }
    if (Object.keys(value).some(key => !['member', 'operator', 'values'].includes(key)) || typeof value.member !== 'string' || typeof value.operator !== 'string' || !operators.has(value.operator)) invalid('过滤字段或操作符无效。')
    const field = member(value.member, 'dimension')
    if (value.member.endsWith('.value_type_name') || value.member === 'base_m_value_type_sys.name') invalid('监测类型必须按目录中的 value_type_id 精确过滤，类型名称只用于展示。')
    const values = value.values
    if (['set', 'notSet'].includes(value.operator)) {
      if (values !== undefined) invalid('set/notSet 不得携带 values。')
      return
    }
    if (!Array.isArray(values) || !values.length || values.some(item => item === null || !['string', 'number', 'boolean'].includes(typeof item))) invalid('过滤值必须为非空标量数组。')
    if (field.type === 'boolean') {
      value.values = values.map(item => {
        if ([true, 1, '1', 'true'].includes(item)) return '1'
        if ([false, 0, '0', 'false'].includes(item)) return '0'
        return invalid('布尔过滤只允许 1 或 0。')
      })
    }
    if (dateOperators.has(value.operator)) {
      if (field.type !== 'time') invalid('日期操作符只能引用时间维度。')
      if (value.operator.includes('DateRange')) dateRange(values)
      else { if (values.length !== 1) invalid('日期比较只接受一个值。'); parseDate(String(values[0])) }
    } else if (['gt', 'gte', 'lt', 'lte'].includes(value.operator)) {
      if (values.length !== 1 || !['number', 'time'].includes(field.type)) invalid('大小比较只接受一个数值或时间。')
      if (field.type === 'number' && !Number.isFinite(Number(values[0]))) invalid('数值比较需要有限数值。')
      if (field.type === 'time') parseDate(String(values[0]))
    } else if (['contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith'].includes(value.operator) && field.type !== 'string') invalid('文本操作符只能引用字符串维度。')
    if (value.operator === 'equals' && field.type === 'string' && !depth) {
      const others = query.filters.filter(item => isObject(item) && item !== value && item.member === value.member && item.operator === 'equals')
      if (others.some(item => isObject(item) && Array.isArray(item.values) && !item.values.some(candidate => values.includes(candidate)))) invalid('同一字段的多个候选对象必须放入同一个 or 组。', 'conflicting_filter')
    }
  }
  for (const item of query.filters) filter(item, 0)
  for (const item of query.time_dimensions) {
    const field = member(item.dimension, 'dimension')
    if (field.type !== 'time') invalid('time_dimensions 必须引用时间字段。')
    if (query.query_mode === 'view' && !query.dimensions.includes(item.dimension)) invalid('默认投影以外的时间字段只能用于 filters。')
    if (item.date_range) dateRange(item.date_range)
    if (item.granularity) invalid('历史明细保留原始采样时间，不允许时间聚合。')
  }
  for (const item of query.order) if (member(item.member).kind === 'segment') invalid('不能按 segment 排序。')
  return query
}

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
