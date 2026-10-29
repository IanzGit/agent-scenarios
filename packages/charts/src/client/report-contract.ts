/** 独立报告正文 Factory 的 JSON 输入。 */
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChartResult } from '../types.ts'

export interface ReportBodyInput { markdown: string; charts: readonly ChartResult[]; labels: MarkdownLabels }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'agent-scenarios.report.body': { scope: 'session'; props: ReportBodyInput }
  }
}
