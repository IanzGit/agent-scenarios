/** 发布时校验 Markdown 结构和本任务的图表引用。 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { ParentTask } from './task-protocol.ts'

type MarkdownNode = { type: string; value?: unknown; children?: readonly MarkdownNode[] }
const text = (node: MarkdownNode): string => typeof node.value === 'string' ? node.value : node.children?.map(text).join('') ?? ''

/** 只接受齐全的计划章节及本任务成功图表；代码示例不计入引用。 */
export function validateReport(task: ParentTask, markdown: string): void {
  const blocks = fromMarkdown(markdown).children
  if (blocks[0]?.type !== 'heading' || blocks[0].depth !== 1 || text(blocks[0]) !== task.plan.report.title) throw new Error('报告必须从计划中的一级标题开始。')
  let previous = 0
  for (const section of task.plan.report.sections) {
    const index = blocks.findIndex((block, position) => position > previous && block.type === 'heading' && block.depth === 2 && text(block) === section)
    if (index < 0) throw new Error(`报告缺少章节或顺序错误：${section}`)
    const next = blocks.findIndex((block, position) => position > index && block.type === 'heading' && block.depth <= 2)
    if (blocks.slice(index + 1, next < 0 ? undefined : next).length === 0) throw new Error(`报告章节没有正文：${section}`)
    previous = index
  }
  const ids: string[] = []
  for (const block of blocks) {
    if (block.type !== 'paragraph') continue
    const source = markdown.slice(block.position?.start.offset ?? 0, block.position?.end.offset ?? 0)
    for (const line of source.split('\n')) {
      const match = /^ {0,3}\[图表:([A-Za-z0-9_-]+)\][ \t]*$/.exec(line)
      if (match) ids.push(match[1])
    }
  }
  const expected = task.charts.flatMap(item => item.chart?.status === 'rendered' ? [item.chart.chart_id] : [])
  if (new Set(ids).size !== ids.length) throw new Error('同一图表只能引用一次。')
  if (ids.length !== expected.length || ids.some(id => !expected.includes(id))) throw new Error('报告必须恰好引用本任务的全部成功图表，不能引用其他任务或失败图表。')
}
