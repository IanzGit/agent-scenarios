/** 工具共用的结构化表格、输出校验和纯 Markdown 渲染。 */
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

export type Row = Record<string, string | number | null>
export type Period = { start: string; end: string }
export type Table = { title: string; columns: string[]; rows: Row[] }
export type ToolResult = { title: string; summary: string; period?: Period; tables: Table[] }

export const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    period: { type: 'object', additionalProperties: false, properties: {
      start: { type: 'string', required: true }, end: { type: 'string', required: true },
    } },
    tables: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true },
        columns: { type: 'array', items: { type: 'string' }, required: true },
        rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
      },
    } },
  },
} as const satisfies ValueSchemaSpec

/** 创建一个带明确列顺序的业务表格。 */
export function table(title: string, columns: string[], rows: Row[]): Table {
  return { title, columns, rows }
}

/** 创建业务结果，不复制表格内容或生成展示元数据。 */
export function result(title: string, summary: string, tables: Table[], period?: Period): ToolResult {
  return { title, summary, tables, ...(period ? { period } : {}) }
}

function cell(value: InferValue<{ type: 'json' }> | undefined): string {
  if (value === null || value === undefined) return '—'
  const text = typeof value === 'number' ? String(Number(value.toFixed(2))) : typeof value === 'string' ? value : JSON.stringify(value)
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;')
    .replace(/\*/g, '&#42;').replace(/_/g, '&#95;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
    .replace(/\r\n?|\n/g, '<br>')
}

/** 输出全部表格行；原始时间序列不进入模型文本。 */
export function renderResult(_args: object, value: InferValue<typeof resultSchema>): { type: 'text'; text: string }[] {
  const tables = value.tables.map(item => {
    const title = `### ${cell(item.title)}`
    if (!item.rows.length) return `${title}\n\n无记录。`
    const line = (values: (InferValue<{ type: 'json' }> | undefined)[]) => `| ${values.map(cell).join(' | ')} |`
    return [title, '', line(item.columns), `| ${item.columns.map(() => '---').join(' | ')} |`,
      ...item.rows.map(row => line(item.columns.map(column => row[column]))),
    ].join('\n')
  })
  return [{ type: 'text', text: [value.summary, ...tables].join('\n\n') }]
}
