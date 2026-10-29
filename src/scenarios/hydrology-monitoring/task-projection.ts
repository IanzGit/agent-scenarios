/** 框架驱动的父任务投影；Session 记录是唯一持久化状态。 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { taskRecord, taskSchema, type ParentTask } from './task-protocol.ts'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { hydrologyParentTasks: { tasks: ParentTask[] } }
}

export const parentTaskProjection: ProjectionDefinition<'hydrologyParentTasks'> = {
  key: 'hydrologyParentTasks', stateVersion: 1,
  stateSchema: z.object({ tasks: z.array(taskSchema) }).strict(),
  init: () => ({ tasks: [] }),
  apply(state, event) {
    if (event.type === 'user/message' && event.data.source.kind === 'hydrology-task-ready') {
      const taskId = event.data.source.taskId
      return { tasks: state.tasks.map(task => task.id === taskId && task.wake
        ? { ...task, wake: { ...task.wake, consumed: true } } : task) }
    }
    const record = taskRecord(event)
    if (!record) return state
    return { tasks: [...state.tasks.filter(task => task.id !== record.task.id), record.task] }
  },
}
