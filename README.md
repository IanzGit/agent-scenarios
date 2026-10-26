# 煤矿场景智能体

基于旁边已编译的 `deepseek-harness` 实现。首批提供**矿井水文监测总体分析**和**关键水文指标趋势分析**；五个原生 tools 执行业务，两个 skills 描述调用流程与报告展示，Web 插件展示完整表格和 ECharts 交互图。生产代码全部为 TypeScript，不调用原 Python 服务，不直连 MySQL / MongoDB。

## 启动

需要 Node.js `^22.19.0 || >=24`、pnpm，以及旁边已经编译完成的 Harness。

```bash
cd agent-scenarios
pnpm install --ignore-scripts
pnpm build
```

参考 `.env.example` 创建 `.env`，配置模型后启动：

```bash
pnpm start:web --no-open
```

首次启动通过官方 `dsh plugin` 把本地 bundle 链接到独立 Web profile，再通过 `dsh web` 启动。打开终端输出的带 token 地址，确认首次提示后即可提问。默认预设为 `water-hazard`。

配置、工作区、会话与模型设置均位于本目录 `.dsh/`，不覆盖原 Harness 的用户配置。默认工作区使用本地目录配置，支持没有 `xdg-user-dir` 的无桌面 Linux。`--port`、`--host`、`--patch` 等选项交给官方启动器；脚本会把相对 patch 路径转换为调用目录下的绝对路径。

### 模型配置

可以在 Harness 的模型设置中配置模型，或在 `.env` 中设置 `DEEPSEEK_API_KEY` 使用 Harness 自带的 DeepSeek 提供器。

本仓库版本的 DeepSeek 提供器使用 Messages 协议。原系统配置的是 OpenAI-compatible 网关时，使用提供的可选配置，不要直接替换 DeepSeek 提供器的地址：

```dotenv
WATER_HAZARD_MODEL_BASE_URL=http://your-gateway/v1
WATER_HAZARD_MODEL_ID=your-model
WATER_HAZARD_MODEL_API_KEY=your-key
WATER_HAZARD_MODEL_CONTEXT_WINDOW=131072
```

```bash
pnpm start:web --no-open --patch config/openai-compatible.patch.yml
```

该配置支持原系统使用的 Qwen 网关，关闭额外思考输出，默认单次输出上限8192 tokens；上下文长度应按实际模型调整。凭据仅通过环境变量引用，不写进 YAML 或会话结果。

### 提问示例

- 当前矿井总体水害监测预警情况汇总分析
- 查询水文监测设备在线离线情况
- 最近30天单因素报警和模型预警情况
- 近30天关键水文指标的变化趋势
- 分析2026-08-01至2026-08-30的水文监测趋势

## 代码与接口

```text
src/index.ts                 Host 注册入口
src/tools.ts                 defineTool、输出 schema、模型摘要与展示投影
src/water-hazard/            配置、接口、业务计算和图表生成
src/shared.ts                Host / Client 共用结果类型与回放校验
src/client/                  会话事件投影、表格和交互图表
skills/                      两个可独立编辑的 SKILL.md
config/                      可选模型网关 overlay
tests/                       固定接口、Harness 循环、Web 及真实模型验证
scripts/                     官方启动器封装、真实业务接口冒烟
```

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `get_device_status` | `{}` | 设备分组、在线离线统计、类型占比图 |
| `get_device_alarm` | `{}` | 单因素事件、处置及等级统计、蓝黄橙红阈值 |
| `get_model_warning` | `{}` | 模型事件、关联指标和判识模型说明 |
| `get_warning_statistics` | `{}` | 统计页总数、类型和等级饼图、每日柱状图 |
| `get_hydrological_trend` | `{start_time?, end_time?}` | 四个测点的统计、预警次数和独立原始趋势图 |

所有工具返回结构化 `BusinessResult`：`version / title / summary / period? / data / tables / charts`。原业务中文字段保留在 `data`。参数和返回结果经过 Harness 校验，基础设施错误抛给原生管线，表现为失败结果，不伪装成成功的空列表。

`output.render` 只把摘要和展示说明交给模型；`output.presentationMeta` 将版本化报告保存在 `tool/result.data.meta.waterHazard`，不重复保存 `data`。Web 从原生工具事件投影本轮结果，通过 `conversation.chat.turnTail` 展示完整表格和图表，不依赖旧前端协议，也不修改 Harness 的会话格式。刷新或重新打开会话只恢复已保存结果，不重新取数。当前启动配置明确使用 native 工具模式。

技能 `water-hazard-overview` 负责总体监测及单项查询的工具选择、章节、空结果和失败说明；`water-hazard-trend` 负责日期参数、四项指标摘要与趋势口径。业务统计、表格和 ECharts option 均由工具生成，不让模型重新计算。

新增场景时，在本目录增加业务函数、原生工具定义及对应 `skills/<name>/SKILL.md`；若复用 `tables/charts` 输出，现有 Web 插件可直接展示。不要移植旧框架的图编排、ReAct 文本解析器或图表任务数据库。

## 业务配置与口径

插件显式配置优先，其次为环境变量，最后为下表默认值。环境变量由启动脚本从 `.env` 加载，修改后重启。

| 环境变量 | 默认值 / 含义 |
| --- | --- |
| `WATER_HAZARD_API_BASE_URL` | `http://123.184.7.170:9002/hydrologyScreen` |
| `WATER_HAZARD_MONITOR_SCREEN_ID` | `222a2e161a2d11edb4de005056c00001` |
| `WATER_HAZARD_WARNING_SCREEN_ID` | `175b77671a2d11edb4de005056c00001` |
| `WATER_HAZARD_CONVERSATION_DATE` | `2026-09-01`，业务参考日期 |
| `WATER_HAZARD_API_TIMEOUT_SECONDS` | `20`，单次请求超时 |
| `WATER_HAZARD_API_MAX_RETRIES` | `2`，首次请求以外的重试次数 |
| `WATER_HAZARD_API_RETRY_BACKOFF_SECONDS` | `0.5`，线性重试间隔基数 |
| `WATER_HAZARD_API_TOKEN` | 空；有值时发送 Bearer 头 |

测点 ID 可通过插件 `sensors.inflow / drainage / borehole / sump` 配置，默认沿用原系统的矿井总涌水量、八盘区排水量、第四系钻孔ZK4水位及中央水仓1号液位。

- 默认日期范围为 `2026-08-03` 至 `2026-09-01`，含首尾全天，不随系统日期变化。趋势支持显式范围，两个日期必须同时提供，最多31个自然日。其他四个工具保持默认30天口径。
- 设备区域和 KJ420 类型分类通过 `valueId` 关联，按原规则去重后统计传感器。`alarmState=正常` 计在线，其余沿用原实现计离线。
- 发布事件取消标签过滤，完整取数并按 `warnEventId` 去重，包含已处置、未处置与误报。`sourceType=1/3` 分别作为单因素和模型事件，误报标记不翻转。
- 阈值固定按蓝黄橙红排列，保留零值和源字符串精度；配置补充失败时保留事件，以“未取得”展示缺失内容。阈值与准则来自当前配置，不是历史快照。
- 预警统计直接取统计页接口，校验总数、明细与等级一致性，分类顺序沿用原页面，按自然日补零。空统计不生成占比。
- 趋势保留原始精度、重复时间点和空值断点，不按日平均或插值。均值和极值取原始有限数值，报告及统计表最多显示两位小数，图表保留原值。
- 历史单位缺失时只尝试对应实时传感器补齐，仍缺失则显示“单位未提供”，不猜测单位。部分指标无有效曲线时保留其他指标及该测点预警次数；全部无效、历史失败或预警查询失败则明确报错。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:api
pnpm exec playwright install --with-deps chromium
pnpm test:web
# 已配置可用模型时：
pnpm test:live
```

`test` 使用固定业务响应，覆盖 HTTP、取消、分页、日期、事件、阈值、统计、趋势和真实 Harness 调用管线；两个完整场景用明确编写的固定模型响应验证，不需要模型密钥。

`test:web` 启动独立的官方 dsh Web profile，验证实际客户端加载、完整表格、四类统计图、四张趋势图、交互、尺寸变化及刷新回放，确认回放不重新请求业务数据。`test:live` 使用真实模型和真实业务接口，断言模型加载两个技能、执行工具并展示报告；未配置模型时明确标记跳过。浏览器验证和截图保存于忽略提交的 `test-results/`。

`smoke:api` 仅查询真实业务接口，不调用模型。当前迁移核对参考日期下得到设备120个测点、单因素294条、模型8条、统计页302条，以及四项有效趋势；这些是验收观测，不写入业务逻辑。

本批不包含顶板预警、突水仿真、知识库检索、周期报告和旧前端兼容接口。`deepseek-harness` 保持源码和配置不变。
