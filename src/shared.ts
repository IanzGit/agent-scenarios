/** Host 结果与 Web 历史回放共用的数据定义。 */
import { z } from 'zod'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Row = Record<string, string | number | null>
export type Period = { start: string; end: string }
export type Table = { key: string; title: string; columns: string[]; rows: Row[] }
export type Chart = { key: string; title: string; hasData: boolean; option: Record<string, Json> }
export type Report = {
  version: 1
  title: string
  summary: string
  period?: Period
  tables: Table[]
  charts: Chart[]
}
export type BusinessResult = Report & { data: Record<string, Json> }

export const TOOL_NAMES = ['get_device_status', 'get_device_alarm', 'get_model_warning', 'get_warning_statistics', 'get_hydrological_trend'] as const
export type ToolName = typeof TOOL_NAMES[number]

const rowSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()]))
/** 仅在持久化 JSON 进入浏览器时校验，不在同进程业务函数间重复校验。 */
export const reportSchema = z.object({
  version: z.literal(1), title: z.string(), summary: z.string(),
  period: z.object({ start: z.string(), end: z.string() }).optional(),
  tables: z.array(z.object({ key: z.string(), title: z.string(), columns: z.array(z.string()), rows: z.array(rowSchema) })),
  charts: z.array(z.object({ key: z.string(), title: z.string(), hasData: z.boolean(), option: z.record(z.string(), z.json()) })),
})

/** 从日志元数据恢复报告；不支持的版本或损坏数据不进入图表组件。 */
export function parseReport(meta: unknown): Report | undefined {
  if (typeof meta !== 'object' || meta === null || !('waterHazard' in meta)) return undefined
  const parsed = reportSchema.safeParse(meta.waterHazard)
  return parsed.success ? parsed.data : undefined
}

/** 图表数据留在持久化元数据中，避免原始曲线进入模型上下文。 */
export function presentation(result: BusinessResult): { waterHazard: Report } {
  const { data: _data, ...report } = result
  return { waterHazard: report }
}
