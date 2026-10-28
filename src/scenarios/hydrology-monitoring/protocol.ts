/** 查询输入、可持久化结果及业务错误；不依赖原 Python 运行时。 */
import { validateArgs, type InferValue } from '@deepseek-ai/dsh-tools'

export const semanticQuerySchema = {
  type: 'object', additionalProperties: false, properties: {
    query_mode: { type: 'string', enum: ['view', 'cube'], required: true },
    models: { type: 'array', items: { type: 'string' }, required: true },
    measures: { type: 'array', items: { type: 'string' }, required: true },
    dimensions: { type: 'array', items: { type: 'string' }, required: true },
    segments: { type: 'array', items: { type: 'string' }, required: true },
    filters: { type: 'array', items: { type: 'json' }, required: true, description: 'dimension 过滤条件或 and/or 组，最多两层逻辑组。' },
    time_dimensions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      dimension: { type: 'string', required: true },
      date_range: { type: 'array', items: { type: 'string' } }, granularity: { type: 'string' },
    } } },
    order: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      member: { type: 'string', required: true }, direction: { type: 'string', enum: ['asc', 'desc'], required: true },
    } } },
    limit: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    offset: { type: 'integer', required: true }, ungrouped: { type: 'boolean', const: true, required: true },
  },
} as const
export type SemanticQuery = InferValue<typeof semanticQuerySchema>

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
