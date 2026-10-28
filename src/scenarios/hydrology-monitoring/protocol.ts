/** 查询输入、可持久化结果及业务错误；不依赖原 Python 运行时。 */
import { validateArgs, type InferValue } from '@deepseek-ai/dsh-tools'

const filterWithValues = { type: 'object', additionalProperties: false, properties: {
  member: { type: 'string', required: true, description: '公开维度的 model.member 全名。' },
  operator: { type: 'string', required: true, enum: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith', 'gt', 'gte', 'lt', 'lte', 'inDateRange', 'notInDateRange', 'beforeDate', 'beforeOrOnDate', 'afterDate', 'afterOrOnDate'] },
  values: { type: 'array', required: true, items: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
} } as const
const presenceFilter = { type: 'object', additionalProperties: false, properties: {
  member: { type: 'string', required: true }, operator: { type: 'string', enum: ['set', 'notSet'], required: true },
} } as const
const leafFilter = { oneOf: [filterWithValues, presenceFilter] } as const
const nestedFilter = { oneOf: [filterWithValues, presenceFilter,
  { type: 'object', additionalProperties: false, properties: { and: { type: 'array', required: true, items: leafFilter } } },
  { type: 'object', additionalProperties: false, properties: { or: { type: 'array', required: true, items: leafFilter } } },
] } as const
const filterSchema = { oneOf: [filterWithValues, presenceFilter,
  { type: 'object', additionalProperties: false, properties: { and: { type: 'array', required: true, items: nestedFilter } } },
  { type: 'object', additionalProperties: false, properties: { or: { type: 'array', required: true, items: nestedFilter } } },
] } as const

export const semanticQuerySchema = {
  type: 'object', additionalProperties: false, properties: {
    query_mode: { type: 'string', enum: ['view', 'cube'], required: true },
    models: { type: 'array', items: { type: 'string' }, required: true },
    measures: { type: 'array', items: { type: 'string' }, required: true },
    dimensions: { type: 'array', items: { type: 'string' }, required: true },
    segments: { type: 'array', items: { type: 'string' }, required: true },
    filters: { type: 'array', items: filterSchema, required: true, description: '顶层按 AND 组合。每个叶子使用 {"member":"model.member","operator":"equals","values":["值"]}，不得使用 {"model.member":["值"]} 简写；and/or 最多两层。' },
    time_dimensions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      dimension: { type: 'string', required: true },
      date_range: { type: 'array', items: { type: 'string' }, description: '含首尾自然日的日期范围；明细查询不提供 granularity。' },
    } } },
    order: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      member: { type: 'string', required: true }, direction: { type: 'string', enum: ['asc', 'desc'], required: true },
    } } },
    limit: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    offset: { type: 'integer', required: true }, ungrouped: { type: 'boolean', const: true, required: true },
  },
} as const
export type SemanticQuery = InferValue<typeof semanticQuerySchema>

/** 为 oneOf 的过滤分支补充具体路径；不修写或放宽模型输入。 */
export function filterInputIssues(query: unknown): string[] {
  if (!query || typeof query !== 'object' || !('filters' in query) || !Array.isArray(query.filters)) return []
  const issues: string[] = []
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(`${path} 必须为过滤对象。`); return }
    if ('and' in value || 'or' in value) {
      const key = 'and' in value ? 'and' : 'or'
      const children = 'and' in value ? value.and : value.or
      if (depth >= 2 || Object.keys(value).length !== 1 || !Array.isArray(children) || !children.length) { issues.push(`${path}.${key} 必须为非空数组，逻辑组最多两层且不能混入其他字段。`); return }
      children.forEach((child, index) => visit(child, `${path}.${key}[${index}]`, depth + 1))
      return
    }
    const schema = 'operator' in value && ['set', 'notSet'].includes(String(value.operator)) ? presenceFilter : filterWithValues
    issues.push(...validateArgs({ filter: { ...schema, required: true } }, { filter: value }).map(issue => issue.replaceAll('"filter', `"${path}`)))
  }
  query.filters.forEach((value, index) => visit(value, `semantic_query.filters[${index}]`, 0))
  return issues
}

export const recordSchema = {
  type: 'object', additionalProperties: false, properties: {
    version: { type: 'integer', const: 1, required: true },
    outcome: { type: 'string', enum: ['success', 'no_data', 'error'], required: true },
    terminal: { type: 'boolean', required: true }, query_goal: { type: 'string', required: true },
    semantic_query: semanticQuerySchema,
    row_count: { type: 'integer', required: true },
    columns: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', required: true }, title: { type: 'string', required: true }, data_type: { type: 'string', required: true },
    } } },
    rows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
    error: { type: 'object', additionalProperties: false, properties: {
      stage: { type: 'string', required: true }, code: { type: 'string', required: true },
      message: { type: 'string', required: true }, retryable: { type: 'boolean', required: true },
    } },
  },
} as const
export type QueryRecord = InferValue<typeof recordSchema>

export const resultRefSchema = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, sha256: { type: 'string', required: true },
} } as const
export type ResultRef = InferValue<typeof resultRefSchema>

/** 版本2回执只携带状态和引用；完整版本1记录保存在独立文件。 */
export const receiptSchema = { type: 'object', additionalProperties: false, properties: {
  version: { type: 'integer', const: 2, required: true },
  outcome: recordSchema.properties.outcome, terminal: recordSchema.properties.terminal,
  query_goal: recordSchema.properties.query_goal, row_count: recordSchema.properties.row_count,
  error: recordSchema.properties.error, result_ref: resultRefSchema,
} } as const
export type QueryReceipt = InferValue<typeof receiptSchema>

export function receiptFor(record: QueryRecord, result_ref?: ResultRef): QueryReceipt {
  return { version: 2, outcome: record.outcome, terminal: record.terminal, query_goal: record.query_goal, row_count: record.row_count,
    ...(record.error ? { error: record.error } : {}), ...(result_ref ? { result_ref } : {}) }
}

/** 只读取工具拥有的持久化 metadata，不解析模型展示文本。 */
export function receiptFromMeta(meta: unknown): QueryReceipt | undefined {
  if (!meta || typeof meta !== 'object' || !('hydrologyQuery' in meta)) return undefined
  const value = meta.hydrologyQuery
  const issues = validateArgs({ receipt: { ...receiptSchema, required: true } }, { receipt: value })
  if (issues.length) throw new Error(`查询回执无效，请重新查询：${issues.join('；')}`)
  const receipt = value as QueryReceipt
  const ref = receipt.result_ref
  if (receipt.row_count < 0 || (receipt.outcome === 'error' && !receipt.error)
    || (receipt.terminal && receipt.outcome !== 'error' && !ref)
    || (ref && (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.bytes < 1))) throw new Error('查询回执状态或文件引用无效，请重新查询。')
  return receipt
}

export class QueryError extends Error {
  constructor(message: string, readonly code: string, readonly stage: string, readonly retryable = false) { super(message) }
}

/** 持久化数据属于输入边界，读取时重新检查版本和结果一致性。 */
export function parseRecord(value: unknown): QueryRecord {
  const issues = validateArgs({ record: { ...recordSchema, required: true } }, { record: value })
  if (issues.length) throw new Error(`水文查询记录格式无效：${issues.join('；')}`)
  const record = value as QueryRecord
  if (record.row_count !== record.rows.length || !record.terminal
    || (record.outcome === 'success' && !record.rows.length)
    || (record.outcome === 'no_data' && record.rows.length)
    || (record.outcome === 'error' && !record.error)
    || record.rows.some(row => Object.values(row).some(value => value !== null && typeof value !== 'string' && typeof value !== 'number'))) throw new Error('水文查询记录状态、行数或标量类型不一致。')
  return record
}

/** 已知业务错误保留修正信息，未知异常不向模型泄露部署详情。 */
export function errorRecord(error: unknown, goal: string): QueryRecord {
  const failure = error instanceof QueryError ? error : new QueryError('水文查询内部错误。', 'internal_error', 'query')
  return { version: 1, outcome: 'error', terminal: !failure.retryable, query_goal: goal, row_count: 0, columns: [], rows: [],
    error: { stage: failure.stage, code: failure.code, message: failure.message, retryable: failure.retryable } }
}
