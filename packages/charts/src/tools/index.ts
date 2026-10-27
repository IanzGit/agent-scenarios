/** preset 内的图表工具插件入口，不创建服务或加载场景。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../service.ts'
import * as line from './line.ts'
import * as bar from './bar.ts'
import * as pie from './pie.ts'
import * as stackedBar from './stacked-bar.ts'
import * as scatter from './scatter.ts'

const tools = [line, bar, pie, stackedBar, scatter]
export const CHART_TOOL_NAMES = tools.map(tool => tool.name)
export const name = 'chart-tools'
export const inject = ['tools', 'chartSources']

/** 将五类工具注册到调用者所属 preset，注册随插件一起释放。 */
export function apply(ctx: Context): void {
  for (const tool of tools) ctx.tools.register(tool.createTool(ctx.chartSources))
}
