/** 水文系统只读接口，统一表单 POST、重试、取消和分页完整性检查。 */
import { setTimeout as delay } from 'node:timers/promises'
import type { Period } from 'dsh-agent-shared'
import { dateValue, type Settings } from '../config.ts'

export type ApiRow = Record<string, unknown>
export class WaterHazardAPIError extends Error {
  override name = 'WaterHazardAPIError'
}

export function object(value: unknown, source: string): ApiRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WaterHazardAPIError(`${source} 返回的对象格式错误`)
  return value as ApiRow
}
export function rows(value: unknown, source: string): ApiRow[] {
  if (!Array.isArray(value)) throw new WaterHazardAPIError(`${source} 返回的数据列表格式错误`)
  return value.map(row => object(row, source))
}
export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new WaterHazardAPIError(`缺少合法 ${field}`)
  return value
}
export function count(value: unknown, field: string): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) throw new WaterHazardAPIError(`缺少合法 ${field}`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new WaterHazardAPIError(`缺少合法 ${field}`)
  return result
}

/** 保留网页时间的自然日，不使用时区换算改变事件所属日期。 */
export function calendarDate(value: unknown): string {
  const text = requiredText(value, '时间')
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text)) throw new WaterHazardAPIError(`时间格式错误：${text}`)
  const date = text.slice(0, 10)
  dateValue(date)
  if (text.length > 10 && (!Number.isFinite(Date.parse(text.replace(' ', 'T'))) || Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59 || Number(text.slice(17, 19) || 0) > 59)) throw new WaterHazardAPIError(`时间格式错误：${text}`)
  return date
}

/** 未指定范围时使用配置参考日；趋势默认限制31天，新场景按原口径传入上限。 */
export function resolvePeriod(settings: Settings, start = '', end = '', maxDays = 31): Period {
  start = start.trim()
  end = end.trim()
  if (Boolean(start) !== Boolean(end)) throw new Error('start_time 和 end_time 必须同时传入')
  if (!start) {
    end = settings.conversationDate
    start = new Date(dateValue(end) - 29 * 86400000).toISOString().slice(0, 10)
  }
  const days = (dateValue(end) - dateValue(start)) / 86400000 + 1
  if (days <= 0) throw new Error('start_time 不能晚于 end_time')
  if (days > maxDays) throw new Error(`查询时间跨度不能超过${maxDays}天`)
  return { start, end }
}

export class WaterHazardAPI {
  constructor(readonly settings: Settings, private readonly fetcher: typeof fetch = fetch) {}

  post(path: string, payload: Record<string, string | number>, signal: AbortSignal): Promise<unknown> {
    return this.request(path, payload, signal)
  }

  private async request(path: string, payload: Record<string, string | number> | undefined, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      let response: Response
      try {
        response = await this.fetcher(`${this.settings.apiBaseUrl}${path}`, {
          method: payload ? 'POST' : 'GET',
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
            ...(this.settings.apiToken.trim() ? { Authorization: `Bearer ${this.settings.apiToken.trim()}` } : {}),
          },
          body: payload ? new URLSearchParams(Object.entries(payload).map(([key, value]): [string, string] => [key, String(value)])) : undefined,
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.settings.apiTimeoutSeconds * 1000)]),
        })
      } catch (error) {
        signal.throwIfAborted()
        if (attempt >= this.settings.apiMaxRetries) throw new WaterHazardAPIError(`${path} 请求失败：${error instanceof Error ? error.message : String(error)}`)
        await delay(this.settings.apiRetryBackoffSeconds * 1000 * (attempt + 1), undefined, { signal })
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status >= 500 && attempt < this.settings.apiMaxRetries) {
          await delay(this.settings.apiRetryBackoffSeconds * 1000 * (attempt + 1), undefined, { signal })
          continue
        }
        throw new WaterHazardAPIError(`${path} 请求失败：HTTP ${response.status}`)
      }
      let raw: unknown
      try { raw = await response.json() } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof SyntaxError) && attempt < this.settings.apiMaxRetries) {
          await delay(this.settings.apiRetryBackoffSeconds * 1000 * (attempt + 1), undefined, { signal })
          continue
        }
        throw new WaterHazardAPIError(`${path} 返回的不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
      }
      signal.throwIfAborted()
      if (!payload) return raw
      const body = object(raw, path)
      if (body.code !== 200) throw new WaterHazardAPIError(`${path} 业务请求失败：${String(body.msg ?? '响应格式错误')}`)
      if (!('data' in body)) throw new WaterHazardAPIError(`${path} 缺少 data 字段`)
      return body.data
    }
  }

  async pages(path: string, payload: Record<string, string | number>, signal: AbortSignal): Promise<ApiRow[]> {
    const merged: ApiRow[] = []
    let expected: number | undefined
    for (let page = 1; ; page++) {
      const data = object(await this.post(path, { ...payload, pageNumber: page }, signal), path)
      const pageRows = rows(data.resultData, path)
      const total = count(data.totalSize, 'totalSize')
      if (expected !== undefined && total !== expected) throw new WaterHazardAPIError(`${path} 分页总数发生变化`)
      expected = total
      merged.push(...pageRows)
      if (merged.length > total) throw new WaterHazardAPIError(`${path} 分页数据超过 totalSize`)
      if (merged.length === total) return merged
      if (pageRows.length === 0) throw new WaterHazardAPIError(`${path} 分页数据不完整`)
    }
  }

  devices(parent: string, child: string, signal: AbortSignal): Promise<ApiRow[]> {
    return this.pages('/app/laptop/sdg/device/list.action', {
      screenId: this.settings.monitorScreenId, labelParent: parent, labelChild: child, isHide: 'true',
    }, signal)
  }

  async events(period: Period, signal: AbortSignal): Promise<ApiRow[]> {
    const path = '/app/api/screen/warnData/sendMsgWarnHistory.action'
    const all = rows(await this.post(path, { screenId: this.settings.warningScreenId, labelName: '' }, signal), path)
    const unique = new Map<string, ApiRow>()
    for (const event of all) {
      const id = requiredText(event.warnEventId, 'warnEventId')
      if (!unique.has(id)) unique.set(id, event)
    }
    return [...unique.values()].filter(event => {
      const date = calendarDate(event.warnDate)
      return date >= period.start && date <= period.end
    })
  }

  async singleConfigs(signal: AbortSignal): Promise<ApiRow[]> {
    const path = '/app/api/screen/warnData/getSingleData.action'
    return rows(await this.post(path, {}, signal), path)
  }
  modelConfigs(signal: AbortSignal): Promise<ApiRow[]> {
    return this.pages('/app/api/screen/warnData/getMultWarnList.action', {}, signal)
  }
  norms(sourceId: string, signal: AbortSignal): Promise<ApiRow[]> {
    return this.pages('/app/api/screen/warnData/getWarnNormList.action', { sourceId, type: 'multifactor' }, signal)
  }
  async statistics(period: Period, signal: AbortSignal): Promise<ApiRow> {
    const path = '/app/api/screenData/warnRecord.action'
    return object(await this.post(path, {
      screenId: this.settings.warningScreenId, startTime: `${period.start} 00:00:00`, stopTime: `${period.end} 23:59:59`,
    }, signal), path)
  }
  async history(sensorId: string, period: Period, signal: AbortSignal): Promise<ApiRow> {
    const path = '/app/laptop/setting/device/getSensorChartData.action'
    return object(await this.post(path, {
      sensorId, time_startTime: `${period.start} 00:00:00`, time_endTime: `${period.end} 23:59:59`,
    }, signal), path)
  }
  structures(signal: AbortSignal): Promise<ApiRow[]> {
    return this.pages('/app/api/screen/warnData/getSingleList.action', { labelName: '空间距离预警', pageSize: 100 }, signal)
  }
  async basic(signal: AbortSignal): Promise<ApiRow> {
    const path = '/app/laptop/collierydata/collieryBasic/findBasic.action'
    return object(await this.post(path, {}, signal), path)
  }
  async location(workface: string, signal: AbortSignal): Promise<ApiRow> {
    const path = '/app/api/screen/data/getLastGeologyInfo.action'
    const matches = rows(await this.post(path, { name: workface }, signal), path).filter(row => String(row.name ?? '').trim() === workface)
    if (matches.length !== 1) throw new WaterHazardAPIError(`未返回工作面 ${workface} 的唯一定位记录`)
    return matches[0]
  }
  async roadways(signal: AbortSignal): Promise<ApiRow[]> {
    const path = '/app/api/simulation/getAllRoadwayData.action'
    const data = object(await this.post(path, {}, signal), path)
    const values = rows(data.resultData, path)
    if (values.length !== count(data.totalSize, 'totalSize')) throw new WaterHazardAPIError('巷道数据不完整')
    return values
  }
  async personnel(signal: AbortSignal): Promise<ApiRow[]> {
    const path = '/app/api/simulation/getAllPersonData.action'
    return rows(object(await this.post(path, {}, signal), path).resultData, path)
  }
  async basemap(signal: AbortSignal): Promise<ApiRow> {
    const path = '/app/laptop/simulation/basemap/getBasemapJs.action'
    const descriptor = object(await this.post(path, {}, signal), path)
    const resource = requiredText(descriptor.平面底图, '平面底图')
    if (!/^\/js\/dxf\/[A-Za-z0-9_./-]+$/.test(resource) || resource.split('/').includes('..')) throw new WaterHazardAPIError('平面底图路径无效')
    const data = object(await this.request(resource, undefined, signal), resource)
    const box = object(data.contentBox, '底图坐标范围')
    for (const key of ['x', 'y', 'w', 'h']) numeric(box[key], `底图 ${key}`)
    if (Number(box.w) <= 0 || Number(box.h) <= 0 || !Array.isArray(data.layersData) || !data.layersData.length) throw new WaterHazardAPIError('底图范围或图层无效')
    data.layersData.forEach(layer => rows(layer, '底图图层'))
    return data
  }
  async realtime(signal: AbortSignal): Promise<ApiRow[]> {
    const path = '/app/api/screenData/getSensorSSData.action'
    return rows(await this.post(path, { screenId: this.settings.monitorScreenId }, signal), path)
  }
}

/** API 可选显示字段，缺失时使用明确占位文字。 */
export function text(value: unknown, missing = '未取得'): string {
  return value === null || value === undefined || value === '' ? missing : String(value)
}

/** 补充配置失败时保留主结果；取消和编程错误继续传播。 */
export async function supplement<T>(load: () => Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
  try { return await load() } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof WaterHazardAPIError)) throw error
    return fallback
  }
}

/** 接口中的数值允许十进制字符串，拒绝空白、布尔和非有限值。 */
export function numeric(value: unknown, field: string): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) throw new WaterHazardAPIError(`缺少合法 ${field}`)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new WaterHazardAPIError(`缺少合法 ${field}`)
  return number
}
