/** 固定接口响应；不依赖 Python 服务或真实网络。 */
import { WaterHazardAPI, type ApiRow } from '../../src/scenarios/water-hazard/api.ts'
import { deviceStatus } from '../../src/scenarios/water-hazard/services/devices.ts'
import { deviceAlarm, modelWarning, warningStatistics } from '../../src/scenarios/water-hazard/services/warnings.ts'
import { hydrologicalTrend } from '../../src/scenarios/water-hazard/services/trends.ts'
import { resolveSettings } from '../../src/scenarios/water-hazard/config.ts'

export type Request = { path: string; form: URLSearchParams; init?: RequestInit }
export function mockBusiness(handler: (request: Request) => unknown | Promise<unknown>) {
  const requests: Request[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const request = { path: new URL(String(url)).pathname, form: new URLSearchParams(String(init?.body ?? '')), init }
    requests.push(request)
    const data = await handler(request)
    return data instanceof Response ? data : Response.json({ code: 200, data })
  }
  const settings = resolveSettings({ apiBaseUrl: 'http://fixture', apiRetryBackoffSeconds: 0 }, {})
  const api = new WaterHazardAPI(settings, fetcher)
  return { api, business: {
    deviceStatus: (signal: AbortSignal) => deviceStatus(api, signal),
    deviceAlarm: (signal: AbortSignal) => deviceAlarm(api, signal),
    modelWarning: (signal: AbortSignal) => modelWarning(api, signal),
    warningStatistics: (signal: AbortSignal) => warningStatistics(api, signal),
    hydrologicalTrend: (signal: AbortSignal, start?: string, end?: string) => hydrologicalTrend(api, signal, start, end),
  }, requests }
}
export function event(id: string, fields: ApiRow = {}): ApiRow {
  return { warnEventId: id, sourceId: 'sensor', sourceType: 1, name: '测点报警', warnDate: '2026-08-03 00:00:00.0000', riskLevel: '蓝色预警', value: '1.20', isPositive: '否', state: '已处置', labelName: '涌水量预警', ...fields }
}
export function statistics(events: ApiRow[]) {
  return { recordArr: events, riskNum: events.length, blue: events.filter(event => event.riskLevel === '蓝色预警').length, yellow: events.filter(event => event.riskLevel === '黄色预警').length, orange: events.filter(event => event.riskLevel === '橙色预警').length, red: events.filter(event => event.riskLevel === '红色预警').length }
}

/** 两类技能完整链路的稳定输入。 */
export function scenarioFixture() {
  return mockBusiness(({ path, form }) => {
    if (path.endsWith('device/list.action')) {
      const child = form.get('labelChild')
      const selected = child === '流量' || child === '地表设备'
      return { totalSize: selected ? 2 : 0, resultData: selected ? [
        { valueId: 's1', deviceName: '设备1', sensorName: '传感器1', alarmState: '正常' },
        { valueId: 's2', deviceName: '设备2', sensorName: '传感器2', alarmState: '离线' },
      ] : [] }
    }
    if (path.endsWith('sendMsgWarnHistory.action')) return [event('single'), event('model', { sourceType: 3, sourceId: 'model', name: '模型预警', riskLevel: '红色预警' })]
    if (path.endsWith('getSingleData.action')) return [{ singleId: 'sensor', blueValue: '0', yellowValue: '1.20', orangeValue: '2.30', redValue: '3.40' }]
    if (path.endsWith('getMultWarnList.action')) return { totalSize: 1, resultData: [{ multId: 'model', multName: '模型预警', warnModel: '综合判识' }] }
    if (path.endsWith('getWarnNormList.action')) return { totalSize: 1, resultData: [{ name: '涌水量', warnModelName: '层次分析法' }] }
    if (path.endsWith('warnRecord.action')) return statistics([event('single'), event('model', { sourceType: 3, sourceId: 'model', riskLevel: '红色预警' })])
    if (path.endsWith('getSensorChartData.action')) return { unit: 'm', data: [{ time: '2026-08-03 00:00:00', value: '1.234567' }, { time: '2026-08-04 00:00:00', value: null }, { time: '2026-09-01 23:59:59', value: 3.456789 }] }
    throw new Error(`未声明的 fixture 请求 ${path}`)
  })
}
