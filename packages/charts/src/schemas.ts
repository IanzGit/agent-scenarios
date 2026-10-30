/** 数据来源目录与持久展示结果的 schema。 */
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ChartSource } from './types.ts'

export const chartSourceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    source_id: { type: 'string', required: true },
    documents: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, title: { type: 'string', required: true },
    } } },
    datasets: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          row_count: { type: 'integer', required: true },
          columns: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                title: { type: 'string' },
                type: { type: 'string', enum: ['category', 'time', 'number'], required: true },
                unit: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies ValueSchemaSpec

export const chartResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    chart_id: { type: 'string', required: true },
    chart_type: { type: 'string', enum: ['line', 'bar', 'pie', 'stacked_bar', 'scatter'], required: true },
    title: { type: 'string', required: true },
    source_id: { type: 'string', required: true },
    dataset_id: { type: 'string', required: true },
    status: { type: 'string', enum: ['rendered', 'no_data'], required: true },
    summary: { type: 'string', required: true },
    option: { type: 'json' },
  },
} as const satisfies ValueSchemaSpec

/** 将轻量来源目录附加到业务工具的模型观察中。 */
export function renderChartSource(source?: ChartSource): { type: 'text'; text: string }[] {
  return source ? [{ type: 'text', text: `\n\n可绘图数据集（使用来源ID调用图表工具）：\n${JSON.stringify(source)}` }] : []
}
