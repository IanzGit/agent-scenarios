/** 五项动态评分及综合预警；所有临界区间沿用原算法。 */
import type { Row } from 'dsh-agent-shared'
import { SINGLE_FACTOR_RULES, WLEVEL_NAMES, WLEVEL_RESPONSE_MEASURES, WATER_LEVELS } from './constants.ts'
import { round } from './numeric.ts'

export type DynamicKey = keyof typeof SINGLE_FACTOR_RULES | 'water_pressure'
export type Dynamic = { key: DynamicKey; name: string; value: number; unit: string; level: number; basis: string; description: string }
export type DailyValue = { value: number; unit: string }
export function dynamicIndicators(inflow: DailyValue[], borehole: DailyValue[], quality: DailyValue[], pressure: DailyValue[], thresholds: number[], distance: number): Dynamic[] {
  const average = (values: DailyValue[]) => values.reduce((sum, row) => sum + row.value, 0) / values.length
  const current = (values: DailyValue[]) => values.at(-1)!
  const inflowMean = average(inflow)
  if (!inflowMean) throw new Error('涌水量周期均值为0，无法计算增幅')
  const increase = round((current(inflow).value - inflowMean) / inflowMean * 100, 1)
  const inflowLevel = increase < 30 ? 0 : increase < 50 ? 1 : increase < 80 ? 2 : increase < 100 ? 3 : 4
  const waterMean = average(borehole), waterValues = borehole.map(row => row.value), variation = Math.max(...waterValues) - Math.min(...waterValues)
  const deviation = Math.abs(current(borehole).value - waterMean), drop = waterMean - current(borehole).value
  let waterLevel = 0
  for (const [level, [multiplier, minimum]] of Object.entries(SINGLE_FACTOR_RULES.aquifer_water_level.thresholds)) if (deviation > multiplier * variation && drop >= minimum) waterLevel = Number(level)
  const ph = current(quality).value
  const phLevel = ph >= 6.5 && ph <= 8.5 ? 0 : ph >= 6 && ph <= 9 ? 1 : ph >= 5.5 && ph <= 9.5 ? 2 : ph >= 5 && ph <= 10 ? 3 : 4
  const distanceLevel = distance < 0 || distance >= 120 ? 0 : distance >= 90 ? 1 : distance >= 60 ? 2 : distance >= 30 ? 3 : 4
  const pressureLevel = thresholds.filter(threshold => current(pressure).value >= threshold).length
  const basis = (key: keyof typeof SINGLE_FACTOR_RULES, level: number) => (SINGLE_FACTOR_RULES[key].judge_basis as Record<number, string>)[level]
  const metrics: Omit<Dynamic, 'description'>[] = [
    { key: 'water_inflow', name: '涌水量', ...current(inflow), level: inflowLevel, basis: basis('water_inflow', inflowLevel) },
    { key: 'aquifer_water_level', name: '含水层水位', ...current(borehole), level: waterLevel, basis: basis('aquifer_water_level', waterLevel) },
    { key: 'water_quality', name: '在线水质(PH)', ...current(quality), level: phLevel, basis: basis('water_quality', phLevel) },
    { key: 'structure_distance', name: '构造距离', value: distance, unit: 'm', level: distanceLevel, basis: basis('structure_distance', distanceLevel) },
    { key: 'water_pressure', name: '水压', ...current(pressure), level: pressureLevel, basis: `预警阈值${thresholds.join('/')}MPa` },
  ]
  const details = [
    `周期平均涌水量${round(inflowMean, 2)}${current(inflow).unit || '（单位未提供）'}，周期末次有效值${current(inflow).value}${current(inflow).unit || '（单位未提供）'}，增幅${increase}%`,
    `周期平均水位${round(waterMean, 2)}${current(borehole).unit || '（单位未提供）'}，最大变幅${round(variation, 2)}，当前值较均值偏离${round(deviation, 2)}`,
    `周期平均PH${round(average(quality), 2)}，当前PH${ph}`,
    `当前工作面距离最近积水区${distance}m`,
    `周期末次有效水压${current(pressure).value}${current(pressure).unit || '（单位未提供）'}`,
  ]
  return metrics.map((metric, index) => ({ ...metric, description: `${metric.name}：${details[index]}，${WLEVEL_NAMES[metric.level]}。` }))
}
export function comprehensiveWarning(workface: string, staticLevels: number[], dynamic: Dynamic[]) {
  const [richness, channel, hazard] = staticLevels
  const get = (key: DynamicKey) => dynamic.find(item => item.key === key)!
  const levels = dynamic.map(item => item.level), count = (level: number) => levels.filter(value => value === level).length
  const composite = count(4) || count(3) >= 2 ? 4 : count(3) === 1 || count(2) >= 3 ? 3 : count(2) ? 2 : 0
  const distance = get('structure_distance').level, inflow = get('water_inflow').level
  let rule = ''
  if (composite === 4 || hazard === 4) rule = '紧急规则R1（单一指标极端风险）：' + [composite === 4 ? '监测指标复合预警为红色预警' : '', hazard === 4 ? '顶板预警为红色预警' : ''].filter(Boolean).join('、')
  else if (inflow >= 3) rule = '紧急规则R1（单一指标极端风险）：涌水量临突征兆'
  else if (distance === 3 && composite === 3 && hazard === 3) rule = '紧急规则R2（关键指标高风险）：距离预警、复合预警、顶板预警同时为橙色预警'
  else if (composite === 3 && (distance >= 3 || hazard >= 3)) rule = `紧急规则R3（系统失稳风险）：复合预警为橙色预警且${[distance >= 3 ? `距离预警为${WLEVEL_NAMES[distance]}` : '', hazard >= 3 ? `顶板预警为${WLEVEL_NAMES[hazard]}` : ''].filter(Boolean).join('且')}`
  const s1 = round(0.058 * richness + 0.058 * get('water_pressure').level + 0.124 * hazard + 0.058 * get('aquifer_water_level').level + 0.124 * distance)
  const s2 = round(0.703 * channel + 0.209 * get('water_quality').level)
  const level = rule ? 4 : Math.max(0, Math.min(4, round(Math.max(s1, s2) * (inflow >= 3 ? 1 + 0.1 * (inflow - 2) : 1))))
  const warning = WLEVEL_NAMES[level] + (rule ? '（紧急规则触发）' : '')
  const details: Row[] = [
    { 指标: '富水性等级(C1)', 预警等级: WATER_LEVELS.richness[richness][2], 判断依据: '顶板含水层富水性分区' },
    { 指标: '水压(C2)', 预警等级: WLEVEL_NAMES[get('water_pressure').level], 判断依据: get('water_pressure').basis },
    { 指标: '危险性等级(C3)', 预警等级: WATER_LEVELS.hazard[hazard][2], 判断依据: '顶板水害危险性分区' },
    { 指标: '含水层水位(C4)', 预警等级: WLEVEL_NAMES[get('aquifer_water_level').level], 判断依据: get('aquifer_water_level').basis },
    { 指标: '构造距离(C5)', 预警等级: WLEVEL_NAMES[distance], 判断依据: get('structure_distance').basis },
    { 指标: '导通等级(C6)', 预警等级: WATER_LEVELS.channel[channel][2], 判断依据: '顶板冒裂安全性分区' },
    { 指标: '在线水质(C7)', 预警等级: WLEVEL_NAMES[get('water_quality').level], 判断依据: get('water_quality').basis },
    { 指标: '涌水量(C8)', 预警等级: WLEVEL_NAMES[inflow], 判断依据: get('water_inflow').basis },
  ]
  const analysis: Row[] = rule ? [{ 参数: '紧急规则', 状态: rule }, { 参数: '预警等级', 状态: warning }] : [
    { 参数: '紧急规则', 状态: '未触发' }, { 参数: '水源危险性', 状态: WLEVEL_NAMES[s1] }, { 参数: '通道危险性', 状态: WLEVEL_NAMES[s2] }, { 参数: '预警等级', 状态: warning },
  ]
  const formula = rule ? '' : '**综合指标分计算：**\n\n$$S_1 = 0.058C_1 + 0.058C_2 + 0.124C_3 + 0.058C_4 + 0.124C_5$$\n\n$$S_2 = 0.703C_6 + 0.209C_7$$\n\n$$R = \\max(S_1,S_2)$$\n\n$$R_Z = \\max(0,\\min(4,\\mathrm{round}(R \\cdot \\mathit{factor})))$$'
  const summary = `${workface}工作面水害预警状态为${warning}。${rule ? `触发${rule}。停产撤人，启动应急预案。` : `当前未出现单一指标极端风险、关键指标高风险、系统失稳风险。${WLEVEL_RESPONSE_MEASURES[level]}`}\n\n${formula}`
  return { level, warning, rule, details, analysis, summary }
}
