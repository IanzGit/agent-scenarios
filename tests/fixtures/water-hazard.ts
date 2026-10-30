/** 固定接口响应；不依赖 Python 服务或真实网络。 */
import { WaterHazardAPI, type ApiRow } from '../../packages/water-hazard/src/infrastructure/api.ts'
import { deviceStatus } from '../../packages/water-hazard/src/services/devices.ts'
import { deviceAlarm, modelWarning, warningStatistics } from '../../packages/water-hazard/src/services/warnings.ts'
import { hydrologicalTrend } from '../../packages/water-hazard/src/services/trends.ts'
import { resolveSettings } from '../../packages/water-hazard/src/config.ts'

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
  }, requests, fetcher }
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
    if (path.endsWith('getSingleData.action')) return [{ singleId: 'sensor', blueValue: '0', yellowValue: '1.20', orangeValue: '2.30', redValue: '3.40' }, { singleId: '433f2709f7a54e4ab4bc555f66a58262', isOpenWarn: 1, blueValue: .14, yellowValue: .18, orangeValue: .22, redValue: .26 }]
    if (path.endsWith('getMultWarnList.action')) return { totalSize: 1, resultData: [{ multId: 'model', multName: '模型预警', warnModel: '综合判识' }] }
    if (path.endsWith('getWarnNormList.action')) return { totalSize: 1, resultData: [{ name: '涌水量', warnModelName: '层次分析法' }] }
    if (path.endsWith('warnRecord.action')) return statistics([event('single'), event('model', { sourceType: 3, sourceId: 'model', riskLevel: '红色预警' })])
    if (path.endsWith('getSingleList.action')) return { totalSize: 2, resultData: ['45208', '85211'].map(name => ({ name: `${name}回采最近积水区距离`, value: 132, time: '2026-08-30' })) }
    if (path.endsWith('findBasic.action')) return { currentMiningArea: '八盘区' }
    if (path.endsWith('getLastGeologyInfo.action')) return [{ name: form.get('name'), x: 100, y: 100, z: 10 }]
    if (path.endsWith('getAllRoadwayData.action')) return { totalSize: 2, resultData: [
      { code: 11, startCode: 1, stopCode: 2, startX: 100, startY: 100, startZ: 10, stopX: 200, stopY: 100, stopZ: 8, startPointName: '起点', stopPointName: '中间点', startIsEnd: 0, stopIsEnd: 0, closedState: 0 },
      { code: 12, startCode: 2, stopCode: 3, startX: 200, startY: 100, startZ: 8, stopX: 300, stopY: 100, stopZ: 6, startPointName: '中间点', stopPointName: '出口', startIsEnd: 0, stopIsEnd: 1, closedState: 0 },
    ] }
    if (path.endsWith('getAllPersonData.action')) return { resultData: [
      { personId: 'P1', personName: '甲', pointX: 110, pointY: 100, pointZ: 10 },
      { personId: 'P2', personName: '乙', pointX: 210, pointY: 100, pointZ: 8 },
    ] }
    if (path.endsWith('getBasemapJs.action')) return { 平面底图: '/js/dxf/fixture.json' }
    if (path.endsWith('/js/dxf/fixture.json')) return Response.json({ contentBox: { x: 50, y: 50, w: 300, h: 200 }, layersData: [[{ type: 'line', points: [{ x: 100, y: 100 }, { x: 300, y: 100 }] }]] })
    if (path.endsWith('getSensorChartData.action') && form.get('time_startTime') !== '2026-08-03 00:00:00') {
      const id = form.get('sensorId'), pressure = id === '433f2709f7a54e4ab4bc555f66a58262', quality = id === '53f74d3f400844daab4144abeadc14a3', borehole = id === '3d0466f9e728421bbd235b53dcdc0571'
      const start = Date.parse(String(form.get('time_startTime')).slice(0, 10) + 'T00:00:00Z'), end = Date.parse(String(form.get('time_endTime')).slice(0, 10) + 'T00:00:00Z')
      return { unit: pressure ? 'MPa' : quality ? 'PH' : borehole ? 'm' : 'm³/h', data: Array.from({ length: (end - start) / 86400000 + 1 }, (_, i) => ({ time: new Date(start + i * 86400000).toISOString().slice(0, 10) + ' 12:00:00', value: pressure ? .1 : quality ? 7 : borehole ? 20 : 40 })) }
    }
    if (path.endsWith('getSensorChartData.action')) return { unit: 'm', data: [{ time: '2026-08-03 00:00:00', value: '1.234567' }, { time: '2026-08-04 00:00:00', value: null }, { time: '2026-09-01 23:59:59', value: 3.456789 }] }
    throw new Error(`未声明的 fixture 请求 ${path}`)
  })
}
