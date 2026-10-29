/** 公开语义目录、成员类型与解析。 */
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

