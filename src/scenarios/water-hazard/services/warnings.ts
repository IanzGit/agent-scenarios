/** 单因素、模型预警及统计页数据，保留原系统事件与阈值口径。 */
import type { ChartDataset } from 'dsh-agent-charts'
import { result, table, type Period, type Row, type ToolResult } from '../../../shared/result.ts'
import { WaterHazardAPI, WaterHazardAPIError, calendarDate, count, requiredText, resolvePeriod, rows, supplement, text, type ApiRow } from '../api.ts'
import { dateValue } from '../config.ts'

const LEVELS = ['红色预警', '橙色预警', '黄色预警', '蓝色预警']
const WARNING_COLUMNS = ['预警指标', '当前预警等级', '预警时间', '是否误报', '处置状态']

function rank(value: unknown): number {
  const index = LEVELS.indexOf(String(value))
  return index < 0 ? 0 : index + 1
}
function indexConfigs(configs: ApiRow[], field: string): Map<string, ApiRow> {
  const index = new Map<string, ApiRow>()
  for (const config of configs) {
    const id = requiredText(config[field], field)
    if (!index.has(id)) index.set(id, config)
  }
  return index
}
function warningRow(event: ApiRow): Row {
  return {
    预警指标: requiredText(event.name, 'name'), 当前预警等级: requiredText(event.riskLevel, 'riskLevel'),
    预警时间: requiredText(event.warnDate, 'warnDate'), 是否误报: text(event.isPositive, '未知'), 处置状态: text(event.state, '未知'),
  }
}
function warningSummary(values: Row[], period: Period, model: boolean): string {
  const range = `${period.start}至${period.end}`
  if (!values.length) return `最近30天无${model ? '模型预警' : '测点报警'}事件（${range}）。`
  const states = new Map<string, number>([['已处置', 0], ['未处置', 0]])
  const levels = new Map<string, number>(LEVELS.map(level => [level, 0]))
  for (const row of values) {
    states.set(String(row.处置状态), (states.get(String(row.处置状态)) ?? 0) + 1)
    levels.set(String(row.当前预警等级), (levels.get(String(row.当前预警等级)) ?? 0) + 1)
  }
  return `最近30天（${range}）${model ? '模型预警' : '单因素测点报警'}事件${values.length}条：${[...states].map(([state, total]) => `${state}${total}条`).join('、')}。`
    + (model ? '' : `预警等级统计：${[...levels].map(([level, total]) => `${level}${total}条`).join('、')}。`)
}

export async function deviceAlarm(api: WaterHazardAPI, signal: AbortSignal): Promise<ToolResult> {
  const period = resolvePeriod(api.settings)
  const events = (await api.events(period, signal)).filter(event => String(event.sourceType) === '1')
  const configs = events.length ? await supplement(async () => indexConfigs(await api.singleConfigs(signal), 'singleId'), new Map<string, ApiRow>(), signal) : new Map<string, ApiRow>()
  events.sort((a, b) => {
    const first = String(configs.get(String(a.sourceId))?.name ?? a.name)
    const second = String(configs.get(String(b.sourceId))?.name ?? b.name)
    return rank(a.riskLevel) - rank(b.riskLevel) || (first < second ? -1 : first > second ? 1 : 0)
  })
  const values = events.map(event => {
    const config = configs.get(String(event.sourceId)) ?? {}
    return { ...warningRow(event), 报警阈值: ['blueValue', 'yellowValue', 'orangeValue', 'redValue'].map(field => text(config[field])).join(' / ') }
  })
  const summary = warningSummary(values, period, false)
  return result('单因素超限报警', summary, [table('超限报警表', [...WARNING_COLUMNS, '报警阈值'], values)], period)
}

export async function modelWarning(api: WaterHazardAPI, signal: AbortSignal): Promise<ToolResult> {
  const period = resolvePeriod(api.settings)
  const events = (await api.events(period, signal)).filter(event => String(event.sourceType) === '3').sort((a, b) => rank(a.riskLevel) - rank(b.riskLevel))
  const configs = events.length ? await supplement(async () => indexConfigs(await api.modelConfigs(signal), 'multId'), new Map<string, ApiRow>(), signal) : new Map<string, ApiRow>()
  const sources = [...new Set(events.map(event => text(event.sourceId, '')))]
  const norms = new Map(await Promise.all(sources.map(async id => [id, id ? await supplement(() => api.norms(id, signal), [], signal) : []] as const)))
  const values = events.map(event => ({ ...warningRow(event), 判识准则: text(configs.get(String(event.sourceId))?.warnModel) }))
  const descriptions = sources.flatMap(source => {
    const model = text(configs.get(source)?.multName, String(events.find(event => text(event.sourceId, '') === source)?.name ?? '预警模型'))
    const items = norms.get(source) ?? []
    if (!items.length) return [`该${model}的关联指标及判识模型未取得，暂无法描述其多因素聚合判识。`]
    const methods = new Map<string, Set<string>>()
    for (const item of items) {
      const method = text(item.warnModelName)
      if (!methods.has(method)) methods.set(method, new Set())
      methods.get(method)!.add(text(item.name))
    }
    return [...methods].map(([method, indicators]) => `该${model}基于${[...indicators].join('、')}${method === '未取得' ? '进行多因素聚合判识，判识模型未取得' : `采用${method}进行多因素聚合判识`}。`)
  })
  const summary = [warningSummary(values, period, true), ...descriptions].join('\n')
  return result('多因素模型预警', summary, [table('多因素模型预警与处置建议表', [...WARNING_COLUMNS, '判识准则'], values)], period)
}

export async function warningStatistics(api: WaterHazardAPI, signal: AbortSignal): Promise<ToolResult> {
  const period = resolvePeriod(api.settings)
  const data = await api.statistics(period, signal)
  const events = rows(data.recordArr, '预警统计 recordArr')
  const fields = ['riskNum', 'blue', 'yellow', 'orange', 'red']
  for (const field of fields) if (typeof data[field] !== 'number') throw new WaterHazardAPIError(`预警统计缺少合法 ${field}`)
  const total = count(data.riskNum, 'riskNum')
  if (events.length !== total) throw new WaterHazardAPIError('预警统计 recordArr 与预警总数不一致，统计数据不完整')
  const levelStats = ['蓝色预警', '黄色预警', '橙色预警', '红色预警'].map((name, index) => ({ name, value: count(data[fields[index + 1]], fields[index + 1]) }))
  if (levelStats.some(level => events.filter(event => event.riskLevel === level.name).length !== level.value) || levelStats.reduce((sum, item) => sum + item.value, 0) !== total) throw new WaterHazardAPIError('预警统计的等级数量与事件记录不一致')
  const tags = [['涌水量', '涌水量预警'], ['排水量', '排水量预警'], ['采空区密闭', '采空区密闭预警'], ['河流沟谷', '河流沟谷预警'], ['降雨量', '降雨量预警'], ['长观孔', '长观孔预警'], ['空间距离', '空间距离预警'], ['多因素', '多因素']]
  const byType = new Map<string, number>([...tags.map(([name]) => [name, 0] as const), ['其他', 0] as const])
  const daily = new Map<string, number>()
  for (let day = dateValue(period.start); day <= dateValue(period.end); day += 86400000) daily.set(new Date(day).toISOString().slice(0, 10), 0)
  for (const event of events) {
    const day = calendarDate(event.warnDate)
    if (!daily.has(day)) throw new WaterHazardAPIError('预警统计返回了请求时间范围之外的事件')
    daily.set(day, daily.get(day)! + 1)
    const type = tags.find(([, tag]) => String(event.labelName ?? '').includes(tag))?.[0] ?? '其他'
    byType.set(type, byType.get(type)! + 1)
  }
  const typeStats = [...byType].map(([name, value]) => ({ name, value }))
  const dailyStats = [...daily].map(([name, value]) => ({ name, value }))
  const summary = total ? `最近30天（${period.start}至${period.end}）网页预警统计共${total}条事件，包含已处置、未处置及误报事件；按网页预警统计接口计数，时间统计按日展示。` : `最近30天无预警统计事件（${period.start}至${period.end}）。`
  return result('预警报警统计', summary, [
    table('按类型统计', ['预警类型', '事件数量'], typeStats.map(item => ({ 预警类型: item.name, 事件数量: item.value })), true),
    table('按等级统计', ['预警等级', '事件数量'], levelStats.map(item => ({ 预警等级: item.name, 事件数量: item.value })), true),
    table('按时间统计', ['日期', '事件数量'], dailyStats.map(item => ({ 日期: item.name, 事件数量: item.value })), true),
  ], period)
}

/** 三张统计表直接引用已校验的统计页数据，保留日期补零。 */
export function warningDatasets(value: ToolResult): ChartDataset[] {
  return value.tables.map((item, index) => ({
    id: ['warning_types', 'warning_levels', 'warning_daily'][index],
    title: ['预警事件类型占比', '预警事件等级占比', '每日预警事件数量'][index],
    columns: [{ name: index === 2 ? 'time' : 'category', title: item.columns[0], type: index === 2 ? 'time' : 'category' }, { name: 'value', title: '事件数量', type: 'number', unit: '条' }],
    rows: item.rows.map(row => ({ [index === 2 ? 'time' : 'category']: row[item.columns[0]], value: row[item.columns[1]] })),
  }))
}
