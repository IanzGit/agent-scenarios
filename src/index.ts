/** 根入口保留水害兼容模式，并提供全局 Client 挂载行。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as waterHazard from './scenarios/water-hazard/index.ts'
import type { SettingsInput } from './scenarios/water-hazard/config.ts'

export const name = 'agent-scenarios'
export const inject = waterHazard.inject
export const Config = z.intersect([waterHazard.Config, z.object({ clientOnly: z.boolean().default(false) })])

/** 裸包挂载用于标准 Client 发现；默认行为仍是既有水害插件。 */
export function apply(ctx: Context, config: SettingsInput & { clientOnly?: boolean } = {}): void {
  if (!config.clientOnly) waterHazard.apply(ctx, config)
}
