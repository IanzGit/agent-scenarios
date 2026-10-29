/** 父任务与独立报告的 Conversation Definitions；只投影已提交插件记录。 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { taskRecord, type ParentTask } from '../domain/task-protocol.ts'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'hydrology-parent-task': ParentTask
    'hydrology-report': ParentTask
  }
}

/** 一份完整发布记录即可构建报告，历史分页不要求加载任务起点。 */
function definition(report: boolean): ConversationNodeDefinition<ParentTask> {
  const kind = report ? 'hydrology-report' : 'hydrology-parent-task'
  return {
    kind, target: 'chat',
    match(event) {
      if (event.type === 'assistant/live-chunk') return null
      const record = taskRecord(event)
      if (!record || report && record.kind !== 'published') return null
      return { id: report ? record.task.report_id : record.task.id, role: 'start' }
    },
    start(_context, match) {
      if (match.event.type === 'assistant/live-chunk') throw new Error('父任务不消费临时助手流。')
      return taskRecord(match.event)!.task
    },
    update(context, match) {
      if (report || match.event.type === 'assistant/live-chunk') return context.state
      return taskRecord(match.event)!.task
    },
    buildViewNode(context) {
      if (!context.state || !context.start) return null
      return { key: context.key, id: context.id, kind, target: 'chat', anchorSeq: context.start.event.seq,
        location: context.start.location, visibility: 'visible', groupTree: 'turn', data: context.state }
    },
  }
}

export const parentTaskDefinition = definition(false)
export const reportDefinition = definition(true)
