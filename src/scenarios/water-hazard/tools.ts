/** 原生工具仅定义参数、输出和业务调用，不持有会话或 UI 状态。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from 'dsh-agent-charts'
import { resultSchema, renderResult } from '../../shared/result.ts'
import { chartResultSchema, renderChartResult, withChartSource } from '../../shared/chart-result.ts'
import type { WaterHazardAPI } from './api.ts'
import { deviceStatus, deviceDatasets } from './services/devices.ts'
import { deviceAlarm, modelWarning, warningStatistics, warningDatasets } from './services/warnings.ts'
import { hydrologicalTrend, trendDatasets } from './services/trends.ts'

export const TOOL_NAMES = ['get_device_status', 'get_device_alarm', 'get_model_warning', 'get_warning_statistics', 'get_hydrological_trend'] as const
const output = { schema: resultSchema, render: renderResult }
const chartOutput = { schema: chartResultSchema, render: renderChartResult }

/** 为本领域的接口客户端创建五个可卸载的工具定义。 */
export function createTools(api: WaterHazardAPI, sources?: ChartSources) {
  return [
    defineTool({ name: 'get_device_status', description: '查询水文监测设备区域、类型、在线离线统计，返回完整统计表。', parameters: {}, output: chartOutput,
      execute: async (_args, exec) => { const value = await deviceStatus(api, exec.signal); return withChartSource(value, exec, sources, deviceDatasets(value)) } }),
    defineTool({ name: 'get_device_alarm', description: '按配置参考日期查询最近30天全部单因素测点报警，保留已处置及误报，返回等级、处置统计及蓝黄橙红阈值明细表。', parameters: {}, output,
      execute: (_args, exec) => deviceAlarm(api, exec.signal) }),
    defineTool({ name: 'get_model_warning', description: '查询配置参考日期最近30天模型预警，说明关联指标和判识模型，保留全部处置和误报状态及完整明细表。', parameters: {}, output,
      execute: (_args, exec) => modelWarning(api, exec.signal) }),
    defineTool({ name: 'get_warning_statistics', description: '查询预警统计页最近30天真实数据，返回事件总数摘要；类型、等级和每日数量统计仅作为图表数据源。', parameters: {}, output: chartOutput,
      execute: async (_args, exec) => { const value = await warningStatistics(api, exec.signal); return withChartSource(value, exec, sources, warningDatasets(value)) } }),
    defineTool({ name: 'get_hydrological_trend', description: '查询矿井涌水量、排水量、ZK4长观孔水位、中央水仓水位的均值、极值和测点预警次数。默认截至配置参考日30天；显式日期成对提供，最多31天。结构化结果保留原始时间序列。',
      parameters: { start_time: { type: 'string', description: '开始日期 YYYY-MM-DD；未指定日期时省略。' }, end_time: { type: 'string', description: '结束日期 YYYY-MM-DD；与 start_time 同时提供。' } },
      output: { schema: {
        ...chartResultSchema, properties: { ...chartResultSchema.properties,
          series: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, unit: { type: 'string', required: true },
            source: { type: 'string', required: true }, sensor: { type: 'string', required: true },
            points: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              time: { type: 'string', required: true }, value: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
            } } },
          } } },
        },
      }, render: renderChartResult },
      execute: async (args, exec) => { const value = await hydrologicalTrend(api, exec.signal, args.start_time, args.end_time); return withChartSource(value, exec, sources, trendDatasets(value)) } }),
  ]
}
