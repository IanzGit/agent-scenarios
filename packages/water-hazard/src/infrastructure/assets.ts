/** 随包发布的静态数据；解析支持 CSV 的引号、换行与逗号字段。 */
import { readFileSync } from 'node:fs'

export function asset(name: string): string {
  return readFileSync(new URL(`../../assets/${name}`, import.meta.url), 'utf8').replace(/^\uFEFF/, '')
}
export function csv(name: string): Record<string, string>[] {
  const records: string[][] = []
  let row: string[] = [], value = '', quoted = false
  const input = asset(name)
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index++ } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(value.replace(/\r$/, '')); value = ''
      if (char === '\n') { records.push(row); row = [] }
    } else value += char
  }
  if (value || row.length) { row.push(value.replace(/\r$/, '')); records.push(row) }
  const headers = records.shift() ?? []
  return records.filter(row => row.some(Boolean)).map(row => Object.fromEntries(headers.map((key, index) => [key, row[index] ?? ''])))
}
