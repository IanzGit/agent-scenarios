/** 标准 Cordis Host 父任务服务，拥有查询调度、恢复及不可变报告发布。 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendPluginRecord, SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderChart, type ChartDataset } from 'dsh-agent-charts'
import { isObject } from '../domain/catalog.ts'
import { readQueryResult } from './query-result.ts'
import { presentQuery } from '../presentation/query-result.ts'
import { QueryError, type QueryReceipt, type QueryRecord } from '../domain/protocol.ts'
import { parentTaskProjection } from '../infrastructure/task-projection.ts'
import { parsePlan, wakeMessage, type ParentTask, type TaskPlan, type TaskRecord, TASK_RECORD } from '../domain/task-protocol.ts'
import { validateReport } from '../domain/report-validation.ts'

declare module '@deepseek-ai/cordis' { interface Context { hydrologyParentTasks: ParentTasks } }

export interface Config { maxConcurrentQueries?: number; maxQueryAttempts?: number; retryDelayMs?: number }
type Running = { agent: Agent; taskId: string; reconciling: boolean; abort: AbortController; activations: Map<string, SubagentActivation>; work: Promise<void> }
type Pending = { agent: Agent; task: ParentTask; action: 'submit' | 'publish' | 'cancel' }
type Failure = NonNullable<QueryRecord['error']>
const failure = (message: string, code = 'task_execution_error'): Failure => ({ stage: 'parent-task', code, message, retryable: false })
const terminal = (task: ParentTask) => task.phase === 'published' || task.phase === 'cancelled'
const done = (status: ParentTask['queries'][string]['status']) => status !== 'pending' && status !== 'running'
const transient = (error: Failure | undefined) => !!error && ['cube_network_error', 'cube_timeout', 'cube_server_error', 'interrupted'].includes(error.code)
function cancelled(task: ParentTask): ParentTask {
  const next = structuredClone(task)
  next.phase = 'cancelled'
  for (const query of Object.values(next.queries)) if (!done(query.status)) {
    query.status = 'skipped'; query.reason = '用户已取消任务。'
    const attempt = query.attempts.at(-1)
    if (attempt && (attempt.status === 'reserved' || attempt.status === 'running')) {
      attempt.status = 'interrupted'; attempt.error = failure(query.reason, 'cancelled')
    }
  }
  return next
}

/** 服务全局注册，各父会话的状态和在途执行相互隔离。 */
export default class ParentTasks extends Service {
  static inject = ['agents', 'sessions', 'subagents', 'sessionQuery', 'sessionProjections', 'hydrologyQueryResults', 'tools']
  static Config: z<Config> = z.object({
    maxConcurrentQueries: z.natural().min(1).default(3),
    maxQueryAttempts: z.natural().min(1).default(2), retryDelayMs: z.number().min(0).default(1000),
  })
  private readonly config: Required<Config>
  private readonly pending = new Map<ToolExecutionToken, Pending>()
  private readonly running = new Map<string, Running>()
  private closing = false

  constructor(ctx: Context, config: Partial<Config> = {}) {
    super(ctx, 'hydrologyParentTasks')
    this.config = { maxConcurrentQueries: config.maxConcurrentQueries ?? 3, maxQueryAttempts: config.maxQueryAttempts ?? 2, retryDelayMs: config.retryDelayMs ?? 1000 }
    if (!Number.isSafeInteger(this.config.maxConcurrentQueries) || this.config.maxConcurrentQueries < 1
      || !Number.isSafeInteger(this.config.maxQueryAttempts) || this.config.maxQueryAttempts < 1
      || !Number.isFinite(this.config.retryDelayMs) || this.config.retryDelayMs < 0) throw new Error('父任务并发、尝试次数和重试间隔配置无效。')
    ctx.sessionProjections.register(parentTaskProjection)
    ctx.on('tools/result', (exec, result) => {
      const pending = this.pending.get(exec.token)
      if (!pending) return
      this.pending.delete(exec.token)
      if (result.isError || exec.signal.aborted || !isObject(result.value) || result.value.task_id !== pending.task.id) return
      if (pending.action === 'submit') {
        if (!this.find(pending.agent, pending.task.id)) this.commit(pending.agent.session, 'accepted', pending.task)
        this.start(pending.agent, pending.task.id)
      } else if (pending.action === 'publish') {
        const current = this.require(pending.agent, pending.task.id)
        if (current.phase === 'published') return
        if (current.phase !== 'composing') throw new Error('任务状态已改变，不能发布报告。')
        this.commit(pending.agent.session, 'published', pending.task)
      } else {
        const current = this.require(pending.agent, pending.task.id)
        if (!terminal(current)) this.commit(pending.agent.session, 'cancelled', cancelled(current))
        const active = this.running.get(pending.task.id)
        if (active) void this.stop(active).catch(error => ctx.logger.warn(`取消水文任务失败：${String(error)}`))
      }
    })
    ctx.on('agent/created', async ({ agent }) => {
      await Promise.all([...this.running.values()].filter(active => active.agent.id === agent.id && active.agent !== agent).map(active => this.stop(active)))
      this.recover(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const active of this.running.values()) if (active.agent === agent) {
        void this.stop(active).catch(error => ctx.logger.warn(`停止水文任务失败：${String(error)}`))
      }
    })
    ctx.effect(() => async () => {
      this.closing = true
      this.pending.clear()
      const outcomes = await Promise.allSettled([...this.running.values()].map(active => this.stop(active)))
      for (const outcome of outcomes) if (outcome.status === 'rejected') ctx.logger.warn(`释放水文任务失败：${String(outcome.reason)}`)
    })
  }

  private tasks(agent: Agent): readonly ParentTask[] {
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'hydrologyParentTasks')
    if (!state) throw new Error('水文父任务投影不可用。')
    return state.tasks.filter(task => task.parent_id === agent.id)
  }
  private find(agent: Agent, taskId: string): ParentTask | undefined { return this.tasks(agent).find(task => task.id === taskId) }
  private require(agent: Agent, taskId: string): ParentTask {
    const task = this.find(agent, taskId)
    if (!task) throw new Error('父任务不存在或不属于当前会话。')
    return task
  }
  private commit(session: Session, kind: TaskRecord['kind'], task: ParentTask): void {
    appendPluginRecord(session, TASK_RECORD, { version: 1, kind, task })
  }
  private change(agent: Agent, taskId: string, kind: TaskRecord['kind'], update: (task: ParentTask) => void): ParentTask {
    const task = structuredClone(this.require(agent, taskId))
    update(task)
    this.commit(agent.session, kind, task)
    return task
  }

  /** 暂存计划；只有对应工具最终被接受才持久化并启动后台。 */
  submit(exec: ToolRunContext, input: unknown): ParentTask {
    if (this.closing || !exec.agent) throw new Error('父任务需要活动主会话及可用服务。')
    const agent = exec.agent, plan = parsePlan(input)
    const origin = agent.session.ownEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (origin?.type !== 'user/message') throw new Error('父任务必须由已记录的用户请求发起。')
    const candidates = [...this.tasks(agent), ...[...this.pending.values()].filter(item => item.agent === agent && item.action === 'submit').map(item => item.task)]
    const existing = candidates.find(task => task.origin_message_id === origin.data.id)
    if (existing) {
      if (JSON.stringify(existing.plan) !== JSON.stringify(plan)) throw new Error('当前用户请求已有固定计划；修改计划需结束旧任务并发起新请求。')
      if (!this.find(agent, existing.id)) this.pending.set(exec.token, { agent, task: existing, action: 'submit' })
      exec.concludeTurn()
      return existing
    }
    if (candidates.some(task => !terminal(task))) throw new Error('当前父会话仍有未结束任务，请等待或明确取消旧任务。')
    if ([...this.running.values()].some(active => active.agent === agent)) throw new Error('上一任务仍在释放执行资源，请稍后提交。')
    const task: ParentTask = {
      id: randomUUID(), parent_id: agent.id, report_id: randomUUID(), origin_message_id: origin.data.id,
      plan, phase: 'querying', charts: [],
      queries: Object.fromEntries(plan.queries.map(query => [query.id, { status: 'pending' as const, attempts: [] }])),
    }
    this.pending.set(exec.token, { agent, task, action: 'submit' })
    exec.concludeTurn()
    return task
  }

  /** 返回任务快照；不派发查询、不改变执行阶段。 */
  status(agent: Agent, taskId: string): ParentTask { return structuredClone(this.require(agent, taskId)) }

  /** 只读取本任务已选定的完整结果，支持跨轮恢复和绘图。 */
  async read(agent: Agent, taskId: string, signal: AbortSignal) {
    const task = this.require(agent, taskId)
    const results = []
    if (task.phase === 'composing') for (const query of task.plan.queries) {
      const current = task.queries[query.id], receipt = current.attempts.at(-1)?.receipt
      const record = receipt ? await this.record(agent, current.attempts.at(-1)!.child_id, receipt, signal) : undefined
      results.push({ query_id: query.id, status: current.status, reason: current.reason,
        ...(record ? { result: presentQuery(record).value } : {}) })
    }
    return { task_id: task.id, report_id: task.report_id, phase: task.phase, problem: task.problem,
      queries: results.length ? results : task.plan.queries.map(query => ({ query_id: query.id, status: task.queries[query.id].status })),
      charts: task.charts.map(item => ({ intent_id: item.intent_id, status: item.status, summary: item.summary,
        ...(item.chart ? { chart_id: item.chart.chart_id, title: item.chart.title } : {}) })),
      report: task.plan.report }
  }

  /** 暂存不可变发布；相同正文重放幂等，不允许覆盖已发布内容。 */
  publish(exec: ToolRunContext, taskId: string, markdown: string): ParentTask {
    if (!exec.agent) throw new Error('发布报告需要活动主会话。')
    const task = this.require(exec.agent, taskId), body = markdown.trim()
    if (task.phase === 'published') {
      if (task.markdown !== body) throw new Error('已发布报告不能覆盖；修订请发起新的业务任务。')
      exec.concludeTurn(); return task
    }
    if (task.phase !== 'composing') throw new Error('查询和绘图未全部结束，不能发布报告。')
    if (this.running.get(taskId)?.reconciling) throw new Error('任务正在核对已有结果，请等待集中就绪通知。')
    if ([...this.pending.values()].some(item => item.action === 'publish' && item.task.id === taskId && item.task.markdown !== body)) throw new Error('同一报告已有不同正文正在提交。')
    validateReport(task, body)
    const published: ParentTask = { ...task, phase: 'published', markdown: body }
    this.pending.set(exec.token, { agent: exec.agent, task: published, action: 'publish' })
    exec.concludeTurn()
    return published
  }

  /** 用户明确取消后才终止任务；取消同样等待工具最终接受。 */
  cancel(exec: ToolRunContext, taskId: string): ParentTask {
    if (!exec.agent) throw new Error('取消任务需要活动主会话。')
    const task = this.require(exec.agent, taskId)
    if (task.phase === 'published') throw new Error('已发布报告不能取消。')
    this.pending.set(exec.token, { agent: exec.agent, task, action: 'cancel' })
    exec.concludeTurn()
    return cancelled(task)
  }

  /** 仅在父 Agent 恢复执行时启动核对，不扫描或激活历史会话。 */
  recover(agent: Agent): void {
    for (const task of this.tasks(agent)) if (!terminal(task) && task.phase !== 'blocked') this.start(agent, task.id)
  }

  /** 等待指定父会话当前所有后台任务收敛，供宿主关闭和集成验证使用。 */
  async whenIdle(parentId: string): Promise<void> {
    while ([...this.running.values()].some(active => active.agent.id === parentId)) {
      await Promise.all([...this.running.values()].filter(active => active.agent.id === parentId).map(active => active.work))
    }
  }

  private start(agent: Agent, taskId: string): void {
    if (this.closing || this.running.has(taskId) || terminal(this.require(agent, taskId))) return
    const active: Running = { agent, taskId, reconciling: true, abort: new AbortController(), activations: new Map(), work: Promise.resolve() }
    this.running.set(taskId, active)
    active.work = this.execute(active).catch(error => {
      if (active.abort.signal.aborted) return
      this.change(agent, taskId, 'phase-changed', task => { task.phase = 'blocked'; task.problem = String(error instanceof Error ? error.message : error) })
    }).finally(() => { if (this.running.get(taskId) === active) this.running.delete(taskId) })
  }

  private async stop(active: Running): Promise<void> {
    active.abort.abort()
    const disposals = await Promise.allSettled([...active.activations.values()].map(activation => activation.dispose()))
    await active.work
    const errors = disposals.filter(item => item.status === 'rejected').map(item => item.reason)
    if (errors.length) throw new AggregateError(errors, '子任务释放失败。')
  }

  private async record(agent: Agent, childId: string, receipt: QueryReceipt, signal: AbortSignal): Promise<QueryRecord> {
    if (receipt.result_ref) return this.ctx.hydrologyQueryResults.read(SessionId(childId), agent.id, receipt.result_ref, signal)
    if (receipt.outcome !== 'error' || !receipt.error) throw new Error('查询回执缺少完整结果引用。')
    return { version: 1, outcome: 'error', terminal: true, query_goal: receipt.query_goal, row_count: 0, columns: [], rows: [], error: receipt.error }
  }

  private async reconcile(active: Running): Promise<void> {
    const { agent, taskId, abort: { signal } } = active
    for (const query of this.require(agent, taskId).plan.queries) {
      const current = this.require(agent, taskId).queries[query.id], attempt = current.attempts.at(-1)
      if (attempt?.receipt) {
        await this.record(agent, attempt.child_id, attempt.receipt, signal)
        if (current.status === 'running') this.change(agent, taskId, 'attempt-settled', task => {
          task.queries[query.id].status = attempt.receipt!.outcome === 'error' && transient(attempt.receipt!.error) && current.attempts.length < this.config.maxQueryAttempts ? 'pending' : attempt.receipt!.outcome
        })
        continue
      }
      if (current.status !== 'running' || !attempt) continue
      const result = await readQueryResult(this.ctx, agent.id, SessionId(attempt.child_id), signal)
      if (result.receipt) { this.settle(active, query.id, result.receipt, true); continue }
      if (this.ctx.agents.get(SessionId(attempt.child_id))) throw new Error(`子查询仍有活动执行，暂停恢复：${query.id}`)
      this.change(agent, taskId, 'attempt-settled', task => {
        const item = task.queries[query.id], last = item.attempts.at(-1)!
        if (!result.exists && last.status === 'reserved') { item.status = 'pending'; return }
        last.status = 'interrupted'; last.error = failure('先前执行已中断且没有已提交结果。', 'interrupted')
        item.status = item.attempts.length < this.config.maxQueryAttempts ? 'pending' : 'error'
        item.reason = last.error.message
      })
    }
  }

  private async execute(active: Running): Promise<void> {
    const { agent, taskId, abort: { signal } } = active
    const jobs = new Map<string, Promise<void>>()
    try {
      await this.reconcile(active)
      active.reconciling = false
      while (this.require(agent, taskId).phase === 'querying') {
        signal.throwIfAborted()
        let task = this.require(agent, taskId)
        let advanced = false
        for (const query of task.plan.queries) {
          if (task.queries[query.id].status !== 'pending' || jobs.has(query.id)) continue
          const dependencies = query.depends_on.map(id => task.queries[id])
          if (dependencies.some(item => done(item.status) && item.status !== 'success')) {
            task = this.change(agent, taskId, 'query-skipped', next => { next.queries[query.id].status = 'skipped'; next.queries[query.id].reason = '依赖查询失败、无数据或已跳过。' })
            advanced = true
          } else if (jobs.size < this.config.maxConcurrentQueries && dependencies.every(item => item.status === 'success')) {
            const job = this.query(active, query).finally(() => { jobs.delete(query.id) })
            jobs.set(query.id, job)
          }
        }
        if (jobs.size) await Promise.race(jobs.values())
        else if (Object.values(this.require(agent, taskId).queries).every(item => done(item.status))) break
        else if (advanced) continue
        else throw new Error('查询依赖无法继续推进。')
      }
      signal.throwIfAborted()
      if (terminal(this.require(agent, taskId))) return
      if (this.require(agent, taskId).phase === 'querying') this.change(agent, taskId, 'phase-changed', task => { task.phase = 'charting' })
      if (this.require(agent, taskId).phase === 'charting') await this.draw(active)
      signal.throwIfAborted()
      if (this.require(agent, taskId).phase === 'composing') this.notify(agent, taskId)
    } catch (error) {
      const wasAborted = signal.aborted
      active.abort.abort()
      await Promise.allSettled(jobs.values())
      if (!wasAborted) this.change(agent, taskId, 'phase-changed', task => {
        task.phase = 'blocked'; task.problem = error instanceof Error ? error.message : String(error)
      })
    }
  }

  private settle(active: Running, queryId: string, receipt: QueryReceipt, recovering = false): void {
    if (active.abort.signal.aborted || terminal(this.require(active.agent, active.taskId))) return
    if (!receipt.terminal) throw new Error('查询尚未提交最终回执。')
    this.change(active.agent, active.taskId, 'attempt-settled', task => {
      const current = task.queries[queryId], attempt = current.attempts.at(-1)!
      attempt.status = 'settled'; attempt.receipt = { ...receipt, terminal: true }
      const retry = receipt.outcome === 'error' && transient(receipt.error) && current.attempts.length < this.config.maxQueryAttempts
      current.status = retry ? (recovering ? 'pending' : 'running') : receipt.outcome
      if (receipt.error) current.reason = receipt.error.message
    })
  }

  private async query(active: Running, query: TaskPlan['queries'][number]): Promise<void> {
    const { agent, taskId, abort: { signal } } = active
    let prompt = query.prompt
    for (const input of query.inputs) {
      const upstream = this.require(agent, taskId).queries[input.query_id].attempts.at(-1)!
      const record = await this.record(agent, upstream.child_id, upstream.receipt!, signal)
      if (input.columns.some(column => !record.columns.some(item => item.name === column))) {
        this.change(agent, taskId, 'query-skipped', task => { task.queries[query.id].status = 'skipped'; task.queries[query.id].reason = '依赖结果缺少计划指定的字段。' }); return
      }
      prompt += `\n\n已验证的依赖输入（查询 ${input.query_id}）：\n${JSON.stringify(record.rows.map(row => Object.fromEntries(input.columns.map(column => [column, row[column]]))))}`
    }
    while (true) {
      signal.throwIfAborted()
      const current = this.require(agent, taskId).queries[query.id]
      const reserved = current.attempts.at(-1)?.status === 'reserved' ? current.attempts.at(-1) : undefined
      const childId = reserved?.child_id ?? randomUUID()
      this.change(agent, taskId, 'attempt-reserved', task => {
        const item = task.queries[query.id]; item.status = 'running'
        if (!reserved) item.attempts.push({ child_id: childId, number: item.attempts.length + 1, prompt, status: 'reserved' })
      })
      let error: Failure | undefined
      try {
        const activation = await this.ctx.subagents.startActivation({ provider: 'spawn', childId: SessionId(childId), label: query.id,
          delivery: 'caller', signal, request: { parent: agent, agentPreset: 'hydrology-query', maxDepth: 1, prompt: [{ type: 'text', text: prompt }] } })
        active.activations.set(childId, activation)
        try {
          signal.throwIfAborted()
          this.change(agent, taskId, 'attempt-running', task => { task.queries[query.id].attempts.at(-1)!.status = 'running' })
          const terminal = await activation.result
          signal.throwIfAborted()
          const result = await readQueryResult(this.ctx, agent.id, SessionId(childId), signal)
          if (!result.receipt) {
            if (terminal.stopReason === 'aborted') throw new QueryError('查询执行已中断。', 'interrupted', 'parent-task')
            throw new Error('查询已结束但没有已提交的最终回执。')
          }
          this.settle(active, query.id, result.receipt)
          error = result.record?.error
        } finally { await activation.dispose(); active.activations.delete(childId) }
      } catch (caught) {
        signal.throwIfAborted()
        error = caught instanceof QueryError ? { code: caught.code, stage: caught.stage, message: caught.message, retryable: caught.retryable }
          : failure(caught instanceof Error ? caught.message : String(caught))
        this.change(agent, taskId, 'attempt-settled', task => {
          const item = task.queries[query.id]
          item.status = transient(error) && item.attempts.length < this.config.maxQueryAttempts ? 'running' : 'error'
          item.reason = error!.message
          Object.assign(item.attempts.at(-1)!, { status: 'settled', error })
        })
      }
      const item = this.require(agent, taskId).queries[query.id]
      if (!transient(error)
        || item.attempts.length >= this.config.maxQueryAttempts) return
      await delay(this.config.retryDelayMs, undefined, { signal })
    }
  }

  private async draw(active: Running): Promise<void> {
    const { agent, taskId, abort: { signal } } = active
    for (const intent of this.require(agent, taskId).plan.charts) {
      if (this.require(agent, taskId).charts.some(chart => chart.intent_id === intent.id)) continue
      signal.throwIfAborted()
      const query = this.require(agent, taskId).queries[intent.query_id], attempt = query.attempts.at(-1)
      const results: ParentTask['charts'] = []
      if (query.status !== 'success' || !attempt?.receipt) results.push({ intent_id: intent.id, status: 'skipped', summary: '查询失败、无数据或依赖已跳过，未生成图表。' })
      else {
        const record = await this.record(agent, attempt.child_id, attempt.receipt, signal)
        signal.throwIfAborted()
        const datasets = presentQuery(record).datasets.filter(dataset => intent.dataset === 'history' || intent.dataset === 'realtime'
          ? dataset.id.startsWith(`${intent.dataset}_`) : dataset.id === intent.dataset)
        if (!datasets.length) results.push({ intent_id: intent.id, status: 'no_data', summary: '没有符合图表意图的数据集。' })
        for (const dataset of datasets) {
          try {
            const chart = renderChart(intent.type, { source_id: `${taskId}:${intent.query_id}:${attempt.receipt.result_ref?.sha256 ?? ''}`,
              dataset_id: dataset.id, title: datasets.length > 1 ? `${intent.title} · ${dataset.title}` : intent.title,
              x_field: intent.x_field, value_field: intent.value_field, ...(intent.series_field ? { series_field: intent.series_field } : {}) }, dataset as ChartDataset)
            results.push({ intent_id: intent.id, status: chart.status, summary: chart.summary, chart })
          } catch (error) { results.push({ intent_id: intent.id, status: 'error', summary: error instanceof Error ? error.message : String(error) }) }
        }
      }
      this.change(agent, taskId, 'chart-settled', task => { task.charts.push(...results) })
    }
    signal.throwIfAborted()
    this.change(agent, taskId, 'phase-changed', task => { task.phase = 'composing' })
  }

  private notify(agent: Agent, taskId: string): void {
    let task = this.require(agent, taskId)
    const recorded = task.wake?.consumed ? undefined : wakeMessage(task)
    if (recorded) {
      if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === recorded.id)) return
    } else {
      const message = createUserMessage({ source: { kind: 'hydrology-task-ready', taskId, reportId: task.report_id }, content: [{ type: 'text',
        text: `水文父任务 ${taskId} 已完成全部查询及绘图。请调用 get_hydrology_query_result({task_id:"${taskId}"}) 读取真实结果，按固定章节撰写完整 Markdown，再调用 publish_hydrology_report 发布。不要把普通回复当作报告发布。` }] })
      task = this.change(agent, taskId, 'wake-prepared', next => { next.wake = { message: JSON.parse(JSON.stringify(message)), consumed: false } })
    }
    agent.followup(wakeMessage(task)!)
  }
}
