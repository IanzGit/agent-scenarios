/** Cube 查询子智能体的部署配置。 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  cubeUrl: z.string(), cubeToken: z.string(), timeoutSeconds: z.number().min(0.001),
  continueWaitRetries: z.natural(), continueWaitDelaySeconds: z.number().min(0),
  metaCacheTtlSeconds: z.number().min(0), timezone: z.string(), maxAgentIterations: z.natural().min(1),
})
export type Settings = {
  cubeUrl: string; cubeToken: string; timeoutSeconds: number; continueWaitRetries: number
  continueWaitDelaySeconds: number; metaCacheTtlSeconds: number; timezone: string; maxAgentIterations: number
}

/** 显式插件配置优先于环境变量；不自行读取 .env。 */
export function resolveSettings(input: Partial<Settings> = {}): Settings {
  const env = (name: string, fallback: string) => process.env[`HYDROLOGY_SEMANTIC_QUERY_${name}`] ?? fallback
  const settings: Settings = {
    cubeUrl: input.cubeUrl ?? env('CUBE_URL', 'http://127.0.0.1:58025'),
    cubeToken: input.cubeToken ?? env('CUBE_TOKEN', ''),
    timeoutSeconds: input.timeoutSeconds ?? Number(env('TIMEOUT_SECONDS', '30')),
    continueWaitRetries: input.continueWaitRetries ?? Number(env('CONTINUE_WAIT_RETRIES', '6')),
    continueWaitDelaySeconds: input.continueWaitDelaySeconds ?? Number(env('CONTINUE_WAIT_DELAY_SECONDS', '0.1')),
    metaCacheTtlSeconds: input.metaCacheTtlSeconds ?? Number(env('META_CACHE_TTL_SECONDS', '300')),
    timezone: input.timezone ?? env('TIMEZONE', 'Asia/Shanghai'),
    maxAgentIterations: input.maxAgentIterations ?? Number(env('MAX_AGENT_ITERATIONS', '6')),
  }
  const url = new URL(settings.cubeUrl.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw new Error('Cube 地址必须为不含凭证、查询参数和片段的 HTTP/HTTPS 地址。')
  const root = url.href.replace(/\/$/, '')
  settings.cubeUrl = root.endsWith('/v1') ? root : `${root}${root.endsWith('/cubejs-api') ? '/v1' : '/cubejs-api/v1'}`
  for (const key of ['timeoutSeconds', 'continueWaitRetries', 'continueWaitDelaySeconds', 'metaCacheTtlSeconds', 'maxAgentIterations'] as const) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0) throw new Error(`水文查询配置 ${key} 必须为有限非负数。`)
  }
  if (settings.timeoutSeconds === 0 || !Number.isSafeInteger(settings.continueWaitRetries)
    || !Number.isSafeInteger(settings.maxAgentIterations) || settings.maxAgentIterations < 1) throw new Error('超时必须大于零，重试次数和迭代上限必须为合法整数。')
  new Intl.DateTimeFormat('zh-CN', { timeZone: settings.timezone })
  return settings
}
