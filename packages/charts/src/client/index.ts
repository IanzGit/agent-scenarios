/** 图表插件的 Client 入口，只负责注册会话投影、展示插槽及样式。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { chartDefinition } from './conversation.ts'
import { ReportCharts } from './Charts.tsx'
import styles from './styles.css'

export const inject = ['slots', 'uiConversation']

/** 所有贡献随插件卸载释放，保留 Harness 原有工具卡片及报告正文。 */
export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(chartDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'agent-scenarios-charts', order: 100,
  }, ReportCharts))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => { style.remove() }
  })
}
