/** Harness 原生工具定义：统一结果校验、模型摘要与持久化展示投影。 */
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { presentation } from './shared.ts'
import { WaterHazardBusiness } from './water-hazard/business.ts'

const outputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    version: { type: 'number', const: 1, required: true }, title: { type: 'string', required: true }, summary: { type: 'string', required: true },
    period: { type: 'object', additionalProperties: false, properties: { start: { type: 'string', required: true }, end: { type: 'string', required: true } } },
    data: { type: 'json', required: true },
    tables: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        key: { type: 'string', required: true }, title: { type: 'string', required: true },
        columns: { type: 'array', items: { type: 'string' }, required: true },
        rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
      },
    } },
    charts: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        key: { type: 'string', required: true }, title: { type: 'string', required: true }, hasData: { type: 'boolean', required: true },
        option: { type: 'object', additionalProperties: true, required: true },
      },
    } },
  },
} as const satisfies ValueSchemaSpec

/** 创建可直接注册、可由原生工具执行管线验证的五个工具。 */
export function createTools(business: WaterHazardBusiness) {
  const output = {
    schema: outputSchema,
    render: (_args: object, value: { summary: string }) => [{ type: 'text' as const, text: `${value.summary}\n\n完整表格和交互图表已保存，将显示在本轮报告下方的水害分析结果区。请直接引用摘要中的统计，不重复输出明细表或图表配置。` }],
    presentationMeta: (_args: object, value: Parameters<typeof presentation>[0]) => presentation(value),
  }
  return [
    defineTool({ name: 'get_device_status', description: '查询水文监测设备区域、类型、在线离线统计，生成设备类型占比图。', parameters: {}, output,
      execute: (_args, exec) => business.deviceStatus(exec.signal), presentCall: () => ({ card: 'generic', title: '查询水文监测设备' }) }),
    defineTool({ name: 'get_device_alarm', description: '按配置参考日期查询最近30天全部单因素测点报警，保留已处置及误报，返回等级、处置统计及蓝黄橙红阈值。', parameters: {}, output,
      execute: (_args, exec) => business.deviceAlarm(exec.signal), presentCall: () => ({ card: 'generic', title: '查询单因素报警' }) }),
    defineTool({ name: 'get_model_warning', description: '查询配置参考日期最近30天模型预警，说明关联指标和判识模型，保留全部处置和误报状态。', parameters: {}, output,
      execute: (_args, exec) => business.modelWarning(exec.signal), presentCall: () => ({ card: 'generic', title: '查询多因素模型预警' }) }),
    defineTool({ name: 'get_warning_statistics', description: '查询预警统计页最近30天真实数据，生成按类型、等级的饼图和按日柱状图。', parameters: {}, output,
      execute: (_args, exec) => business.warningStatistics(exec.signal), presentCall: () => ({ card: 'generic', title: '查询预警统计' }) }),
    defineTool({ name: 'get_hydrological_trend', description: '查询矿井涌水量、排水量、ZK4长观孔水位、中央水仓水位的原始趋势、均值、极值和测点预警次数。默认截至配置参考日30天；显式日期成对提供，最多31天。',
      parameters: { start_time: { type: 'string', description: '开始日期 YYYY-MM-DD；未指定日期时省略。' }, end_time: { type: 'string', description: '结束日期 YYYY-MM-DD；与 start_time 同时提供。' } }, output,
      execute: (args, exec) => business.hydrologicalTrend(exec.signal, args.start_time, args.end_time), presentCall: () => ({ card: 'generic', title: '分析水文历史趋势' }) }),
  ]
}
