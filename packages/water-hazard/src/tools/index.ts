/** 原生工具仅定义参数、输出和业务调用，不持有会话或 UI 状态。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChartSources } from 'dsh-agent-charts'
import { resultSchema, renderResult } from 'dsh-agent-shared'
import { chartResultSchema, renderChartResult, withChartSource } from '../presentation/chart-result.ts'
import type { WaterHazardAPI } from '../infrastructure/api.ts'
import { deviceStatus, deviceDatasets } from '../services/devices.ts'
import { deviceAlarm, modelWarning, warningStatistics, warningDatasets } from '../services/warnings.ts'
import { hydrologicalTrend, trendDatasets } from '../services/trends.ts'
import { locationWorkface } from '../services/workfaces.ts'
import { reportSummary } from '../services/knowledge.ts'
import { roofWarning } from '../services/roof.ts'
import { inrushSimulation } from '../services/simulation.ts'
import { hydrologicalReview } from '../services/review.ts'

export const TOOL_NAMES = ['get_device_status', 'get_device_alarm', 'get_model_warning', 'get_warning_statistics', 'get_hydrological_trend', 'get_location_workface', 'get_report_summary', 'analyze_roof_water_warning', 'get_inrush_simulation', 'get_hydrological_review'] as const
const output = { schema: resultSchema, render: renderResult }
const chartOutput = { schema: chartResultSchema, render: renderChartResult }

/** 为本领域的接口客户端创建十个可卸载的工具定义。 */
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
    defineTool({ name: 'get_location_workface', description: '加载可用工作面列表与当前工作面，其他工作面业务工具使用列表中的真实编号。', parameters: {},
      output: { schema: { ...resultSchema, properties: { ...resultSchema.properties,
        workfaces: { type: 'array', required: true, items: { type: 'string' } }, current_workface: { type: 'string', required: true },
      } }, render: renderResult }, execute: (_args, exec) => locationWorkface(api, exec.signal) }),
    defineTool({ name: 'get_report_summary', description: '从本地原始资料全文检索近期防治水重点，按掘进、回采分类及危险程度排序，保留文档所属年月。',
      parameters: { query: { type: 'string', required: true, description: '从问题提取检索关键词，综合查询可用水害分析预报表。' }, n_chunks: { type: 'integer', description: '检索片段数，默认30，范围1至100。' } },
      output, execute: async (args, exec) => { exec.signal.throwIfAborted(); return reportSummary(args.query, args.n_chunks) } }),
    defineTool({ name: 'analyze_roof_water_warning', description: '分析指定工作面的顶板静态三图、五项动态指标及综合预警。各阶段独立报告，静态或动态失败时不执行综合判定。',
      parameters: { workface: { type: 'string', required: true, description: '可用工作面编号。' }, start_time: { type: 'string', required: true, description: '开始日期 YYYY-MM-DD。' }, end_time: { type: 'string', required: true, description: '结束日期 YYYY-MM-DD。' } },
      output: { schema: { ...chartResultSchema, properties: { ...chartResultSchema.properties,
        stages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          stage: { type: 'string', required: true }, status: { type: 'string', enum: ['成功', '失败', '未执行'], required: true }, reason: { type: 'string', required: true },
        } } },
      } }, render: renderChartResult },
      execute: async (args, exec) => {
        const { value, documents } = await roofWarning(api, exec.signal, args.workface, args.start_time, args.end_time)
        const chart_source = sources?.prepare(exec, [], documents)
        return chart_source ? { ...value, chart_source } : value
      } }),
    defineTool({ name: 'get_inrush_simulation', description: '执行本地水淹仿真及最多10名随机抽样人员的避灾路线计算，返回完整表格、SVG HTML图形目录及应急演练参考片段。',
      parameters: { workface: { type: 'string', required: true, description: '可用工作面编号。' }, inrush_rate: { type: 'number', description: '突水量 m³/h，默认1800，须为有限正数。' }, simulation_time: { type: 'number', description: '评估时长秒，默认86400，须为有限正数。' } }, output: chartOutput,
      execute: async (args, exec) => {
        const { value, documents } = await inrushSimulation(api, exec.signal, args.workface, args.inrush_rate, args.simulation_time)
        const chart_source = sources?.prepare(exec, [], documents)
        return chart_source ? { ...value, chart_source } : value
      } }),
    defineTool({ name: 'get_hydrological_review', description: '计算工作面六项水文关联监测的周期质量、极值、趋势、前兆与水量响应，检索预报和规范依据，为四章周期复盘报告提供真实数据。',
      parameters: { workface: { type: 'string', required: true, description: '可用工作面编号。' }, start_time: { type: 'string', description: '开始日期 YYYY-MM-DD，与 end_time 同时提供；默认近30天。' }, end_time: { type: 'string', description: '结束日期 YYYY-MM-DD，与 start_time 同时提供。' } },
      output, execute: (args, exec) => hydrologicalReview(api, exec.signal, args.workface, args.start_time, args.end_time) }),
  ]
}
