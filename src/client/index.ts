/** Web 插件：使用原生事件投影与 turnTail 插槽，不修改 Harness 聊天实现。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { reportDefinition } from './projection.ts'
import { ReportTail } from './ReportView.tsx'
import './styles.css'

const zh = { results: '水害分析结果', empty: '当前查询无有效数据', failed: '查询失败', chartFailure: '图表暂时无法展示，请查看本轮工具结果' }
const en = { results: 'Water hazard analysis', empty: 'No data for this query', failed: 'Query failed', chartFailure: 'Unable to display this chart; inspect the tool result' }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { coalMine: keyof typeof zh }
}
export const inject = ['slots', 'locale', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('coalMine', { zh, en }))
  ctx.uiConversation.events.register(reportDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'coal-mine-water-hazard', locale: 'coalMine', order: 30,
  }, ReportTail))
}
