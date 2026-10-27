/** 当前会话当前轮的数据来源服务，由 Harness 插件生命周期管理。 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ChartDataset, ChartSource } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chartSources: ChartSources
  }
}

type PendingSource = { owner: object; turn: number; id: string; datasets: ChartDataset[] }

/** 仅在查询通过工具管线后发布数据，并在轮次结束或插件卸载时释放。 */
export class ChartSources extends Service {
  static inject = ['tools', 'sessionProjections']
  private accepted = new WeakMap<object, { turn: number; sources: Map<string, ChartDataset[]> }>()
  private pending = new Map<symbol, PendingSource>()

  constructor(ctx: Context) {
    super(ctx, 'chartSources')
    ctx.on('tools/result', (exec, result) => { this.accept(exec, result) })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.accepted.delete(session)
    })
    ctx.effect(() => () => {
      this.pending.clear()
      this.accepted = new WeakMap()
    })
  }

  /** 为本轮查询暂存数据并返回目录；无活动轮次时保持程序化业务调用原状。 */
  prepare(exec: ToolRunContext, datasets: ChartDataset[]): ChartSource | undefined {
    const owner = exec.agent?.session
    const turn = this.currentTurn(exec)
    if (!owner || turn === undefined) return undefined
    const id = randomUUID()
    this.pending.set(exec.token, { owner, turn, id, datasets: structuredClone(datasets) })
    return {
      source_id: id,
      datasets: datasets.map(({ rows, ...dataset }) => ({ ...dataset, row_count: rows.length })),
    }
  }

  /** 解析本轮授权的数据；其他会话、失败调用及过期来源均不可用。 */
  resolve(exec: Readonly<ToolExecution>, sourceId: string, datasetId: string): ChartDataset {
    const turn = this.currentTurn(exec)
    const state = exec.agent ? this.accepted.get(exec.agent.session) : undefined
    const dataset = turn !== undefined && state?.turn === turn
      ? state.sources.get(sourceId)?.find(item => item.id === datasetId) : undefined
    if (!dataset) throw new Error('图表数据源不可用或已过期，请使用本轮成功查询返回的 source_id 和 dataset_id。')
    return dataset
  }

  private currentTurn(exec: Readonly<ToolExecution>): number | undefined {
    const boundary = exec.agent && this.ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')
    return boundary?.openTurnStartSeq != null ? boundary.lastTurn : undefined
  }

  private accept(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const source = this.pending.get(exec.token)
    this.pending.delete(exec.token)
    if (!source || result.isError || this.currentTurn(exec) !== source.turn) return
    const value = result.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const catalog = value.chart_source
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || catalog.source_id !== source.id) return
    let state = this.accepted.get(source.owner)
    if (state?.turn !== source.turn) {
      state = { turn: source.turn, sources: new Map() }
      this.accepted.set(source.owner, state)
    }
    state.sources.set(source.id, source.datasets)
  }
}
