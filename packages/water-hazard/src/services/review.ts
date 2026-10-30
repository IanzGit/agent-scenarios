/** 周期复盘统计，保持原监测范围、日末值及前兆判识口径。 */
import { result, table, type Row } from 'dsh-agent-shared'
import { dateValue } from '../config.ts'
import { WaterHazardAPI, resolvePeriod } from '../infrastructure/api.ts'
import { dailyLast, history, FACE_SENSORS, EXTRA_SENSORS, type History } from './history.ts'
import { validateWorkface } from './workfaces.ts'
import { documentEvidence, searchDocuments } from './knowledge.ts'
import { round } from '../domain/numeric.ts'

const order = ['涌水量', '排水量', '密闭水压', '长观孔水位', '河流渗漏量', '降雨量']
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
export function reviewStatistics(records: History[], start: string, end: string) {
  const daily = dailyLast(records)
  if (!daily.length) throw new Error(`${start}至${end}指定周期无有效水文监测数据`)
  const expected = (dateValue(end) - dateValue(start)) / 86400000 + 1
  const quality: Row[] = [], statistics: Row[] = [], precursors: Row[] = []
  for (const metric of order) {
    const values = daily.filter(row => row.metric === metric)
    if (!values.length) continue
    const raw = records.filter(row => row.metric === metric && row.value !== null).map(row => row.value!)
    const first = values[0], unit = first.unit || '单位未提供'
    quality.push({ 指标: metric, 监测点: first.source, 传感器: first.sensor, 单位: unit, 周期样本数: values.length, 周期应有样本数: expected, 有效记录数: raw.length, 数据覆盖率: `${round(values.length / expected * 100, 1).toFixed(1)}%`, 监测范围: first.scope })
    let direction = '样本不足'
    if (values.length >= 2) {
      const xs = values.map(row => (dateValue(row.date.slice(0, 10)) - dateValue(first.date.slice(0, 10))) / 86400000)
      const ys = values.map(row => row.value), mx = mean(xs), my = mean(ys)
      const slope = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
      const change = slope * xs.at(-1)!, threshold = Math.max(Math.abs(my) * 0.001, 0.001)
      direction = change > threshold ? '上升' : change < -threshold ? '下降' : '平稳'
    }
    statistics.push({ 指标: metric, 单位: unit, 统计口径: '极值取接口有效监测点，趋势取每日末条有效值', 最大值: round(Math.max(...raw), 4), 最小值: round(Math.min(...raw), 4), 变化趋势: direction, 监测点: first.source, 监测范围: first.scope })
    for (let i = 1; i < values.length; i++) {
      const consecutive = dateValue(values[i].date.slice(0, 10)) - dateValue(values[i - 1].date.slice(0, 10)) === 86400000
      const growth = values[i - 1].value ? (values[i].value - values[i - 1].value) / values[i - 1].value : 0
      if (metric === '涌水量' && consecutive && growth > 0.2) {
        precursors.push({ 日期: values[i].date.slice(0, 10), 类型: '涌水量骤增', 严重程度: '预警', 详情: `涌水量日增长${(growth * 100).toFixed(1)}%，超过20%预警阈值`, 建议: '立即检查涌水量异常原因，排查是否存在突水风险' }); break
      }
      if (metric === '长观孔水位' && i >= 2 && consecutive && dateValue(values[i - 1].date.slice(0, 10)) - dateValue(values[i - 2].date.slice(0, 10)) === 86400000
        && values[i].value < values[i - 1].value - 0.5 && values[i - 1].value < values[i - 2].value - 0.5) {
        precursors.push({ 日期: values[i].date.slice(0, 10), 类型: '水位持续下降', 严重程度: '注意', 详情: '连续3天水位下降超过0.5m，达到关注阈值', 建议: '加密水位观测频率，核查监测数据' }); break
      }
    }
  }
  const levels = daily.filter(row => row.metric === '长观孔水位')
  const flows = new Map(daily.filter(row => row.metric === '涌水量').map(row => [row.date.slice(0, 10), row.value]))
  const paired = levels.filter(row => flows.has(row.date.slice(0, 10)))
  const response: Row[] = []
  if (paired.length >= 5 && new Set(paired.map(row => row.value)).size >= 2) {
    const xs = paired.map(row => row.value), ys = paired.map(row => flows.get(row.date.slice(0, 10))!), mx = mean(xs), my = mean(ys)
    const change = -xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
    const row: Row = { 配对样本数: paired.length, 水位每降低1m涌水量变化: round(Math.abs(change), 4), 变化方向: change > 0 ? '增加' : change < 0 ? '减少' : '无变化', 单位: 'm³/h' }
    for (const threshold of [...new Set(xs)].sort((a, b) => b - a)) {
      const selected = ys.filter((_, i) => xs[i] <= threshold)
      if (selected.length < 5 || mean(selected) <= 0) continue
      const deviation = Math.sqrt(selected.reduce((sum, value) => sum + (value - mean(selected)) ** 2, 0) / (selected.length - 1))
      if (deviation / mean(selected) <= 0.1) { row.稳定水位阈值 = round(threshold, 4); break }
    }
    response.push(row)
  }
  const rising = statistics.filter(row => row.变化趋势 === '上升').map(row => row.指标)
  const missing = order.filter(metric => !statistics.some(row => row.指标 === metric))
  const low = quality.filter(row => parseFloat(String(row.数据覆盖率)) < 70).map(row => row.指标)
  const conclusion = `本周期共分析${statistics.length}项水文指标。呈上升趋势的指标为${rising.join('、') || '无'}。`
    + (missing.length ? `缺少有效监测数据：${missing.join('、')}。` : '') + (precursors.length ? `识别出${precursors.length}项预警前兆。` : '')
    + (response.length ? '已形成工作面涌水量与长观孔水位的监测统计拟合。' : '') + (low.length ? `${low.join('、')}数据覆盖率低于70%，相关结论需结合后续监测复核。` : '')
  return { quality, statistics, precursors, response, conclusion }
}
export async function hydrologicalReview(api: WaterHazardAPI, signal: AbortSignal, workface: string, start = '', end = '') {
  workface = await validateWorkface(api, workface, signal)
  const period = resolvePeriod(api.settings, start, end, Infinity)
  const sensors = api.settings.sensors
  const specs = [
    [FACE_SENSORS[workface], '涌水量', `${workface}涌水量`, workface === '45208' ? '涌水量' : '85211涌水量', `${workface}工作面`],
    [sensors.drainage, '排水量', '八盘区水泵房', '中央平泵房排水量', '八盘区'],
    [sensors.borehole, '长观孔水位', '第四系钻孔ZK4', '水位', '矿区第四系钻孔'],
    [EXTRA_SENSORS.sealed, '密闭水压', '85209运顺密闭', '水压', '邻近85209工作面'],
    [EXTRA_SENSORS.river, '河流渗漏量', '红石墕沟中游', '渗漏量', '地表河流'],
    [EXTRA_SENSORS.rain, '降雨量', '办公楼顶气象站', '降雨量', '矿区地表'],
  ]
  const records = (await Promise.all(specs.map(([id, metric, source, sensor, scope]) => history(api, id, period, signal, metric, source, sensor, scope)))).flat()
  const data = reviewStatistics(records, period.start, period.end)
  const evidence = [
    documentEvidence(searchDocuments(`${workface}工作面 地质 水害预报`, 5, ['水害预报通知书'], workface), '通知书', 1500),
    documentEvidence(searchDocuments(`${workface}工作面 水害分析预报`, 5, ['水害分析预报表'], workface), '预报表', 1500),
    documentEvidence(searchDocuments('顶板水防治 底板水防治 老空水害防治 技术', 3, ['防治水细则']), '条款', 1000),
  ].filter(Boolean).join('\n\n')
  return result('矿井水害防治复盘报告', `工作面：${workface}｜复盘周期：${period.start}至${period.end}\n\n${data.conclusion}\n水量响应为监测数据统计拟合，不代表因果关系。\n\n${evidence}`, [
    table('周期数据质量', ['指标', '监测点', '传感器', '单位', '周期样本数', '周期应有样本数', '有效记录数', '数据覆盖率', '监测范围'], data.quality),
    table('周期监测统计', ['指标', '单位', '最大值', '最小值', '变化趋势', '监测点', '监测范围', '统计口径'], data.statistics),
    table('预警前兆识别', ['日期', '类型', '严重程度', '详情', '建议'], data.precursors),
    table('水量响应', ['配对样本数', '水位每降低1m涌水量变化', '变化方向', '单位', '稳定水位阈值'], data.response),
  ], period)
}
