/** 静态、动态与综合阶段独立报告；取消始终传播。 */
import { result, table, type Row, type Period } from 'dsh-agent-shared'
import type { HtmlDocument } from 'dsh-agent-charts'
import { WaterHazardAPI, numeric, resolvePeriod } from '../infrastructure/api.ts'
import { staticAnalysis, type StaticAnalysis } from '../domain/roof-static.ts'
import { comprehensiveWarning, dynamicIndicators, type Dynamic } from '../domain/roof-dynamic.ts'
import { WATER_LEVELS, WLEVEL_NAMES } from '../domain/constants.ts'
import { roofMaps } from '../presentation/roof-maps.ts'
import { validateWorkface } from './workfaces.ts'
import { dailyLast, history, FACE_SENSORS, EXTRA_SENSORS } from './history.ts'

export type Stage = { stage: string; status: '成功' | '失败' | '未执行'; reason: string }
export async function roofWarning(api: WaterHazardAPI, signal: AbortSignal, workface: string, start: string, end: string) {
  workface = await validateWorkface(api, workface, signal)
  const stages: Stage[] = [], documents: HtmlDocument[] = [], descriptions: string[] = [], tables = []
  let analysis: StaticAnalysis | undefined, dynamic: Dynamic[] | undefined, period: Period | undefined
  try {
    analysis = await staticAnalysis(workface, signal)
    documents.push({ id: 'roof_maps', title: `${workface}工作面顶板水害三图`, html: roofMaps(workface, analysis) })
    descriptions.push(`静态指标：${analysis.maps.map(map => `${map.title}为${WATER_LEVELS[map.kind][map.level][2]}`).join('；')}。`)
    stages.push({ stage: '静态指标', status: '成功', reason: '' })
  } catch (error) { signal.throwIfAborted(); stages.push({ stage: '静态指标', status: '失败', reason: error instanceof Error ? error.message : String(error) }) }
  try {
    if (!start.trim() || !end.trim()) throw new Error('start_time 和 end_time 必须为 YYYY-MM-DD 格式')
    period = resolvePeriod(api.settings, start, end, Infinity)
    const specs = [
      [FACE_SENSORS[workface], '涌水量', `${workface}涌水量`, workface === '45208' ? '涌水量' : '85211涌水量'],
      [api.settings.sensors.borehole, '含水层水位', '第四系钻孔ZK4', '水位'],
      [EXTRA_SENSORS.quality, '在线水质', '中央水仓水质', 'PH'],
      [EXTRA_SENSORS.pressure, '水压', '85212辅撤回通道', '水压'],
    ]
    const histories = await Promise.all(specs.map(async ([id, metric, source, sensor]) => dailyLast(await history(api, id, period!, signal, metric, source, sensor, `${workface}关联监测`))))
    const missing = histories.flatMap((values, i) => values.length < 7 ? [`${specs[i][1]}需7条，实际${values.length}条`] : [])
    if (missing.length) throw new Error(`工作面 ${workface} 动态监测数据不足：${missing.join('；')}`)
    const structure = (await api.structures(signal)).find(row => row.name === `${workface}回采最近积水区距离`)
    if (!structure) throw new Error('构造距离缺少数据')
    const config = (await api.singleConfigs(signal)).find(row => row.singleId === EXTRA_SENSORS.pressure)
    if (!config) throw new Error('85212辅撤回通道水压预警配置缺失')
    if (config.isOpenWarn !== 1 && config.isOpenWarn !== '1') throw new Error('85212辅撤回通道水压预警配置未启用')
    const thresholds = ['blueValue', 'yellowValue', 'orangeValue', 'redValue'].map(key => numeric(config[key], key))
    if (thresholds[0] < 0 || thresholds.some((value, i) => i > 0 && value <= thresholds[i - 1])) throw new Error('水压预警阈值必须非负且按蓝黄橙红严格递增')
    if (histories[3].some(row => row.unit && row.unit !== 'MPa')) throw new Error('85212辅撤回通道水压单位必须为 MPa')
    dynamic = dynamicIndicators(histories[0], histories[1], histories[2], histories[3], thresholds, numeric(structure.value, '构造距离'))
    descriptions.push(dynamic.map(item => item.description).join('\n'))
    const values: Row[] = dynamic.map(item => ({ 监测指标: item.name, 当前值: `${item.value}${item.unit ? ` ${item.unit}` : '（单位未提供）'}`, 预警等级: WLEVEL_NAMES[item.level], 判断依据: item.basis }))
    tables.push(table('监测动态指标状态表', ['监测指标', '当前值', '预警等级', '判断依据'], values))
    stages.push({ stage: '动态指标', status: '成功', reason: '' })
  } catch (error) { signal.throwIfAborted(); stages.push({ stage: '动态指标', status: '失败', reason: error instanceof Error ? error.message : String(error) }) }
  if (stages.some(stage => stage.status === '失败')) stages.push({ stage: '综合预警', status: '未执行', reason: `${stages.filter(stage => stage.status === '失败').map(stage => stage.stage).join('、')}分析失败，无法进行综合预警判定` })
  else {
    try {
      const comprehensive = comprehensiveWarning(workface, analysis!.maps.map(map => map.level), dynamic!)
      descriptions.push(comprehensive.summary)
      tables.push(table('综合指标等级与判断依据明细表', ['指标', '预警等级', '判断依据'], comprehensive.details), table('综合指标分析结果表', ['参数', '状态'], comprehensive.analysis))
      stages.push({ stage: '综合预警', status: '成功', reason: '' })
    } catch (error) { signal.throwIfAborted(); stages.push({ stage: '综合预警', status: '失败', reason: error instanceof Error ? error.message : String(error) }) }
  }
  tables.unshift(table('分析阶段状态', ['阶段', '状态', '原因'], stages.map(stage => ({ 阶段: stage.stage, 状态: stage.status, 原因: stage.reason }))))
  return { value: { ...result(`${workface}工作面顶板水害预警分析`, descriptions.join('\n\n'), tables, period), stages }, documents }
}
