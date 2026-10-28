/** 图表插件的 Client 入口，按工具名注册调用卡片及样式。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ChartToolView, CHART_TOOL_NAMES } from './ChartToolView.tsx'
import { ChartResponseBody } from './ChartResponseBody.tsx'
import { chartDefinition } from './chart-data.ts'
import styles from './styles.css'

export const inject = ['slots', 'uiConversation']

/** 五类工具共用一套卡片，注册及样式随插件卸载释放。 */
export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(chartDefinition)
  ctx.slots.inject('conversation.chat.response.body', () => ctx.slots.register({ name: 'conversation.chat.response.body' }, ChartResponseBody))
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const name of CHART_TOOL_NAMES) yield ctx.slots.register({ name: 'tool.call.toolview', key: name }, ChartToolView)
  })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => { style.remove() }
  })
}
