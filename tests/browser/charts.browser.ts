/** 官方 CLI + 真实浏览器 + 本地固定模型/接口，无需密钥。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { parse, stringify } from 'yaml'
import { recordings, recordedArgs, recordedText } from '../fixtures/recorded-model.ts'
import { startFixtureServer } from '../fixtures/server.ts'
import { startCubeFixture } from '../fixtures/hydrology.ts'
import { hydrologyStep } from '../fixtures/hydrology-model.ts'

test('Harness Web 在最终正文段落内展示图表，执行区折叠后仍可交互和刷新回放', { timeout: 180000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const cli = resolve(root, '../deepseek-harness/apps/cli/lib/bin.js')
  const temp = await mkdtemp(join(tmpdir(), 'scenario-charts-web-'))
  const fixture = await startFixtureServer()
  const cube = await startCubeFixture()
  const modelErrors: string[] = []
  let modelCalls = 0
  const gateway = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string | { type: string; text?: string }[]; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] }
      const text = (message: typeof body.messages[number]) => typeof message.content === 'string' ? message.content : message.content?.map(block => block.text ?? '').join('') ?? ''
      const toolNames = body.tools?.map(tool => tool.function.name) ?? []
      const hydrology = toolNames.includes('query_hydrology') || toolNames.includes('run_semantic_query')
      const userIndex = body.messages.findLastIndex(message => message.role === 'user' && (text(message).includes('当前矿井总体') || text(message).includes('近30天关键')))
      const titleRequest = !toolNames.length && body.messages.some(message => message.role === 'system' && text(message).startsWith('Create a concise title for an AI coding-assistant session'))
      if (!hydrology && userIndex < 0 && !titleRequest) throw new Error(`未识别的模型请求：${body.messages.map(message => text(message).slice(0, 300)).join('\n')}`)
      const scenario = hydrology || titleRequest ? 'hydrology' : text(body.messages[userIndex]).includes('趋势') ? 'trend' : 'overview'
      const round = hydrology ? body.messages : body.messages.slice(userIndex + 1)
      const position = round.reduce((total, message) => total + (message.tool_calls?.length ?? 0), 0)
      const step = titleRequest ? { text: '主斜井水位监测分析' } : hydrology ? hydrologyStep(body.messages.map(message => ({ role: message.role, text: text(message) })), toolNames) : recordings[scenario][position]
      if (!step) throw new Error(`固定响应耗尽：${scenario}/${position}`)
      const delta = 'tool' in step
        ? { tool_calls: [{ index: 0, id: `${scenario}-${position}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(hydrology ? step.args : recordedArgs(step.args as Record<string, string>, round.filter(message => message.role === 'tool').map(text))) } }] }
        : { content: recordedText(step.text, round.filter(message => message.role === 'tool').map(text)) }
      modelCalls++
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool' in step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) {
      modelErrors.push(String(error))
      response.writeHead(500)
      response.end('fixture model failed')
    }
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const address = gateway.address()
  assert.ok(address && typeof address !== 'string')
  const env = { ...process.env, DSH_HOME: join(temp, 'home'), DSH_TELEMETRY_DISABLED: '1' }
  let host: ReturnType<typeof spawn> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let output = ''
  try {
    await mkdir(join(temp, 'Documents'))
    await promisify(execFile)(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', root], { cwd: root, env, timeout: 45000 })
    const overlay = parse(await readFile(join(root, 'config/openai-compatible.patch.yml'), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (expression: string) => new Function('process', `return (${expression})`)({ env: { WATER_HAZARD_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, WATER_HAZARD_MODEL_ID: 'fixture' } }) }],
    }) as { id: string; config: any }[]
    const provider = overlay[0].config.providers['mine-gateway']
    delete provider.apiKeyEnv
    provider.headers = { Authorization: 'Bearer local-fixture' }
    overlay.push(
      { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'workspace-controller', config: { documentsDirectory: join(temp, 'Documents') } },
    )
    const scenarioPatch = parse(await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
    const preset = scenarioPatch[0].insert.find((entry: any) => entry.id === 'preset-water-hazard')
    preset.config.plugins[0].config = { apiBaseUrl: fixture.url }
    const queryPreset = scenarioPatch[0].insert.find((entry: any) => entry.id === 'preset-hydrology-query')
    queryPreset.config.plugins[0].config = { cubeUrl: cube.url }
    const patchPath = join(temp, 'browser.patch.yml')
    await writeFile(patchPath, stringify([
      { id: 'directory-picker', disabled: true },
      { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }, { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] },
      { id: 'preset-water-hazard', config: preset.config },
      { id: 'preset-hydrology-query', config: queryPreset.config }, ...overlay,
    ]))
    host = spawn(process.execPath, [cli, 'web', '--patch', patchPath, '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const url = await new Promise<string>((resolveURL, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Web 启动超时：${output.slice(-5000)}`)), 45000)
      const collect = (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]*token=[^\s\u001b]+/)
        if (match) { clearTimeout(timeout); resolveURL(match[0]) }
      }
      host!.stdout!.on('data', collect)
      host!.stderr!.on('data', collect)
      host!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Web 退出 ${code}：${output.slice(-5000)}`)) })
    })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const pageErrors: string[] = []
    const transportErrors: string[] = []
    page.on('pageerror', error => { pageErrors.push(error.message) })
    page.on('requestfailed', request => { transportErrors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`) })
    page.on('response', response => { if (response.status() >= 400) transportErrors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
    page.on('console', message => { if (message.type() === 'error') transportErrors.push(message.text()) })
    page.setDefaultTimeout(10000)
    try {
      await page.goto(url)
      await expect(page.getByText('Reconnecting...', { exact: true })).toBeHidden({ timeout: 30000 })
      // 独立 profile 的首次启动提示需等设置读取完毕后再关闭。
      const welcome = page.getByRole('button', { name: /^(Continue|继续)$/ })
      await welcome.waitFor({ state: 'visible', timeout: 30000 })
      await welcome.click()
      await page.getByRole('textbox', { name: 'Choose workspace' }).click({ timeout: 20000 })
      const input = page.locator('[data-composer-input][contenteditable="true"]')
      await input.fill('当前矿井总体水害监测预警情况汇总分析')
      await input.press('Enter')
      const cards = page.locator('[data-answer-chart-body] .agent-scenarios-chart')
      const calls = page.locator('.agent-scenarios-chart-call')
      await expect(calls).toHaveCount(4, { timeout: 30000 })
      await expect(cards).toHaveCount(4, { timeout: 30000 })
      await expect(page.locator('.agent-scenarios-chart svg')).toHaveCount(4)
      await expect(page.locator('.agent-scenarios-chart-call[data-chart-state="complete"]')).toHaveCount(4)
      await expect(page.getByRole('region', { name: '分析图表', exact: true })).toHaveCount(0)
      assert.ok(await calls.evaluateAll(elements => elements.every(element =>
        element.querySelectorAll('.agent-scenarios-chart').length === 0)))
      assert.ok(await cards.evaluateAll(elements => elements.every(element => !element.closest('[data-chat-call-id]'))))
      await expect(page.locator('[data-answer-chart-body]')).not.toContainText('[图表:')
      const first = cards.first()
      await first.scrollIntoViewIfNeeded()
      await first.locator('svg path[fill]:not([fill="none"])').first().hover()
      await expect(first.locator('svg')).toContainText('设备数量（套）')
      await input.fill('近30天关键水文指标的变化趋势')
      await input.press('Enter')
      await expect(cards).toHaveCount(8, { timeout: 30000 })
      await expect(calls).toHaveCount(8)
      await expect(page.locator('.agent-scenarios-chart-call[data-chart-state="complete"]')).toHaveCount(8)
      assert.ok(await cards.evaluateAll(elements => elements.every(element => !element.closest('[data-chat-call-id]'))))
      const line = page.locator('[data-chart-type="line"]').first()
      await line.scrollIntoViewIfNeeded()
      await line.locator('svg').hover({ position: { x: 180, y: 160 } })
      const width = await line.locator('svg').getAttribute('width')
      await mkdir(join(root, 'test-results'), { recursive: true })
      // ECharts SVG 的两个时间轴拖柄；右拖柄的位置应随缩放变化。
      const handle = line.locator('svg path[transform^="matrix(15,0,0,-15"]').last()
      const originalHandle = await handle.getAttribute('transform')
      const bounds = await handle.boundingBox()
      assert.ok(bounds)
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x - 150, bounds.y + bounds.height / 2, { steps: 8 })
      await page.mouse.up()
      await expect(handle).not.toHaveAttribute('transform', originalHandle!)
      await page.setViewportSize({ width: 800, height: 900 })
      await expect(line.locator('svg')).not.toHaveAttribute('width', width!)
      const ids = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-chart-id')))
      const callsBeforeReload = modelCalls
      const queriesBeforeReload = fixture.requests.length
      await page.reload()
      await expect(cards).toHaveCount(8, { timeout: 30000 })
      await expect(calls).toHaveCount(8)
      await expect(page.getByRole('region', { name: '分析图表', exact: true })).toHaveCount(0)
      assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-chart-id'))), ids)
      assert.equal(modelCalls, callsBeforeReload)
      assert.equal(fixture.requests.length, queriesBeforeReload)
      assert.deepEqual(modelErrors, [])
      assert.deepEqual(pageErrors, [])
      await mkdir(join(root, 'test-results'), { recursive: true })
      await page.screenshot({ path: join(root, 'test-results/charts.png'), fullPage: true })
      // 新场景从官方 preset 菜单选择，复用同一套正文图表插件。
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await page.getByRole('button', { name: 'water-hazard', exact: true }).click()
      await page.getByRole('menuitem', { name: /^水文监测查数/ }).click()
      await expect(page.getByRole('button', { name: '水文监测查数', exact: true })).toBeVisible()
      await input.fill('分析主斜井水位历史情况')
      await input.press('Enter')
      await expect(cards).toHaveCount(1, { timeout: 30000 })
      await expect(calls).toHaveCount(1)
      await expect(page.locator('[data-answer-chart-body]').last()).toContainText('主斜井水位监测分析')
      await expect(page.locator('[data-answer-chart-body]').last()).not.toContainText('[图表:')
      const hydrologyIds = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-chart-id')))
      const hydrologyModelCalls = modelCalls
      const hydrologyQueries = cube.requests.length
      await page.reload()
      await expect(cards).toHaveCount(1, { timeout: 30000 })
      assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-chart-id'))), hydrologyIds)
      assert.equal(modelCalls, hydrologyModelCalls)
      assert.equal(cube.requests.length, hydrologyQueries)
      assert.deepEqual(modelErrors, [])
      assert.deepEqual(pageErrors, [])
      await page.screenshot({ path: join(root, 'test-results/hydrology.png'), fullPage: true })
    } catch (error) {
      await mkdir(join(root, 'test-results'), { recursive: true })
      await page.screenshot({ path: join(root, 'test-results/charts-failure.png'), fullPage: true })
      throw new Error(`${error}\n模型错误：${modelErrors.join('\n')}\n页面错误：${pageErrors.join('\n')}\n传输：${transportErrors.join('\n')}\n页面：${(await page.locator('body').innerText()).slice(-6000)}\n宿主：${output.slice(-4000)}`)
    }
  } finally {
    await browser?.close()
    if (host && host.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit') }
    gateway.closeAllConnections()
    await new Promise<void>(resolve => { gateway.close(() => resolve()) })
    await fixture.close()
    await cube.close()
    await rm(temp, { recursive: true, force: true })
  }
})
