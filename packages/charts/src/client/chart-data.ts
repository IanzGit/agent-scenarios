/** 从持久化工具结果投影本轮图表，供正文引用与历史回放。 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chartFromMeta, type ChartCard } from './chart-meta.ts'

type State = { turn: number; charts: readonly ChartCard[] }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    'agent-scenarios-charts': readonly ChartCard[]
  }
}

/** 稳定 ID 的重复成功调用只展示一次，保持首次调用顺序。 */
export function appendChart(charts: readonly ChartCard[], meta: unknown): readonly ChartCard[] {
  const chart = chartFromMeta(meta)
  if (!chart || charts.some(item => item.chart_id === chart.chart_id)) return charts
  return [...charts, chart]
}

/** 仅发布轮次数据，不接管 Harness 的工具卡片或助手正文节点。 */
export const chartDefinition: ConversationNodeDefinition<State> = {
  kind: 'agent-scenarios-charts',
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/result' && chartFromMeta(event.data.meta) && !event.data.message.isError) return { id: String(event.data.turn), role: 'start' }
    return null
  },
  start(_context, match) {
    if (match.event.type === 'turn/start') return { turn: match.event.data.turn, charts: [] }
    if (match.event.type === 'tool/result') return { turn: match.event.data.turn, charts: appendChart([], match.event.data.meta) }
    throw new Error('图表投影需要轮次或成功绘图结果。')
  },
  update(context, match) {
    if (match.event.type !== 'tool/result') return context.state
    const charts = appendChart(context.state.charts, match.event.data.meta)
    return charts === context.state.charts ? context.state : { ...context.state, charts }
  },
  buildLocationData(context, scope) {
    const state = context.state
    return scope === 'turn' && state?.charts.length ? { kind: 'turn', turn: state.turn, key: 'agent-scenarios-charts', value: state.charts } : null
  },
}
