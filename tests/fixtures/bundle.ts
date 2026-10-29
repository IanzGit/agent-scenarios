/** 与 Harness 一致，按 Bundle manifest 声明顺序读取补丁。 */
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

export async function readBundlePatches(): Promise<{ insert?: { id: string; name: string; config: PresetDefinition }[] }[]> {
  const root = new URL('../../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const patches = await Promise.all(manifest.dsh.bundle.patch.map(async (file: string) =>
    parse(await readFile(new URL(file, root), 'utf8'))))
  return patches.flat()
}
