/** 仅识别独立段落中的图表引用；代码示例保持原样。 */
export type ResponsePart = { kind: 'text'; text: string; key: number } | { kind: 'chart'; id: string; key: number } | { kind: 'pending'; key: number }

export function chartReferences(text: string, streaming = false): ResponsePart[] {
  const parts: ResponsePart[] = []
  const seen = new Set<string>()
  let fence: string | undefined, fenceLength = 0, start = 0, offset = 0
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) { fence = delimiter[1][0]; fenceLength = delimiter[1].length }
      else if (delimiter[1][0] === fence && delimiter[1].length >= fenceLength && !line.slice(delimiter[0].length).trim()) fence = undefined
    } else if (!fence && !/^(?: {4}|\t)/.test(line)) {
      const match = line.match(/^ {0,3}\[图表:([A-Za-z0-9_-]+)\][ \t]*\r?\n?$/)
      const pending = streaming && offset + line.length === text.length && /^ {0,3}\[图表(?::[A-Za-z0-9_-]*)?$/.test(line)
      if (match || pending) {
        if (offset > start) parts.push({ kind: 'text', text: text.slice(start, offset), key: start })
        if (match && !seen.has(match[1])) { parts.push({ kind: 'chart', id: match[1], key: offset }); seen.add(match[1]) }
        else if (pending) parts.push({ kind: 'pending', key: offset })
        start = offset + line.length
      }
    }
    offset += line.length
  }
  if (start < text.length) parts.push({ kind: 'text', text: text.slice(start), key: start })
  return parts
}
