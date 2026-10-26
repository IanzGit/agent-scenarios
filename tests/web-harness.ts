/** 独立 profile 启动真实 dsh Web，供固定响应与真实模型两类验收复用。 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

export const root = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(root, '../deepseek-harness')
const launcher = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']

export async function launchWeb(apiBaseUrl: string, realModel = false): Promise<{ child: ChildProcess; url: string; tracePath: string }> {
  await mkdir(resolve(root, 'test-results'), { recursive: true })
  const directory = await mkdtemp(resolve(root, 'test-results/web-'))
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: resolve(directory, 'home') }
  await mkdir(resolve(directory, 'workspace'), { recursive: true })
  const setup = spawn(process.execPath, [...launcher, 'plugin', '--profile', 'web', 'add', `link:${root.replace(/\/$/, '')}`, '--ignore-scripts'], { cwd: harness, env, stdio: 'pipe' })
  let setupLogs = ''
  setup.stdout?.on('data', data => { setupLogs += String(data) })
  setup.stderr?.on('data', data => { setupLogs += String(data) })
  const code = await new Promise<number | null>((done, reject) => { setup.once('error', reject); setup.once('exit', done) })
  assert.equal(code, 0, setupLogs)
  const patch = resolve(directory, 'browser.patch.yml')
  const tracePath = resolve(directory, 'tools.jsonl')
  const defaultModel = realModel ? '' : '- id: agent-default-model\n  config:\n    provider: water-hazard-fixture\n    model: fixture\n'
  await writeFile(patch, `- id: coal-mine-scenarios\n  config:\n    apiBaseUrl: ${JSON.stringify(apiBaseUrl)}\n${defaultModel}- insert:\n    - id: browser-model-fixture\n      name: ${JSON.stringify(resolve(root, 'tests/browser-fixture-plugin.ts'))}\n      config:\n        recordedModel: ${!realModel}\n        tracePath: ${JSON.stringify(tracePath)}\n        workspacePath: ${JSON.stringify(resolve(directory, 'workspace'))}\n`)
  const picker = resolve(harness, 'apps/web/tests/pin-browse-picker.overlay.yml')
  const modelArgs = realModel && env.WATER_HAZARD_MODEL_BASE_URL ? ['--patch', resolve(root, 'config/openai-compatible.patch.yml')] : []
  const child = spawn(process.execPath, [...launcher, 'web', '--patch', patch, '--patch', picker, ...modelArgs, '--no-open', '--port', '0'], { cwd: harness, env, stdio: 'pipe' })
  const url = await new Promise<string>((done, reject) => {
    let logs = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Web 启动超时：${logs.replace(/token=[^\s]+/g, 'token=[redacted]')}`)) }, 45000)
    const output = (data: Buffer) => {
      logs += data.toString()
      const found = logs.match(/dsh web: (http:\/\/[^\s]+)/)
      if (found) { clearTimeout(timeout); done(found[1]) }
    }
    child.stdout?.on('data', output)
    child.stderr?.on('data', output)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', exit => { clearTimeout(timeout); reject(new Error(`Web 提前退出 ${exit}：${logs.replace(/token=[^\s]+/g, 'token=[redacted]')}`)) })
  })
  return { child, url, tracePath }
}

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: ['--no-sandbox'], env: {
    ...process.env,
    LD_LIBRARY_PATH: [resolve(root, 'test-results/browser-libs/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  } })
}
