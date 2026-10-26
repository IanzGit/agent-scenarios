/** 设备、预警和历史趋势业务；所有数值与图表均由本层计算。 */
import type { BusinessResult, Json, Period, Row, Table } from '../shared.ts'
import { WaterHazardAPI, WaterHazardAPIError, calendarDate, count, requiredText, resolvePeriod, rows, type ApiRow } from './api.ts'
import { dateValue } from './config.ts'
import { countChart, trendChart } from './charts.ts'

const TYPES = ['河流沟谷', '长观孔', '气象站', '流量', '水压/水位', '在线水质']
const AREAS = ['地表设备', '井下设备']
const LEVELS = ['红色预警', '橙色预警', '黄色预警', '蓝色预警']
const WARNING_COLUMNS = ['预警指标', '当前预警等级', '预警时间', '是否误报', '处置状态']
const metrics = [
  { key: 'inflow', metric: '涌水量', label: '矿井涌水量', device: '矿井总涌水量', sensor: '涌水量' },
  { key: 'drainage', metric: '排水量', label: '矿井排水量', device: '八盘区水泵房', sensor: '中央平泵房排水量' },
  { key: 'borehole', metric: '长观孔水位', label: '长观孔水位', device: '第四系钻孔ZK4', sensor: '水位' },
  { key: 'sump', metric: '中央水仓水位', label: '中央水仓水位', device: '八盘区水泵房', sensor: '1号液位' },
] as const

function text(value: unknown, missing = '未取得'): string {
  return value === null || value === undefined || value === '' ? missing : String(value)
}
function rank(value: unknown): number {
  const index = LEVELS.indexOf(String(value))
  return index < 0 ? 0 : index + 1
}
function table(key: string, title: string, columns: string[], values: Row[]): Table {
  return { key, title, columns, rows: values }
}
function result(title: string, summary: string, data: Record<string, Json>, tables: Table[] = [], charts: BusinessResult['charts'] = [], period?: Period): BusinessResult {
  return { version: 1, title, summary, data, tables, charts, ...(period ? { period } : {}) }
}
function indexConfigs(configs: ApiRow[], field: string): Map<string, ApiRow> {
  const index = new Map<string, ApiRow>()
  for (const config of configs) {
    const id = requiredText(config[field], field)
    if (!index.has(id)) index.set(id, config)
  }
  return index
}
async function supplement<T>(load: () => Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
  try { return await load() } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof WaterHazardAPIError)) throw error
    return fallback
  }
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

export class WaterHazardBusiness {
  constructor(readonly api: WaterHazardAPI) {}

  async deviceStatus(signal: AbortSignal): Promise<BusinessResult> {
    const typeRows = await Promise.all(TYPES.map(type => this.api.devices('按设备类型分,KJ420', type, signal)))
    const areaRows = await Promise.all(AREAS.map(area => this.api.devices('按安装区域分', area, signal)))
    const types = new Map<string, Set<string>>()
    typeRows.forEach((items, index) => items.forEach(item => {
      const id = requiredText(item.valueId, 'valueId')
      if (!types.has(id)) types.set(id, new Set())
      types.get(id)!.add(TYPES[index])
    }))
    const classified = new Map<string, { device: string; sensor: string; area: string; type: string; state: string }>()
    areaRows.forEach((items, index) => items.forEach(item => {
      const id = requiredText(item.valueId, 'valueId')
      for (const type of types.get(id) ?? []) {
        classified.set(`${id}\0${AREAS[index]}\0${type}`, {
          device: requiredText(item.deviceName, 'deviceName'), sensor: requiredText(item.sensorName, 'sensorName'),
          area: AREAS[index], type, state: text(item.alarmState, '未知'),
        })
      }
    }))
    const sensors = new Map<string, { area: string; type: string; state: string }>()
    for (const key of [...classified.keys()].sort()) {
      const item = classified.get(key)!
      const sensorKey = `${item.device}\0${item.sensor}`
      if (!sensors.has(sensorKey)) sensors.set(sensorKey, item)
    }
    const groups = new Map<string, { area: string; type: string; total: number; online: number }>()
    for (const item of sensors.values()) {
      const key = `${item.area}\0${item.type}`
      const group = groups.get(key) ?? { area: item.area, type: item.type, total: 0, online: 0 }
      group.total++
      if (item.state === '正常') group.online++
      groups.set(key, group)
    }
    const values: Row[] = AREAS.flatMap(area => [...groups.values()].filter(group => group.area === area).sort((a, b) => b.total - a.total).map(group => ({
      设备区域: group.area, 设备类型: group.type, 设备数量: group.total, 在线设备数量: group.online, 离线设备数量: group.total - group.online,
    })))
    const total = sensors.size
    const online = [...groups.values()].reduce((sum, group) => sum + group.online, 0)
    values.push({ 设备区域: '合计', 设备类型: '', 设备数量: total, 在线设备数量: online, 离线设备数量: total - online })
    const byType = new Map<string, number>()
    for (const group of groups.values()) byType.set(group.type, (byType.get(group.type) ?? 0) + group.total)
    const typeDescription = [...byType].map(([type, total]) => `${type}${total}套`).join('、')
    const summary = `矿井共部署${total}套水文监测设备（按传感器计数）${typeDescription ? `，其中${typeDescription}` : ''}。在线${online}套，离线${total - online}套。`
    return result('监测设备情况', summary, { 水文监测设备统计描述: summary, 水文监测设备统计表: values },
      [table('device_status', '水文监测设备统计表', ['设备区域', '设备类型', '设备数量', '在线设备数量', '离线设备数量'], values)],
      [countChart('device_type_pie', '水文监测设备类型数量占比', 'pie', [...byType].map(([name, value]) => ({ name, value })))])
  }

  async deviceAlarm(signal: AbortSignal): Promise<BusinessResult> {
    const period = resolvePeriod(this.api.settings)
    const events = (await this.api.events(period, signal)).filter(event => String(event.sourceType) === '1')
    const configs = events.length ? await supplement(async () => indexConfigs(await this.api.singleConfigs(signal), 'singleId'), new Map<string, ApiRow>(), signal) : new Map<string, ApiRow>()
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
    return result('单因素超限报警', summary, { 超限报警汇总描述: summary, 超限报警表: values },
      [table('device_alarm', '超限报警表', [...WARNING_COLUMNS, '报警阈值'], values)], [], period)
  }

  async modelWarning(signal: AbortSignal): Promise<BusinessResult> {
    const period = resolvePeriod(this.api.settings)
    const events = (await this.api.events(period, signal)).filter(event => String(event.sourceType) === '3').sort((a, b) => rank(a.riskLevel) - rank(b.riskLevel))
    const configs = events.length ? await supplement(async () => indexConfigs(await this.api.modelConfigs(signal), 'multId'), new Map<string, ApiRow>(), signal) : new Map<string, ApiRow>()
    const sources = [...new Set(events.map(event => text(event.sourceId, '')))]
    const norms = new Map(await Promise.all(sources.map(async id => [id, id ? await supplement(() => this.api.norms(id, signal), [], signal) : []] as const)))
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
    return result('多因素模型预警', summary, { 模型预警汇总描述: summary, 多因素模型预警与处置建议表: values },
      [table('model_warning', '多因素模型预警与处置建议表', [...WARNING_COLUMNS, '判识准则'], values)], [], period)
  }

  async warningStatistics(signal: AbortSignal): Promise<BusinessResult> {
    const period = resolvePeriod(this.api.settings)
    const data = await this.api.statistics(period, signal)
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
    return result('预警报警统计', summary, { 预警统计汇总描述: summary, 统计开始日期: period.start, 统计结束日期: period.end, 预警事件总数: total, 按类型统计: typeStats, 按等级统计: levelStats, 按时间统计: dailyStats }, [], [
      countChart('warning_by_type', '预警按类型统计', 'pie', typeStats), countChart('warning_by_level', '预警按等级统计', 'pie', levelStats), countChart('warning_by_time', '预警按时间统计', 'bar', dailyStats),
    ], period)
  }

  async hydrologicalTrend(signal: AbortSignal, start = '', end = ''): Promise<BusinessResult> {
    const period = resolvePeriod(this.api.settings, start, end)
    const days = (dateValue(period.end) - dateValue(period.start)) / 86400000 + 1
    const label = `近${days}天`
    const histories = await Promise.all(metrics.map(async metric => {
      const data = await this.api.history(this.api.settings.sensors[metric.key], period, signal)
      const points = rows(data.data, '历史曲线 data').map(item => {
        const date = requiredText(item.time, 'time')
        calendarDate(date)
        return { date, value: monitoringValue(item.value) }
      }).sort((a, b) => a.date.replace(' ', 'T').localeCompare(b.date.replace(' ', 'T')))
      return { metric, points, unit: text(data.unit, '').trim() }
    }))
    if (!histories.some(history => history.points.some(point => point.value !== null))) throw new Error(`${period.start}至${period.end}指定周期无有效水文监测数据`)
    if (histories.some(history => !history.unit && history.points.some(point => point.value !== null))) {
      const realtime = await supplement(() => this.api.realtime(signal), [], signal)
      for (const history of histories) if (!history.unit) history.unit = text(realtime.find(item => item.valueId === this.api.settings.sensors[history.metric.key])?.unit, '').trim()
    }
    const events = await this.api.events(period, signal)
    const warningCounts: Record<string, number> = {}
    const statistics: Row[] = []
    const summaries: string[] = []
    const rawCharts: Json[] = []
    const charts: BusinessResult['charts'] = []
    for (const { metric, points, unit } of histories) {
      const values = points.map(point => point.value).filter((value): value is number => value !== null)
      const warnings = events.filter(event => String(event.sourceType) === '1' && event.sourceId === this.api.settings.sensors[metric.key]).length
      warningCounts[metric.metric] = warnings
      let min: number | null = null, max: number | null = null, mean: number | null = null
      if (values.length) {
        min = values.reduce((a, b) => Math.min(a, b))
        max = values.reduce((a, b) => Math.max(a, b))
        mean = values.reduce((sum, value) => sum + value / values.length, 0)
        const format = (value: number) => `${Number(value.toFixed(2))}${unit || '（单位未提供）'}`
        summaries.push(`${metric.label}：${label}平均值${format(mean)}，最小值${format(min)}，最大值${format(max)}，预警${warnings}次；`)
        charts.push(trendChart(metric.key, `${label}${metric.label}趋势图`, metric.metric, unit, points.map(point => point.date), points.map(point => point.value)))
        rawCharts.push({ 指标名称: metric.metric, 单位: unit, 监测点: metric.device, 传感器名称: metric.sensor, 日期列表: points.map(point => point.date), 数值列表: points.map(point => point.value) })
      } else summaries.push(`${metric.label}：查询周期内无有效监测数据，预警${warnings}次；`)
      statistics.push({ 指标: metric.label, 监测点: metric.device, 有效记录数: values.length, 单位: unit || '单位未提供', 均值: mean, 最小值: min, 最大值: max, 首个有效值: values[0] ?? null, 末个有效值: values.at(-1) ?? null, 预警次数: warnings })
    }
    const title = `${label}水文监测指标趋势分析`
    const summary = `# ${title}\n\n## 1. 监测时间范围\n\n${period.start} 00:00:00 至 ${period.end} 23:59:59（${label}）。\n\n## 2. 历史趋势\n\n${summaries.join('\n\n')}`
    return result(title, summary, { 时间跨度: label, 水文趋势分析描述: summary, 监测点预警次数: warningCounts, 水文监测趋势图: rawCharts, 指标统计: statistics },
      [table('trend_statistics', '水文指标周期统计', ['指标', '监测点', '有效记录数', '单位', '均值', '最小值', '最大值', '首个有效值', '末个有效值', '预警次数'], statistics)], charts, period)
  }
}

/** 空值、非数值和非有限值转为断点，零为有效值。 */
export function monitoringValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  if (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : null
}
