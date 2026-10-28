/** 独立结果文件的标准 Host 服务，记录引用随工具结果持久化。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { constants } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isObject } from './client.ts'
import { parseRecord, QueryError, receiptFromMeta, type QueryRecord, type ResultRef } from './protocol.ts'

declare module '@deepseek-ai/cordis' { interface Context { hydrologyQueryResults: QueryResults } }

export interface Config { resultsDirectory?: string }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** Host 拥有文件生命周期，preset 只负责写入和读取已授权子会话的结果。 */
export default class QueryResults extends Service {
  static inject = ['tools']
  static Config: z<Config> = z.object({ resultsDirectory: z.string() })
  readonly directory: string
  private pending = new Map<ToolExecutionToken, { owner: SessionId; ref: ResultRef }>()
  private operations = new Set<Promise<unknown>>()
  private closing = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'hydrologyQueryResults')
    const configured = config.resultsDirectory ?? process.env.HYDROLOGY_SEMANTIC_QUERY_RESULTS_DIRECTORY
    if (configured !== undefined && !configured.trim()) throw new Error('结果目录不能为空。')
    this.directory = resolve(configured ?? dshHomePath('storages', 'hydrology-query-results'))
    ctx.on('tools/result', (exec, result) => {
      const staged = this.pending.get(exec.token)
      if (!staged) return
      this.pending.delete(exec.token)
      const receipt = result.isError ? undefined : receiptFromMeta(result.meta)
      if (receipt?.result_ref?.id !== staged.ref.id) {
        const cleanup = this.remove(staged.owner, staged.ref).catch(error => { ctx.logger.warn(`清理未提交的水文查询结果失败：${String(error)}`) })
        void this.track(cleanup)
      }
    })
    ctx.effect(() => async () => {
      this.closing = true
      while (this.operations.size) await Promise.allSettled([...this.operations])
      await Promise.all([...this.pending.values()].map(entry => this.remove(entry.owner, entry.ref)))
      this.pending.clear()
    })
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  private path(owner: SessionId, ref: ResultRef): string {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.id)) throw new QueryError('结果引用无效，请重新查询。', 'result_invalid_reference', 'result_read')
    return join(this.directory, hash(owner), `${ref.id}.json`)
  }

  private async remove(owner: SessionId, ref: ResultRef): Promise<void> {
    try { await unlink(this.path(owner, ref)) } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error
    }
  }

  /** 先完成原子写入，再交给工具最终结果决定是否保留。 */
  save(exec: ToolRunContext, record: QueryRecord): Promise<ResultRef> {
    if (this.closing) return Promise.reject(new QueryError('结果服务正在关闭。', 'result_write_failed', 'result_write'))
    return this.track(this.write(exec, record))
  }

  private async write(exec: ToolRunContext, record: QueryRecord): Promise<ResultRef> {
    if (!exec.agent) throw new QueryError('查询结果缺少所属会话。', 'result_write_failed', 'result_write')
    const owner = exec.agent.id
    const data = JSON.stringify({ version: 1, owner_session_id: owner, parent_session_id: exec.agent.session.header.parentSession ?? null, record })
    const ref: ResultRef = { id: randomUUID(), bytes: Buffer.byteLength(data), sha256: hash(data) }
    const path = this.path(owner, ref), temporary = `${path}.tmp`
    let renamed = false
    try {
      exec.signal.throwIfAborted()
      await mkdir(join(this.directory, hash(owner)), { recursive: true, mode: 0o700 })
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(data, { signal: exec.signal }); await handle.sync() } finally { await handle.close() }
      exec.signal.throwIfAborted()
      await rename(temporary, path)
      renamed = true
      exec.signal.throwIfAborted()
      this.pending.set(exec.token, { owner, ref })
      return ref
    } catch (error) {
      try { await unlink(renamed ? path : temporary) } catch (cleanupError) {
        if (!isObject(cleanupError) || cleanupError.code !== 'ENOENT') this.ctx.logger.warn(`清理水文结果临时文件失败：${String(cleanupError)}`)
      }
      exec.signal.throwIfAborted()
      this.ctx.logger.warn(`保存水文查询结果失败：${String(error)}`)
      throw new QueryError('完整查询结果保存失败，请检查结果目录后重新查询。', 'result_write_failed', 'result_write')
    }
  }

  /** 已验证父子关系的读取方仍须检查文件摘要、归属和完整记录。 */
  async read(owner: SessionId, parent: SessionId, ref: ResultRef, signal: AbortSignal): Promise<QueryRecord> {
    let data: Buffer
    try {
      const handle = await open(this.path(owner, ref), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { data = await handle.readFile({ signal }) } finally { await handle.close() }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof QueryError) throw error
      throw new QueryError('完整查询结果文件不可用，请重新查询。', 'result_file_unavailable', 'result_read')
    }
    if (data.length !== ref.bytes || hash(data) !== ref.sha256) throw new QueryError('查询结果文件不完整或已损坏，请重新查询。', 'result_integrity_error', 'result_read')
    try {
      const envelope: unknown = JSON.parse(data.toString('utf8'))
      if (!isObject(envelope) || envelope.version !== 1 || envelope.owner_session_id !== owner || envelope.parent_session_id !== parent) throw new Error('结果文件归属不匹配。')
      return parseRecord(envelope.record)
    } catch (error) {
      this.ctx.logger.warn(`水文结果文件校验失败：${String(error)}`)
      throw new QueryError('查询结果文件格式或归属无效，请重新查询。', 'result_invalid_record', 'result_read')
    }
  }
}
