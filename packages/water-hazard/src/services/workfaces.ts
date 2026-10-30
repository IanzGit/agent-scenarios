/** 工作面列表与当前盘区关联，沿用原系统支持范围。 */
import { result, table } from 'dsh-agent-shared'
import { WaterHazardAPI, requiredText, text } from '../infrastructure/api.ts'

export const WORKFACES = ['45208', '85211']
export async function availableWorkfaces(api: WaterHazardAPI, signal: AbortSignal): Promise<string[]> {
  const values = await api.structures(signal)
  return [...new Set(values.map(row => String(row.name ?? '').match(/^[0-9]{5}/)?.[0]).filter((name): name is string => Boolean(name && WORKFACES.includes(name))))].sort()
}
export async function validateWorkface(api: WaterHazardAPI, workface: string, signal: AbortSignal): Promise<string> {
  workface = requiredText(workface, 'workface').trim()
  const available = await availableWorkfaces(api, signal)
  if (!available.includes(workface)) throw new Error(`工作面 ${workface} 不可用，可用：${available.join('、') || '无'}`)
  return workface
}
export async function locationWorkface(api: WaterHazardAPI, signal: AbortSignal) {
  const [workfaces, basic] = await Promise.all([availableWorkfaces(api, signal), api.basic(signal)])
  const areas: Record<string, string> = { 四盘区: '45208', 八盘区: '85211' }
  let current_workface = ''
  for (const area of text(basic.currentMiningArea, '').split('、')) if (areas[area.trim()]) current_workface = areas[area.trim()]
  return { ...result('工作面信息', `当前工作面：${current_workface || '未取得'}。可用工作面：${workfaces.join('、') || '无'}。`, [
    table('可用工作面', ['工作面', '当前工作面'], workfaces.map(name => ({ 工作面: name, 当前工作面: name === current_workface ? '是' : '否' }))),
  ]), workfaces, current_workface }
}
