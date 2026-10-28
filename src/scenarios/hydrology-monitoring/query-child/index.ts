/** 标准 Harness 查询子智能体插件；由独立 preset 装配。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type InferValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Config, resolveSettings, type Settings } from '../config.ts'
import { CubeClient, isObject } from '../client.ts'
import { errorRecord, filterInputIssues, receiptFor, receiptFromMeta, receiptSchema, semanticQuerySchema, type QueryRecord, type QueryReceipt } from '../protocol.ts'
import type {} from '../results.ts'
import { runQuery } from '../query.ts'
import { QUERY_PROMPT } from './prompts.ts'

export { Config }
export const name = 'hydrology-query-child'
export const inject = ['tools', 'systemPrompt', 'hydrologyQueryResults']

/** 所有状态按子 Session 隔离；preset 的多个子智能体共享注册而不共享查询进度。 */
export function apply(ctx: Context, config: Partial<Settings> = {}): void {
  const settings = resolveSettings(config)
  const client = new CubeClient(settings)
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ['search_semantic_catalog', 'run_semantic_query'] })
  })
  ctx.tools.presentAs('native')
  ctx.systemPrompt.section({ name: 'hydrology-query:rules', order: 100, text: `${QUERY_PROMPT}\n查询时区：${settings.timezone}。` })
  const state = new WeakMap<Session, { searched: boolean; terminal: boolean; steps: number }>()
  const progress = (session: Session) => {
    let current = state.get(session)
    if (!current) {
      current = { searched: false, terminal: false, steps: 0 }
      const calls = new Set<string>()
      for (const event of session.ownEvents()) {
        if (event.type === 'step/start') current.steps++
        if (event.type === 'tool/call' && ['search_semantic_catalog', 'run_semantic_query'].includes(event.data.name)) calls.add(event.data.callId)
        if (event.type !== 'tool/result' || event.data.message.isError || !calls.has(event.data.message.toolCallId)) continue
        const meta = event.data.meta
        if (isObject(meta) && isObject(meta.hydrologyCatalog) && meta.hydrologyCatalog.version === 1 && meta.hydrologyCatalog.details_loaded === true) current.searched = true
        if (receiptFromMeta(meta)?.terminal) current.terminal = true
      }
      state.set(session, current)
    }
    return current
  }
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const current = progress(agent.session)
    if (current.terminal || current.steps >= settings.maxAgentIterations) return { kind: 'reject' }
    current.steps++
    return next()
  })
  ctx.tools.guard(exec => {
    if (!exec.agent) return '查询工具只能由查询子智能体调用。'
    const current = progress(exec.agent.session)
    if (current.terminal) return '当前查询任务已经结束，请为新的查询创建子智能体。'
    if (exec.name === 'run_semantic_query' && !current.searched) return '必须先调用 search_semantic_catalog 加载模型详情。'
    return undefined
  })
  const metadata = (_args: object, value: InferValue<{ type: 'json' }>): InferValue<{ type: 'json' }> => {
    if (isObject(value) && value.version === 2) return { hydrologyQuery: value as QueryReceipt }
    return { hydrologyCatalog: { version: 1, details_loaded: isObject(value) && value.kind === 'catalog_details' } }
  }
  const finish = async (record: QueryRecord, exec: ToolRunContext): Promise<QueryReceipt> => {
    let receipt = receiptFor(record)
    if (record.terminal) {
      try { receipt = receiptFor(record, await ctx.hydrologyQueryResults.save(exec, record)) }
      catch (error) { exec.signal.throwIfAborted(); receipt = receiptFor(errorRecord(error, record.query_goal)) }
      exec.concludeTurn()
    }
    return receipt
  }
  ctx.tools.register(defineTool({
    name: 'search_semantic_catalog',
    description: '完整目录模式：不传 model_names 查看公开模型摘要；传入覆盖当前任务的模型名称加载完整成员及语义约束。详情不是查询成员白名单。',
    parameters: { model_names: { type: 'array', items: { type: 'string' }, description: '首次可省略以查看摘要；之后传入需要加载详情的公开模型名称。' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], presentationMeta: metadata },
    async execute(args, exec): Promise<InferValue<{ type: 'json' }>> {
      try {
        const catalog = await client.catalog(exec.signal)
        const models = args.model_names?.length ? args.model_names.map(name => {
          const model = catalog.get(name)
          if (!model) throw new Error(`未知公开模型：${name}`)
          return model
        }) : [...catalog.values()]
        return { kind: args.model_names?.length ? 'catalog_details' : 'catalog_summary',
          models: models.map(model => ({ name: model.name, title: model.title, type: model.type,
            description: model.description, meta: JSON.parse(JSON.stringify(model.meta)),
            connected_component: model.connectedComponent ?? null, default_projection: model.defaultProjection,
            ...(args.model_names?.length ? { members: [...model.members.values()].map(member => ({ ...member, meta: JSON.parse(JSON.stringify(member.meta)) })) } : {}),
          })) }
      } catch (error) {
        exec.signal.throwIfAborted()
        if (error instanceof Error && error.message.startsWith('未知公开模型：')) return { kind: 'catalog_error', message: error.message, terminal: false }
        return finish(errorRecord(error, '读取语义目录'), exec)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'run_semantic_query', description: '校验明细 SemanticQuery，先调用 Cube /sql 预检再调用 /load。一次任务只有一次最终成功或无数据查询，不接受 SQL。',
    parameters: { query_goal: { type: 'string', required: true, description: '完整、独立的当前查询小任务，包含全部对象、条件、时间及所需字段。' },
      semantic_query: { ...semanticQuerySchema, required: true } },
    output: { schema: receiptSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], presentationMeta: metadata },
    finalizeContent(exec, result) {
      if (!result.isError || result.error.info?.code !== 'INVALID_ARGS' || !isObject(exec.arguments)) return undefined
      const issues = filterInputIssues(exec.arguments.semantic_query)
      return issues.length ? [...result.content, { type: 'text', text: JSON.stringify({ issues, example: { member: 'model.member', operator: 'equals', values: ['实际值'] }, instruction: '仅修正上述字段路径，完整重发 semantic_query 对象，保留日期、对象、地点、排除条件及 AND/OR 关系。' }) }] : undefined
    },
    async execute(args, exec) {
      let record
      try { record = await runQuery(client, args.semantic_query, args.query_goal, exec.signal) }
      catch (error) { exec.signal.throwIfAborted(); record = errorRecord(error, args.query_goal) }
      return finish(record, exec)
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    if (result.isError || !exec.agent || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return
    const current = progress(exec.agent.session)
    if (exec.name === 'search_semantic_catalog' && result.value.kind === 'catalog_details') current.searched = true
    if (result.value.terminal === true) current.terminal = true
  })
}
