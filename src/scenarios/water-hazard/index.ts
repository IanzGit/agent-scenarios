/** 水害领域插件，只在选择该领域的 preset 内挂载。 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from 'dsh-agent-charts'
import { Config, resolveSettings, type SettingsInput } from './config.ts'
import { WaterHazardAPI } from './api.ts'
import { createTools } from './tools.ts'

export { Config }
export const name = 'water-hazard'
export const inject = ['tools', 'skills', 'systemPrompt', 'chartSources']

/** 注册工具、领域技能及参考日期；注册随所属 preset 一起释放。 */
export function apply(ctx: Context, config: SettingsInput = {}): void {
  const settings = resolveSettings(config)
  for (const tool of createTools(new WaterHazardAPI(settings), ctx.chartSources)) ctx.tools.register(tool)
  ctx.plugin(filesystemSkills, {
    providerName: 'coal-mine-water-hazard', includeDefaultRoots: false,
    customSkillDirs: [fileURLToPath(new URL('../../../skills/water-hazard/', import.meta.url))],
  })
  ctx.systemPrompt.section({ name: 'water-hazard:reference-date', order: 110,
    text: `水害数据参考日期为 ${settings.conversationDate}，未指定日期时查询截至该日期且含当天的30个自然日。真实系统日期不覆盖该业务日期。`,
  })
}
