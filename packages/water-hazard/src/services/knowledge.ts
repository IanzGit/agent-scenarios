/** 本地文档全文检索；标签、原文和来源均来自原知识库的 doc_chunks。 */
import { result, table, type Row } from 'dsh-agent-shared'
import { asset } from '../infrastructure/assets.ts'
import { SYNONYMS } from '../domain/constants.ts'

export type Document = { id: string; content: string; source: string; tags: string[]; metadata: Record<string, string | number | boolean | null> }
const documents = JSON.parse(asset('knowledge.json')) as Document[]
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
function tokens(value: string): string[] {
  return [...segmenter.segment(value.toLowerCase())].filter(segment => segment.isWordLike).map(segment => segment.segment)
}
const indexed = documents.map(document => {
  const words = tokens(`${document.content} ${document.tags.join(' ')} ${document.source}`)
  const counts = new Map<string, number>()
  words.forEach(word => counts.set(word, (counts.get(word) ?? 0) + 1))
  return { document, counts, length: words.length }
})
export function searchDocuments(query: string, limit: number, tags: string[], workface = ''): Document[] {
  if (!query.trim()) throw new Error('query 不能为空')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('n_chunks 必须为1至100的整数')
  const variants = [query]
  for (const [word, alternatives] of Object.entries(SYNONYMS)) if (query.includes(word)) variants.push(...alternatives.map(alternative => query.replaceAll(word, alternative)))
  const terms = [...new Set(variants.flatMap(tokens))]
  const pool = indexed.filter(item => tags.every(tag => item.document.tags.includes(tag)))
  const average = pool.reduce((sum, item) => sum + item.length, 0) / (pool.length || 1)
  const frequencies = new Map(terms.map(term => [term, pool.filter(item => item.counts.has(term)).length]))
  return pool.map(item => ({ ...item, score: terms.reduce((score, term) => {
    const count = item.counts.get(term) ?? 0, frequency = frequencies.get(term) ?? 0
    return score + Math.log(1 + (pool.length - frequency + 0.5) / (frequency + 0.5)) * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * item.length / average))
  }, 0) })).filter(item => item.score > 0 && (!workface || String(item.document.metadata.预测水害地点 ?? item.document.metadata.location ?? item.document.content.match(/(?:^|\n)\s*(?:预测水害地点[：:]\s*)?([0-9]{4,5})工作面/)?.[1] ?? '').startsWith(workface)))
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id)).slice(0, limit).map(item => item.document)
}
export function documentEvidence(docs: Document[], label: string, maxCharacters: number): string {
  return docs.map((doc, i) => `【${label}${i + 1}｜${doc.source}】\n${doc.content.slice(0, maxCharacters)}`).join('\n\n')
}

const columns = ['水害类型', '预计时间', '预计地点', '水害评估', '处理建议']
/** 原按工作面模糊去重规则；同源不同条目保留给后续预计地点合并。 */
export function fuzzyDedup(docs: Document[]): Document[] {
  const seen = new Map<string, number>(), output: (Document | null)[] = [...docs]
  docs.forEach((document, i) => {
    const place = String(document.metadata.location ?? document.metadata.预测水害地点 ?? document.content.match(/^\d{4,5}/)?.[0] ?? document.content.slice(0, 80))
    const key = place.match(/^\d{4,5}/)?.[0] ?? place
    if (!seen.has(key)) { seen.set(key, i); return }
    const existingIndex = seen.get(key)!, existing = output[existingIndex]
    if (!existing) { seen.set(key, i); return }
    if (document.source === existing.source) return
    if (document.content === existing.content) { output[i] = null; return }
    if (document.metadata.data_type === 'tabular' && existing.metadata.data_type !== 'tabular') { output[existingIndex] = null; seen.set(key, i); return }
    if (existing.metadata.data_type === 'tabular' && document.metadata.data_type !== 'tabular') return
    if (document.content.length > existing.content.length) { output[existingIndex] = document; seen.set(key, i); output[i] = null }
  })
  return output.filter((document): document is Document => document !== null)
}
export function summarizeDocuments(docs: Document[]) {
  const groups: Record<'掘进' | '回采', Row[]> = { 掘进: [], 回采: [] }
  const sources = new Set<string>()
  for (const doc of fuzzyDedup(docs)) {
    const group = /回采|综采/.test(doc.content) ? '回采' : /掘进|开拓/.test(doc.content) ? '掘进' : undefined
    if (!group) continue
    const fields = new Map(doc.content.split('\n').map(line => { const pos = line.indexOf(':'); return [line.slice(0, pos).trim(), line.slice(pos + 1).trim()] }))
    const field = (key: string) => String(doc.metadata[key] ?? fields.get(key) ?? '未提供')
    const assessment = field('水文地质简述')
    const flow = assessment.match(/预计正常涌水量[\s\S]*?(?:。|$)/)?.[0] ?? assessment
    groups[group].push({ 水害类型: field('水害类型'), 预计时间: field('采掘时间'), 预计地点: field('预测水害地点'), 水害评估: flow, 处理建议: field('预防及处理意见') })
    sources.add(doc.source)
  }
  function risk(row: Row): number[] {
    const risk = String(row.处理建议).match(/突水危险\s*([^\s，。；.\n\d]+)/)?.[1] ?? ''
    const ranks: Record<string, number> = { 高: 3, 较高: 3, 中等: 2, 低: 1, 较低: 1 }
    const flow = (kind: string) => Number(String(row.水害评估).match(new RegExp(`${kind}涌水量[约]?[为]?\\s*(\\d+\\.?\\d*)`))?.[1] ?? 0)
    return [ranks[risk] ?? 0, flow('最大'), flow('正常')]
  }
  for (const group of ['掘进', '回采'] as const) {
    const places = new Map<string, Row>()
    for (const row of groups[group]) {
      const place = String(row.预计地点), existing = places.get(place)
      if (!existing) { places.set(place, row); continue }
      existing.水害类型 = [...new Set(`${existing.水害类型}、${row.水害类型}`.split('、').map(value => value.trim()).filter(Boolean))].sort().join('、')
      for (const field of ['预计时间', '水害评估', '处理建议']) if (existing[field] === '未提供' && row[field] !== '未提供') existing[field] = row[field]
    }
    groups[group] = [...places.values()]
  }
  const tables = (['掘进', '回采'] as const).map(group => table(`${group}水害重点分析表`, columns, groups[group].sort((a, b) => {
    const x = risk(a), y = risk(b)
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  })))
  return result('近期水害重点分析', `掘进水害报告${groups.掘进.length}份，回采水害报告${groups.回采.length}份，共${groups.掘进.length + groups.回采.length}份。\n资料来源：${[...sources].join('、') || '无命中资料'}。资料年份和月份以来源为准，不代表当前查询周期的新发布预报。`, tables)
}
export function reportSummary(query: string, nChunks = 30) {
  return summarizeDocuments(searchDocuments(query, nChunks, ['水害分析预报表']))
}
