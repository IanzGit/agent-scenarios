/** 水文设备分类、去重及在线离线统计。 */
import { result, table, type Row, type ToolResult } from '../../../shared/result.ts'
import { WaterHazardAPI, requiredText, text } from '../api.ts'

const TYPES = ['河流沟谷', '长观孔', '气象站', '流量', '水压/水位', '在线水质']
const AREAS = ['地表设备', '井下设备']

export async function deviceStatus(api: WaterHazardAPI, signal: AbortSignal): Promise<ToolResult> {
  const typeRows = await Promise.all(TYPES.map(type => api.devices('按设备类型分,KJ420', type, signal)))
  const areaRows = await Promise.all(AREAS.map(area => api.devices('按安装区域分', area, signal)))
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
  return result('监测设备情况', summary, [table('水文监测设备统计表', ['设备区域', '设备类型', '设备数量', '在线设备数量', '离线设备数量'], values)])
}
