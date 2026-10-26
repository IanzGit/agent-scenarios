/** 煤矿场景 Host 插件，与 Web Client 共用一个本地 bundle。 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveSettings, type SettingsInput } from './water-hazard/config.ts'
import { WaterHazardAPI } from './water-hazard/api.ts'
import { WaterHazardBusiness } from './water-hazard/business.ts'
import { createTools } from './tools.ts'

export const name = 'coal-mine-scenarios'
export const inject = ['tools', 'skills', 'systemPrompt']
export const Config = z.object({
  apiBaseUrl: z.string(), monitorScreenId: z.string(), warningScreenId: z.string(), conversationDate: z.string(),
  apiTimeoutSeconds: z.number(), apiMaxRetries: z.number(), apiRetryBackoffSeconds: z.number(), apiToken: z.string(),
  sensors: z.object({ inflow: z.string(), drainage: z.string(), borehole: z.string(), sump: z.string() }),
})

/** 挂载业务工具和本包技能；卸载时随 Cordis effect 释放注册及文件监听。 */
export function apply(ctx: Context, config: SettingsInput = {}): void {
  const settings = resolveSettings(config)
  const business = new WaterHazardBusiness(new WaterHazardAPI(settings))
  for (const tool of createTools(business)) ctx.tools.register(tool)
  // 构建后的入口固定为 lib/index.js，技能保留为独立可编辑的 Markdown。
  ctx.plugin(filesystemSkills, { providerName: 'coal-mine-water-hazard', includeDefaultRoots: false, customSkillDirs: [fileURLToPath(new URL('../skills/', import.meta.url))] })
  ctx.systemPrompt.section({ name: 'coal-mine:reference-date', order: 110, text: `水害数据参考日期为 ${settings.conversationDate}，未指定日期时查询截至该日期且含当天的30个自然日。真实系统日期不覆盖该业务日期。` })
}
