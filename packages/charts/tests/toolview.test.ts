/** 用实际浏览器产物验证注册、SSR 状态及旧元数据，不导入 Host 实现到 Client。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import type { ReactElement } from 'react'
import type { ToolCallPhaseProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { CHART_TOOL_NAMES } from '../src/tools/index.ts'
import { chartReferences } from '../src/client/chart-references.ts'

const require = createRequire(import.meta.url)
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup(element: ReactElement): string }
type Call = ToolCallPhaseProps & { callId: string; toolName: string }
type Entry = { key: string; name: string; component: (props: unknown) => ReactElement }

async function client() {
  const entries = new Map<string, Entry>()
  const disposers: (() => void)[] = []
  const styles: { textContent: string; remove: () => void }[] = []
  let loaded: { id: string; factory: (require: (name: string) => unknown) => { inject: string[]; apply: (ctx: unknown) => void } } | undefined
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    navigator: { userAgent: 'Node.js' },
    window: { __ModuleLoader__: { load(value: typeof loaded) { loaded = value } } },
    document: {
      createElement: () => ({ textContent: '', remove() { styles.splice(styles.indexOf(this), 1) } }),
      head: { append: (style: typeof styles[number]) => { styles.push(style) } },
    },
  })
  assert.ok(loaded)
  assert.equal(loaded.id, 'dsh-agent-charts')
  const plugin = loaded.factory(name => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: (props: { text: string }) => require('react').createElement('p', { 'data-native-markdown': true }, props.text) }
    assert.ok(['react', 'react/jsx-runtime'].includes(name), `Client 不应依赖 Host 模块：${name}`)
    return require(name)
  })
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'uiConversation'])
  plugin.apply({
    uiConversation: { events: { register: () => undefined } },
    slots: {
      inject(name: string, setup: () => Iterable<() => void> | (() => void)) {
        assert.ok(['tool.call.toolview', 'conversation.chat.response.body'].includes(name))
        const result = setup()
        disposers.push(...(typeof result === 'function' ? [result] : result))
      },
      register(spec: Omit<Entry, 'component'>, component: Entry['component']) {
        assert.ok(['tool.call.toolview', 'conversation.chat.response.body'].includes(spec.name))
        const key = spec.key ?? spec.name
        entries.set(key, { ...spec, component })
        return () => { entries.delete(key) }
      },
    },
    effect(effect: () => () => void) { disposers.push(effect()) },
  })
  return { entries, styles, dispose: () => { for (const dispose of disposers.toReversed()) dispose() } }
}

const call = (stage: ToolCallPhaseProps): Call => ({ toolName: 'render_line_chart', callId: 'line-call', ...stage })
const head = { callId: 'line-call', name: 'render_line_chart', turn: 1, step: 1, time: 0, subCalls: [] }
const settled = (overrides: Partial<Extract<ToolCallPhaseProps, { phase: 'result' }>['block']> = {}): ToolCallPhaseProps => ({
  phase: 'result',
  block: { kind: 'tool-result', seq: 2, time: 1, callId: 'line-call', name: 'render_line_chart',
    args: PartialArguments.fromObject({ title: '原始标题' }), call: { name: 'render_line_chart', argsRaw: '{"title":"原始标题"}' },
    callTime: 0, content: [], isError: false, subCalls: [], ...overrides },
})
const meta = { agentScenariosChart: { version: 1, chart: {
  chart_id: 'legacy-chart', chart_type: 'line', title: '持久化标题', status: 'rendered', summary: '2条有效记录，单位：m。',
  source_id: 'expired-source', dataset_id: 'inflow',
  option: { series: [{ type: 'line', data: [['2026-08-01', 1.234567], ['2026-08-02', null]] }] },
} } }

test('五个 wire 名称注册同一摘要卡片，正文使用独立插槽，卸载释放注册和样式', async () => {
  const fixture = await client()
  assert.deepEqual([...fixture.entries.keys()].filter(key => key.startsWith('render_')), CHART_TOOL_NAMES)
  assert.equal(new Set([...fixture.entries.values()].filter(entry => entry.name === 'tool.call.toolview').map(entry => entry.component)).size, 1)
  assert.equal(fixture.styles.length, 1)
  assert.ok(fixture.styles[0].textContent.includes('.agent-scenarios-chart-call'))
  fixture.dispose()
  assert.equal(fixture.entries.size, 0)
  assert.equal(fixture.styles.length, 0)
})

test('准备阶段容忍不完整参数，并读取同一参数对象的新标题；执行阶段不提前渲染元数据', async () => {
  const fixture = await client()
  try {
    const render = (stage: ToolCallPhaseProps) => renderToStaticMarkup(fixture.entries.get('render_line_chart')!.component(call(stage)))
    const args = new PartialArguments()
    args.append('{"title":"水')
    const block = { ...head, phase: 'preparing' as const, args }
    assert.match(render({ phase: 'preparing', block }), /准备绘图/)
    args.append('位趋势"')
    assert.match(render({ phase: 'preparing', block }), /水位趋势/)
    const running = render({ phase: 'start', block: { ...head, phase: 'start', args: args.settle('{"title":"水位趋势"}'), argsRaw: '{"title":"水位趋势"}' } })
    assert.match(running, /正在生成图表/)
    assert.doesNotMatch(running, /data-chart-id/)
  } finally { fixture.dispose() }
})

test('工具调用只展示状态和摘要；成功、失败及取消均不重复展示正文图表', async () => {
  const fixture = await client()
  try {
    const render = (stage: ToolCallPhaseProps) => renderToStaticMarkup(fixture.entries.get('render_line_chart')!.component(call(stage)))
    const success = render(settled({ meta }))
    assert.match(success, /已完成/)
    assert.match(success, /持久化标题/)
    assert.doesNotMatch(success, /data-chart-id/)
    assert.doesNotMatch(success, /<details|expired-source/)
    assert.equal(render(settled({ meta: JSON.parse(JSON.stringify(meta)) })), success)
    for (const reason of ['来源已过期', '调用已取消']) {
      const error = render(settled({ meta, isError: true, content: [{ type: 'text', text: reason }] }))
      assert.match(error, /生成失败/)
      assert.ok(error.includes(reason))
      assert.doesNotMatch(error, /data-chart-id/)
    }
  } finally { fixture.dispose() }
})

test('空数据及缺失、非法或不支持的元数据保留完成状态和原始文本，不造成回放异常', async () => {
  const fixture = await client()
  try {
    const component = fixture.entries.get('render_line_chart')!.component
    for (const metadata of [
      undefined, null, {},
      { agentScenariosChart: { version: 1, chart: {} } },
      { agentScenariosChart: { ...meta.agentScenariosChart, version: 2 } },
      { agentScenariosChart: { version: 1, chart: { ...meta.agentScenariosChart.chart, summary: { invalid: true } } } },
      { agentScenariosChart: { version: 1, chart: { ...meta.agentScenariosChart.chart, option: { series: 'invalid' } } } },
    ]) {
      const html = renderToStaticMarkup(component(call(settled({ meta: metadata, content: [{ type: 'text', text: '没有可绘图的有效数值；状态：no_data' }] }))))
      assert.match(html, /已完成/)
      assert.match(html, /没有可绘图的有效数值/)
      assert.doesNotMatch(html, /data-chart-id/)
    }
    const invalidTitle = settled({ args: PartialArguments.fromText('{"title":123'), content: [{ type: 'text', text: '<script>不执行</script>' }] })
    const html = renderToStaticMarkup(component(call(invalidTitle)))
    assert.match(html, /折线图/)
    assert.doesNotMatch(html, /<script>/)
  } finally { fixture.dispose() }
})

test('正文引用保留段落顺序，忽略代码示例，抑制重复引用并容忍流式半个标记', () => {
  const source = '设备分析\n\n[图表:legacy-chart]\n\n预警分析\n\n[图表:legacy-chart]\n\n```text\n[图表:example]\n```\n'
  const parts = chartReferences(source)
  assert.deepEqual(parts.filter(part => part.kind === 'chart').map(part => part.id), ['legacy-chart'])
  assert.ok(parts.some(part => part.kind === 'text' && part.text.includes('[图表:example]')))
  assert.deepEqual(chartReferences('[图表:legacy', true), [{ kind: 'pending', key: 0 }])
  assert.deepEqual(chartReferences('[图表:legacy'), [{ kind: 'text', text: '[图表:legacy', key: 0 }])
  assert.ok(chartReferences('行内 [图表:example]').every(part => part.kind === 'text'))
  assert.ok(chartReferences('    [图表:example]').every(part => part.kind === 'text'))
  assert.ok(chartReferences('```text\n```not-a-close\n[图表:example]\n```').every(part => part.kind === 'text'))
})

test('图表出现在正文引用位置，绑定本轮数据；缺失ID说明不可用，旧正文末尾恢复已有图表', async () => {
  const fixture = await client()
  try {
    const render = (text: string, charts: unknown[], finalText = text) => renderToStaticMarkup(fixture.entries.get('conversation.chat.response.body')!.component({
      text, streaming: false, labels: {}, turn: 1, step: 3, lastText: true,
      useTurnData: (key: string) => key === 'agent-scenarios-charts' ? charts : { closing: { step: 3, blocks: [{ kind: 'text', text: finalText }] } },
    }))
    const text = '设备分析\n\n[图表:legacy-chart]\n\n预警分析'
    const html = render(text, [meta.agentScenariosChart.chart])
    assert.ok(html.indexOf('设备分析') < html.indexOf('data-chart-id="legacy-chart"'))
    assert.ok(html.indexOf('data-chart-id="legacy-chart"') < html.indexOf('预警分析'))
    assert.equal((html.match(/data-chart-id=/g) ?? []).length, 1)
    assert.doesNotMatch(html, /\[图表:/)
    assert.match(render(text, []), /图表暂不可用/)
    const legacy = render('旧版最终回答', [meta.agentScenariosChart.chart])
    assert.ok(legacy.indexOf('旧版最终回答') < legacy.indexOf('data-chart-id='))
    assert.doesNotMatch(render('后续文字', [meta.agentScenariosChart.chart], text), /data-chart-id/)
  } finally { fixture.dispose() }
})
