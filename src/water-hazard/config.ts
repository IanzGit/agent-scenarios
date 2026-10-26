/** 部署配置；显式插件配置优先于环境变量和原系统默认值。 */
export const DEFAULT_SENSORS = {
  inflow: '297ed746965ca5df01965cf6e35f0001',
  drainage: '297ed746965ca5df01965d02e1ca0009',
  borehole: '3d0466f9e728421bbd235b53dcdc0571',
  sump: 'ab6fe495a5b44eb6b64b6a924949f7e4',
}
export interface Settings {
  apiBaseUrl: string
  monitorScreenId: string
  warningScreenId: string
  conversationDate: string
  apiTimeoutSeconds: number
  apiMaxRetries: number
  apiRetryBackoffSeconds: number
  apiToken: string
  sensors: typeof DEFAULT_SENSORS
}
export type SettingsInput = Partial<Omit<Settings, 'sensors'>> & { sensors?: Partial<Settings['sensors']> }

/** 校验真实的 YYYY-MM-DD 日历日期，返回 UTC 毫秒供自然日计算。 */
export function dateValue(value: string): number {
  const millis = Date.parse(`${value}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-') || !Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) {
    throw new Error(`日期必须为有效 YYYY-MM-DD：${value}`)
  }
  return millis
}

/** 解析并提前拒绝无法使用的部署配置。 */
export function resolveSettings(input: SettingsInput = {}, env: NodeJS.ProcessEnv = process.env): Settings {
  const settings: Settings = {
    apiBaseUrl: input.apiBaseUrl ?? env.WATER_HAZARD_API_BASE_URL ?? 'http://123.184.7.170:9002/hydrologyScreen',
    monitorScreenId: input.monitorScreenId ?? env.WATER_HAZARD_MONITOR_SCREEN_ID ?? '222a2e161a2d11edb4de005056c00001',
    warningScreenId: input.warningScreenId ?? env.WATER_HAZARD_WARNING_SCREEN_ID ?? '175b77671a2d11edb4de005056c00001',
    conversationDate: input.conversationDate ?? env.WATER_HAZARD_CONVERSATION_DATE ?? '2026-09-01',
    apiTimeoutSeconds: input.apiTimeoutSeconds ?? Number(env.WATER_HAZARD_API_TIMEOUT_SECONDS ?? 20),
    apiMaxRetries: input.apiMaxRetries ?? Number(env.WATER_HAZARD_API_MAX_RETRIES ?? 2),
    apiRetryBackoffSeconds: input.apiRetryBackoffSeconds ?? Number(env.WATER_HAZARD_API_RETRY_BACKOFF_SECONDS ?? 0.5),
    apiToken: input.apiToken ?? env.WATER_HAZARD_API_TOKEN ?? '',
    sensors: { ...DEFAULT_SENSORS, ...input.sensors },
  }
  const url = new URL(settings.apiBaseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('apiBaseUrl 必须为 HTTP(S) 地址')
  settings.apiBaseUrl = settings.apiBaseUrl.replace(/\/+$/, '')
  dateValue(settings.conversationDate)
  if (!Number.isFinite(settings.apiTimeoutSeconds) || settings.apiTimeoutSeconds <= 0) throw new Error('apiTimeoutSeconds 必须大于0')
  if (!Number.isInteger(settings.apiMaxRetries) || settings.apiMaxRetries < 0) throw new Error('apiMaxRetries 必须为非负整数')
  if (!Number.isFinite(settings.apiRetryBackoffSeconds) || settings.apiRetryBackoffSeconds < 0) throw new Error('apiRetryBackoffSeconds 必须为非负数')
  if ([settings.monitorScreenId, settings.warningScreenId, ...Object.values(settings.sensors)].some(value => !value.trim())) throw new Error('screen ID 和测点 ID 不能为空')
  return settings
}
