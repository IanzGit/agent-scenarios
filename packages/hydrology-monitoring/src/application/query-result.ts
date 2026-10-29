/** 核对查询子会话的真实回执，不使用子智能体的 closing message。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '../infrastructure/results.ts'
import { receiptFromMeta, type QueryReceipt, type QueryRecord } from '../domain/protocol.ts'

/** 返回已提交的最终结果；尚无回执时保留子会话存在与运行事实。 */
export async function readQueryResult(ctx: Context, parent: SessionId, child: SessionId, signal: AbortSignal): Promise<{
  exists: boolean; ended: boolean; receipt?: QueryReceipt; record?: QueryRecord
}> {
  let observation
  try { observation = await ctx.sessionQuery.observeSession(child, { signal }) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { exists: false, ended: false }
    throw error
  }
  using observed = observation
  if (observed.header.parentSession !== parent || observed.header.agentPreset !== 'hydrology-query') throw new Error('查询子会话归属或 preset 不匹配。')
  const events = observed.events.slice(Number(observed.inheritedEventCount))
  const end = events.findLast(event => event.type === 'turn/end')
  const start = events.findLast(event => event.type === 'turn/start')
  const calls = new Set(events.filter(event => event.type === 'tool/call' && ['search_semantic_catalog', 'run_semantic_query'].includes(event.data.name)).map(event => event.type === 'tool/call' ? event.data.callId : ''))
  let receipt: QueryReceipt | undefined
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data.message.isError || !calls.has(event.data.message.toolCallId)) continue
    const candidate = receiptFromMeta(event.data.meta)
    if (!candidate?.terminal) continue
    if (receipt) throw new Error('查询子会话存在多个最终结果。')
    receipt = candidate
  }
  if (!receipt) return { exists: true, ended: !!end && !!start && end.seq > start.seq }
  const record: QueryRecord = receipt.result_ref
    ? await ctx.hydrologyQueryResults.read(child, parent, receipt.result_ref, signal)
    : { version: 1, outcome: 'error', terminal: true, query_goal: receipt.query_goal, row_count: 0, columns: [], rows: [], error: receipt.error }
  if (record.outcome !== receipt.outcome || record.row_count !== receipt.row_count || record.query_goal !== receipt.query_goal) throw new Error('完整查询结果与回执不一致。')
  return { exists: true, ended: true, receipt, record }
}
