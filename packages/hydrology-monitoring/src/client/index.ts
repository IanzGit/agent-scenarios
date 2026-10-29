/** 业务插件 Client 入口，注册标准 Conversation 节点及键控渲染器。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { parentTaskDefinition, reportDefinition } from './task-nodes.ts'
import { ParentTaskView, ReportView } from './TaskViews.tsx'
import styles from './styles.css'

export const inject = ['uiConversation', 'slots']

/** 全部注册由插件生命周期释放，不修改通用 Chat 折叠策略。 */
export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(parentTaskDefinition)
  ctx.uiConversation.events.register(reportDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'hydrology-parent-task', locale: 'chat' }, ParentTaskView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'hydrology-report', locale: 'chat' }, ReportView))
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => { style.remove() }
  })
}
