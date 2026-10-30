/** 展示本轮业务计算生成的自包含图形文档。HTML 不作为模型参数。 */
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from '../service.ts'
import type { Json } from '../types.ts'

export const name = 'render_html_chart'
export function createTool(sources: ChartSources) {
  return defineTool({ name, description: '展示本轮成功业务工具返回的 SVG HTML 图形文档，保留图例、动画及历史回放。',
    parameters: {
      source_id: { type: 'string', required: true, description: '本轮 chart_source.source_id。' },
      document_id: { type: 'string', required: true, description: 'chart_source.documents 中的真实文档ID。' },
      title: { type: 'string', required: true, description: '图形的中文标题。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        chart_id: { type: 'string', required: true }, chart_type: { type: 'string', enum: ['html'], required: true },
        title: { type: 'string', required: true }, source_id: { type: 'string', required: true },
        document_id: { type: 'string', required: true }, status: { type: 'string', enum: ['rendered'], required: true },
        summary: { type: 'string', required: true }, html: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `${value.title}：${value.summary}\n图表ID：${value.chart_id}；状态：${value.status}` }],
      presentationMeta: (_args, value): Json => ({ agentScenariosChart: { version: 2, chart: value } }),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      if (!args.title.trim()) throw new Error('图表标题不能为空。')
      const document = sources.resolveDocument(exec, args.source_id, args.document_id)
      return { ...args, chart_id: createHash('sha256').update(JSON.stringify(['html', args])).digest('hex').slice(0, 24),
        chart_type: 'html' as const, status: 'rendered' as const, summary: '图形文档已生成，支持正文展示与历史回放。', html: document.html }
    },
  })
}
