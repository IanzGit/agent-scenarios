/** 覆盖根 Bundle 拆分后实际安装使用的公开包边界。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { readBundlePatches } from '../fixtures/bundle.ts'

const require = createRequire(import.meta.url)

test('Bundle 的全局服务和三个 preset 均使用可解析的新包入口', async () => {
  const patches = await readBundlePatches()
  const entries = patches.flatMap(patch => patch.insert ?? [])
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length)
  assert.deepEqual(entries.map(entry => entry.id), [
    'charts', 'hydrology-query-results', 'hydrology-parent-tasks',
    'preset-water-hazard', 'preset-hydrology-monitoring', 'preset-hydrology-query',
  ])
  for (const entry of entries) {
    for (const name of [entry.name, ...entry.config?.plugins?.map(plugin => plugin.name) ?? []]) {
      assert.ok(!name.startsWith('dsh-agent-scenarios'))
      const plugin = await import(name)
      assert.ok(plugin.apply || plugin.default, name)
    }
  }
  const hydrology = JSON.parse(await readFile(require.resolve('dsh-agent-hydrology-monitoring/package.json'), 'utf8'))
  assert.equal(hydrology.dsh.client.platform, 'web')
})

test('根包仅保留 Bundle 元数据，旧 Host、业务和 Client 入口已移除', () => {
  for (const suffix of ['', '/water-hazard', '/hydrology-monitoring', '/hydrology-monitoring/query-child', '/hydrology-monitoring/results', '/hydrology-monitoring/parent-tasks', '/client']) {
    assert.throws(() => require.resolve(`dsh-agent-scenarios${suffix}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  }
  assert.ok(require.resolve('dsh-agent-scenarios/cordis.patch.yml'))
})

test('Bundle 显式声明捆绑子包的 peers，供独立 tgz 安装解析', async () => {
  const manifest = JSON.parse(await readFile(require.resolve('dsh-agent-scenarios/package.json'), 'utf8'))
  for (const name of manifest.bundledDependencies) {
    const child = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'))
    for (const [peer, version] of Object.entries(child.peerDependencies)) {
      assert.equal(manifest.peerDependencies[peer], version, `${name}: ${peer}`)
    }
  }
})
