/** 从 Harness 原生工具事件投影本轮结果；同一逻辑用于实时和历史回放。 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { parseReport, TOOL_NAMES, type Report } from '../shared.ts'

export type ReportEntry = { callId: string; seq: number; tool: string; report?: Report; error?: string }
export type TurnReports = { entries: readonly ReportEntry[] }
type State = TurnReports & { turn: number; calls: ReadonlyMap<string, string> }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap { 'water-hazard': TurnReports }
}

export const reportDefinition: ConversationNodeDefinition<State> = {
  kind: 'water-hazard',
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || (event.type === 'tool/result' && isAppendSurfaceEvent(event))) return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'turn/start') throw new Error('水害结果投影需要 turn/start')
    return { turn: match.event.data.turn, calls: new Map(), entries: [] }
  },
  update(context, match) {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      const { name, callId } = match.event.data
      if (TOOL_NAMES.some(tool => tool === name)) calls.set(String(callId), name)
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    const { message, meta } = match.event.data
    const callId = String(message.source.callId)
    const tool = context.state.calls.get(callId)
    if (!tool) return context.state
    const report = message.isError ? undefined : parseReport(meta)
    const error = message.isError ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : report ? undefined : '展示数据缺失或版本不受支持'
    const entry: ReportEntry = { callId, tool, seq: match.event.seq, ...(report ? { report } : { error }) }
    return { ...context.state, entries: [...context.state.entries.filter(item => item.callId !== callId), entry] }
  },
  buildLocationData(context, scope, previous) {
    if (scope !== 'turn' || !context.state) return null
    if (previous?.kind === 'turn' && previous.key === 'water-hazard' && previous.turn === context.state.turn && previous.value.entries === context.state.entries) return previous
    return { kind: 'turn', turn: context.state.turn, key: 'water-hazard', value: { entries: context.state.entries } }
  },
}
