/** 查询明细到业务表格、统计与现有图表数据集的确定性适配。 */
import { createHash } from 'node:crypto'
import type { ChartDataset, ChartRow } from 'dsh-agent-charts'
import { result, table, type Row, type Table } from 'dsh-agent-shared'
import type { QueryRecord } from '../domain/protocol.ts'

const MAX_INLINE_DETAIL_ROWS = 50

/** 只认现有水文语义成员，不用标题相似度猜测业务字段。 */
function fields(record: QueryRecord) {
  const views = ['view_point_deployment_analysis', 'view_realtime_monitoring_analysis', 'view_historical_trend_analysis', 'view_historical_statistics_analysis', 'view_exception_event_analysis']
  const find = (alias: string, cubes: string[] = []) => {
    const candidates = [...views.map(view => `${view}.${alias}`), ...cubes]
    return candidates.find(name => record.columns.some(column => column.name === name))
  }
  return {
    id: find('point_id', ['base_point_info.point_id']) ?? find('point_code', ['base_point_info.code']) ?? find('point_name_code', ['base_point_info.name_code']),
    label: find('point_name_code', ['base_point_info.name_code']) ?? find('point_name', ['base_point_info.name']),
    pointName: find('point_name', ['base_point_info.name']),
    type: find('value_type_name', ['base_m_value_type_sys.name']),
    unit: find('point_unit', ['base_point_info.unit']),
    time: find('observed_at', ['base_his_record.observed_at', 'base_point_real_data.observed_at']),
    current: find('current_value', ['base_point_real_data.current_value']),
    historical: find('value', ['base_his_record.value']),
    status: find('value_status_name', ['base_m_value_status.name']),
    deviceStatus: find('device_status_name', ['base_m_dev_status.name']),
    start: find('started_at', ['base_his_point_except.started_at']), end: find('ended_at', ['base_his_point_except.ended_at']),
  }
}

export function presentQuery(record: QueryRecord) {
  const f = fields(record)
  const datasets: ChartDataset[] = []
  const tables: Table[] = []
  const text = (row: Record<string, unknown>, field?: string): string => field && row[field] != null ? String(row[field]) : '未提供'
  const scalar = (value: unknown): string | number | null => value == null ? null : typeof value === 'number' ? value : String(value)
  const titles = record.columns.map(column => record.columns.filter(item => item.title === column.title).length > 1 ? `${column.title}（${column.name}）` : column.title)
  const details: Row[] = record.rows.map(row => Object.fromEntries(record.columns.map((column, index) => [titles[index], scalar(row[column.name])])) )
  if (f.start && f.end) {
    titles.push('持续时间（小时）')
    for (let index = 0; index < details.length; index++) {
      const row = record.rows[index]
      const start = Date.parse(text(row, f.start)); const end = Date.parse(text(row, f.end))
      details[index]['持续时间（小时）'] = row[f.end] == null ? '未结束' : Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 3600000 : null
    }
  }
  // 按查询返回顺序展示前 N 行；图表和统计仍使用完整 record.rows。
  tables.push(table('查询明细', titles, details.length > MAX_INLINE_DETAIL_ROWS ? details.slice(0, MAX_INLINE_DETAIL_ROWS) : details))
  // 分布只使用测点定义/实时行集，历史采样和异常条数不能当作测点数量。
  if (f.id && !f.historical && !f.start) {
    for (const [id, label, field] of [
      ['point_types', '监测类型数量', f.type], ['point_names', '监测点名称数量', f.pointName],
      ['value_statuses', '监测值状态数量', f.status], ['device_statuses', '测点设备状态数量', f.deviceStatus],
    ] as const) {
      if (!field) continue
      const counts = new Map<string, Set<string>>()
      for (const row of record.rows) {
        if (row[f.id] == null) continue
        const key = text(row, field)
        if (!counts.has(key)) counts.set(key, new Set())
        counts.get(key)!.add(String(row[f.id]))
      }
      const rows = [...counts].map(([category, points]) => ({ category, count: points.size }))
      datasets.push({ id, title: label, columns: [{ name: 'category', title: label, type: 'category' }, { name: 'count', title: '测点数量', type: 'number', unit: '个' }], rows })
      tables.push(table(label, ['分类', '测点数量'], rows.map(row => ({ 分类: row.category, 测点数量: row.count }))))
    }
  }
  const valueField = f.current ?? f.historical
  if (valueField && f.label) {
    const groups = new Map<string, { type: string; unit: string; rows: ChartRow[] }>()
    for (const row of record.rows) {
      const type = text(row, f.type); const unit = text(row, f.unit)
      const key = JSON.stringify([type, unit])
      if (!groups.has(key)) groups.set(key, { type, unit, rows: [] })
      const value = row[valueField]
      groups.get(key)!.rows.push({ point: text(row, f.label), value: typeof value === 'number' && Number.isFinite(value) ? value : null,
        ...(f.time ? { time: scalar(row[f.time]) } : {}) })
    }
    const stats: Row[] = []
    for (const [key, group] of groups) {
      const history = !!f.historical
      const rows = history ? group.rows.toSorted((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? ''))) : group.rows
      const id = `${history ? 'history' : 'realtime'}_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
      if (!history || f.time) datasets.push({ id, title: `${group.type}（${group.unit}）${history ? '历史趋势' : '实时值'}`,
        columns: [{ name: 'point', title: '监测点名称及编码', type: 'category' }, { name: 'value', title: group.type, type: 'number', ...(group.unit === '未提供' ? {} : { unit: group.unit }) },
          ...(f.time ? [{ name: 'time', title: '监测时间', type: 'time' as const }] : [])], rows })
      const points = new Map<string, number[]>()
      for (const row of rows) {
        const name = String(row.point)
        if (!points.has(name)) points.set(name, [])
        if (typeof row.value === 'number') points.get(name)!.push(row.value)
      }
      for (const [point, values] of points) stats.push({ 监测类型: group.type, 监测点: point, 单位: group.unit, 有效记录数: values.length,
        最小值: values.length ? values.reduce((a, b) => Math.min(a, b)) : null,
        最大值: values.length ? values.reduce((a, b) => Math.max(a, b)) : null,
        均值: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null })
    }
    tables.push(table(f.historical ? '历史指标统计' : '实时指标统计', ['监测类型', '监测点', '单位', '有效记录数', '最小值', '最大值', '均值'], stats))
  }
  const summary = record.outcome === 'error' ? `查询失败：${record.error?.message ?? '原因未提供'}；不能据此判断无事件或运行正常。`
    : record.outcome === 'no_data' ? '查询成功，未查到符合条件的记录；不能据此判断系统或设备运行正常。' : `查询成功，返回${record.row_count}条明细；统计仅依据本次查询结果。`
  const detailDatasets = datasets.filter(dataset => dataset.id.startsWith('history_') || dataset.id.startsWith('realtime_')).map(dataset => dataset.id)
  const truncation = details.length > MAX_INLINE_DETAIL_ROWS
    ? `\n明细共 ${details.length} 行，正文仅展示前 ${MAX_INLINE_DETAIL_ROWS} 行，完整数据已保留在${detailDatasets.length ? `图表数据集 ${detailDatasets.join('、')} 中` : '查询结果文件中'}。` : ''
  const points = f.id && !f.historical && !f.start && record.outcome === 'success'
    ? `\n按返回测点标识去重数量：${new Set(record.rows.filter(row => row[f.id!] != null).map(row => String(row[f.id!]))).size}；不能把明细行数直接当作测点数。` : ''
  const scope = record.semantic_query ? `\n实际查询条件：${JSON.stringify({ models: record.semantic_query.models, filters: record.semantic_query.filters, time_dimensions: record.semantic_query.time_dimensions })}` : ''
  return { value: result(record.query_goal, summary + truncation + points + scope, tables), datasets }
}
