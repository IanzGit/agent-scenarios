import test from 'node:test'
import assert from 'node:assert/strict'
import { renderResult, result, table } from '../src/result.ts'

test('Markdown 保留全部350条明细，不截断或使用省略号', () => {
  const rows = Array.from({ length: 350 }, (_, index) => ({ 编号: index + 1, 阈值: '0 / 5.7000 / 未取得 / 5.9' }))
  const original = result('报警', '报警350条', [table('报警明细', ['编号', '阈值'], rows)])
  const content = renderResult({}, original)[0].text
  assert.equal(content.split('\n').filter(line => /^\| \d+ \|/.test(line)).length, 350)
  assert.match(content, /\| 350 \| 0 \/ 5.7000 \/ 未取得 \/ 5.9 \|/)
  assert.equal(content.includes('...'), false)
})

test('表格正确处理换行、分隔符及 HTML，数值显示两位但不修改原值', () => {
  const source = result('报告', '摘要', [table('明细', ['名称', '数值', '空值'], [{ 名称: 'A|B\n<script>_*', 数值: 1.234567, 空值: null }])])
  const content = renderResult({}, source)[0].text
  assert.match(content, /A&#124;B<br>&lt;script&gt;&#95;&#42;/)
  assert.match(content, /\| 1.23 \| — \|/)
  assert.equal(content.includes('<script>'), false)
  assert.equal(source.tables[0].rows[0].数值, 1.234567)
})

test('空表保留标题并明确说明无记录', () => {
  assert.equal(renderResult({}, result('报警', '最近30天无测点报警事件。', [table('超限报警表', ['预警指标'], [])]))[0].text,
    '最近30天无测点报警事件。\n\n### 超限报警表\n\n无记录。')
})

test('chartOnly 表格保留结构化数据但不进入模型文本', () => {
  const source = result('统计', '摘要', [
    table('展示表', ['名称'], [{ 名称: 'a' }]),
    table('按类型统计', ['预警类型', '事件数量'], [{ 预警类型: '涌水量', 事件数量: 7 }], true),
  ])
  const content = renderResult({}, source)[0].text
  assert.match(content, /### 展示表/)
  assert.equal(content.includes('按类型统计'), false)
  assert.equal(content.includes('涌水量'), false)
  assert.equal(source.tables.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(source)), source)
})
