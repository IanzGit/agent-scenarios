/** 仅通过官方 dsh 启动；本地依赖和运行数据均位于 agent-scenarios。 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(root, '../deepseek-harness')
const home = resolve(root, '.dsh')
const env = { ...process.env, DSH_HOME: home }
const args = process.argv.slice(2)
for (let index = 0; index < args.length - 1; index++) {
  if (args[index] === '--patch') args[index + 1] = resolve(process.cwd(), args[index + 1])
}
const launcher = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']

function run(argv) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [...launcher, ...argv], { cwd: harness, env, stdio: 'inherit' })
    const forward = signal => child.kill(signal)
    const onInt = () => forward('SIGINT')
    const onTerm = () => forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    child.on('error', reject)
    child.on('exit', code => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); resolveExit(code ?? 1) })
  })
}

if (!existsSync(resolve(root, 'lib/client.js'))) throw new Error('请先在 agent-scenarios 执行 pnpm build')
const manifestPath = resolve(home, 'profiles/web/package.json')
const installed = existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.['dsh-agent-scenarios'] === `link:${root.replace(/\/$/, '')}`
if (!installed) {
  const code = await run(['plugin', '--profile', 'web', 'add', `link:${root.replace(/\/$/, '')}`, '--ignore-scripts'])
  if (code !== 0) process.exit(code)
}
// 无桌面 Linux 也能创建默认工作区，不依赖 xdg-user-dir。
await mkdir(home, { recursive: true })
const runtimePatch = resolve(home, 'runtime.patch.yml')
await writeFile(runtimePatch, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(resolve(home, 'workspaces'))}\n`)
process.exitCode = await run(['web', '--patch', runtimePatch, ...args])
