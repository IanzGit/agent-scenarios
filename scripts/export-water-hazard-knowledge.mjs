/** 从原 Chroma SQLite 只读导出文档；运行期只读取随包发布的 JSON。 */
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const [databasePath, destination = 'packages/water-hazard/assets/knowledge.json'] = process.argv.slice(2)
if (!databasePath) throw new Error('用法：node scripts/export-water-hazard-knowledge.mjs <chroma.sqlite3> [knowledge.json]')
const database = new DatabaseSync(resolve(databasePath), { readOnly: true })
try {
  const records = database.prepare(`SELECT e.embedding_id, m.key, m.string_value, m.int_value, m.float_value, m.bool_value
    FROM embeddings e JOIN segments s ON s.id=e.segment_id JOIN collections c ON c.id=s.collection
    JOIN embedding_metadata m ON m.id=e.id WHERE c.name='doc_chunks' ORDER BY e.id,m.key`).all()
  const documents = new Map()
  for (const record of records) {
    const document = documents.get(record.embedding_id) ?? { id: record.embedding_id, content: '', source: '', tags: [], metadata: {} }
    const value = record.string_value ?? record.int_value ?? record.float_value ?? (record.bool_value == null ? null : Boolean(record.bool_value))
    if (record.key === 'chroma:document') document.content = String(value)
    else if (record.key === 'source') document.source = basename(String(value))
    else if (record.key.startsWith('tag_')) { if (value) document.tags.push(record.key.slice(4)) }
    else document.metadata[record.key] = value
    documents.set(document.id, document)
  }
  const values = [...documents.values()]
  if (!values.length || values.some(document => !document.content || !document.source)) throw new Error('知识库无有效文档或缺少正文、来源')
  writeFileSync(destination, JSON.stringify(values, null, 2) + '\n')
  console.log(`已导出 ${values.length} 条 doc_chunks 文档到 ${destination}`)
} finally { database.close() }
