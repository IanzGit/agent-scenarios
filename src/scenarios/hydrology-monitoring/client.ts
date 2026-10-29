/** Cube HTTP 客户端与公开语义目录解析。 */
import { setTimeout } from 'node:timers/promises'
import type { Settings } from './config.ts'
import { QueryError } from './protocol.ts'

export type Member = { name: string; title: string; type: string; kind: 'dimension' | 'measure' | 'segment'; meta: Record<string, unknown>; primaryKey: boolean; description: string; granularities: string[] }
export type Model = { name: string; title: string; type: 'view' | 'cube'; description: string; meta: Record<string, unknown>; connectedComponent?: string | number; defaultProjection: string[]; members: Map<string, Member> }
export type Catalog = Map<string, Model>

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** 只读取 /meta 声明的公开模型、成员、连接组件和默认投影。 */
export function parseCatalog(payload: Record<string, unknown>): Catalog {
  if (!Array.isArray(payload.cubes)) throw new QueryError('Cube /meta 缺少 cubes 列表。', 'invalid_catalog', 'catalog')
  const models: Catalog = new Map()
  for (const raw of payload.cubes) {
    if (!isObject(raw) || raw.public === false || !['view', 'cube'].includes(String(raw.type))) continue
    if (typeof raw.name !== 'string' || !raw.name || models.has(raw.name)) throw new QueryError('公开模型名称缺失或重复。', 'invalid_catalog', 'catalog')
    const meta = isObject(raw.meta) ? raw.meta : {}
    const members = new Map<string, Member>()
    for (const [group, kind] of [['dimensions', 'dimension'], ['measures', 'measure'], ['segments', 'segment']] as const) {
      const list = raw[group]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (!isObject(item) || item.public === false) continue
        if (typeof item.name !== 'string' || !item.name.startsWith(`${raw.name}.`) || members.has(item.name)) throw new QueryError('语义成员名称无效或重复。', 'invalid_catalog', 'catalog')
        members.set(item.name, { name: item.name, title: String(item.shortTitle ?? item.title ?? item.name),
          type: String(item.type ?? 'string'), kind, primaryKey: item.primaryKey === true,
          description: String(item.description ?? ''), meta: isObject(item.meta) ? item.meta : {},
          granularities: Array.isArray(item.granularities) ? item.granularities.flatMap(value => typeof value === 'string' ? [value] : isObject(value) && typeof value.name === 'string' ? [value.name] : []) : [],
        })
      }
    }
    const projection = strings(meta.default_projection).map(name => name.includes('.') ? name : `${raw.name}.${name}`)
    if (new Set(projection).size !== projection.length || projection.some(name => members.get(name)?.kind !== 'dimension')) throw new QueryError('default_projection 包含重复、非公开或非维度成员。', 'invalid_catalog', 'catalog')
    models.set(raw.name, { name: raw.name, title: String(raw.title ?? raw.name), type: raw.type as Model['type'],
      description: String(raw.description ?? ''), meta, members, defaultProjection: projection,
      ...(typeof raw.connectedComponent === 'string' || typeof raw.connectedComponent === 'number' ? { connectedComponent: raw.connectedComponent } : {}),
    })
  }
  if (!models.size) throw new QueryError('Cube 目录没有受治理的公开模型。', 'empty_catalog', 'catalog')
  return models
}

export class CubeClient {
  private cached?: { expires: number; catalog: Catalog }
  constructor(readonly settings: Settings) {}

  private safeMessage(message: string): string {
    const redacted = this.settings.cubeToken ? message.replaceAll(this.settings.cubeToken, '<redacted>') : message
    return redacted.replace(/https?:\/\/[^\s,}]+/gi, '<cube>').replace(/(authorization["\s:=]+)[^,}\s]+/gi, '$1<redacted>').slice(0, 1000)
  }

  /** 用调用方取消信号和独立请求超时覆盖取响应体的整个过程。 */
  private async request(path: string, query: object | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(this.settings.timeoutSeconds * 1000))])
    try {
      const response = await fetch(`${this.settings.cubeUrl}${path}`, {
        method: query ? 'POST' : 'GET', signal: requestSignal,
        headers: { ...(this.settings.cubeToken ? { Authorization: this.settings.cubeToken } : {}), ...(query ? { 'Content-Type': 'application/json' } : {}) },
        ...(query ? { body: JSON.stringify({ query }) } : {}),
      })
      if (!response.ok) {
        const detail = response.status === 400 ? this.safeMessage(await response.text()) : ''
        if (response.status !== 400) await response.body?.cancel()
        throw new QueryError(response.status === 401 || response.status === 403 ? 'Cube 认证失败。' : `Cube HTTP ${response.status}：${detail}`,
          response.status === 401 || response.status === 403 ? 'cube_auth_error' : response.status >= 500 ? 'cube_server_error' : 'cube_http_error', path, response.status === 400)
      }
      let payload: unknown
      try { payload = await response.json() } catch (error) {
        if (requestSignal.aborted) throw error
        throw new QueryError('Cube 返回非 JSON 响应。', 'cube_invalid_response', path)
      }
      if (!isObject(payload)) throw new QueryError('Cube 响应必须为 JSON 对象。', 'cube_invalid_response', path)
      return payload
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof QueryError) throw error
      throw new QueryError(requestSignal.aborted ? '连接 Cube 超时。' : 'Cube 网络请求失败。', requestSignal.aborted ? 'cube_timeout' : 'cube_network_error', path)
    }
  }

  async catalog(signal: AbortSignal): Promise<Catalog> {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.catalog
    const catalog = parseCatalog(await this.request('/meta', undefined, signal))
    this.cached = { expires: Date.now() + this.settings.metaCacheTtlSeconds * 1000, catalog }
    return catalog
  }

  async query(path: '/sql' | '/load', query: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt <= this.settings.continueWaitRetries; attempt++) {
      const payload = await this.request(path, query, signal)
      if (payload.error === 'Continue wait') {
        if (attempt === this.settings.continueWaitRetries) break
        await setTimeout(this.settings.continueWaitDelaySeconds * 1000, undefined, { signal })
        continue
      }
      if (payload.error) throw new QueryError(`Cube 拒绝该语义查询：${this.safeMessage(String(payload.error))}`, 'cube_response_error', path, true)
      if (path === '/sql') {
        const sql = isObject(payload.sql) ? payload.sql.sql : payload.sql
        if (!(typeof sql === 'string' && sql.trim()) && !(Array.isArray(sql) && sql.length === 2 && typeof sql[0] === 'string' && sql[0].trim() && Array.isArray(sql[1]))) throw new QueryError('Cube /sql 缺少有效编译结果。', 'cube_invalid_response', path)
      }
      return payload
    }
    throw new QueryError('Cube Continue wait 重试耗尽。', 'cube_continue_wait_exhausted', path)
  }
}
