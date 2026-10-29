# 煤矿场景工具与技能插件

`dsh-agent-scenarios` 是一个 DeepSeek Harness Bundle 和轻量 pnpm Monorepo。每个业务领域使用独立的包、技能目录和 preset；提供水害领域的五个查询工具、两个技能，以及水文监测查数领域的 TS 查询子智能体和六个技能。业务代码全部为 TypeScript；通用图表由独立的标准 Host＋Client 插件 `dsh-agent-charts` 提供，不依赖原 Python 服务。

## 目录与职责

```text
agent-scenarios/
├── packages/
│   ├── water-hazard/                # 水害插件：源码、两个技能、领域测试
│   ├── hydrology-monitoring/        # 水文插件：查询子智能体、六个技能、报告 Client、测试
│   ├── charts/                      # 通用 Host + Client 图表插件
│   └── shared/                      # 公共结果契约与纯表格渲染
├── presets/                         # 水害、水文主智能体、水文查询 preset
├── config/                          # 可选模型网关配置
├── tests/
│   ├── integration/                 # 跨插件调用链、Bundle 与模型网关验证
│   ├── browser/                     # Web 交互和刷新回放
│   └── fixtures/                    # 共用业务接口与录制模型
├── docs/architecture.md             # 分层、公开入口与旧配置迁移
├── cordis.patch.yml                 # 全局图表、水文服务及默认设置
├── package.json                     # Bundle 补丁列表与工作区开发命令
└── pnpm-workspace.yaml
```

根包 `dsh-agent-scenarios` 只负责 Bundle 装配，不再导出 Host、业务子入口或 Client。`dsh.bundle.patch` 按顺序加载根补丁和三个 preset 文件；业务工具和技能仅在对应 preset 内注册。详细分层与入口迁移见 [架构说明](docs/architecture.md)。

水害保留设备、预警、趋势三个 `services` 文件，工具定义、API 和图表输出适配分别放入 `tools`、`infrastructure`、`presentation`。水文按工具、查询子智能体、应用编排、领域协议、基础设施和展示适配组织，业务 Client 随水文包构建。每个业务包的 `skills` 负责工具选择、调用顺序、口径和报告规则。

两个业务包通过公开入口依赖 `dsh-agent-shared` 和 `dsh-agent-charts`，互不依赖。shared 仅保留实际复用的结果契约与纯函数；依赖工具执行上下文的水害图表适配留在水害包内。图表插件不导入业务代码。

## 构建与安装

需要 Node.js `^22.19.0 || >=24` 和 pnpm。当前开发依赖链接旁边已经编译的 `deepseek-harness`，运行时 peers 固定匹配该 Harness 版本。

```bash
cd agent-scenarios
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 按 workspace 依赖顺序构建 shared、charts 和两个业务包，各包拥有自己的依赖和 `lib/` 产物。`pnpm typecheck` 先准备公开 Host 声明，再检查各包、集成测试和浏览器测试；`pnpm test` 先准备 Host 产物，再运行各包测试和根部集成测试。水文和图表 Client 各自使用 esbuild 生成标准 Harness lazy-CJS factory，不依赖 Harness 内部构建脚本。根 Bundle 通过 `bundledDependencies` 携带四个 workspace 包，`pnpm pack` 同时包含业务技能和全部补丁。单包命令示例：`pnpm --filter dsh-agent-water-hazard test`；首次运行单包测试前先完成根部 `pnpm typecheck`，以准备依赖包产物。

有已安装的 `dsh` 时，使用官方命令安装到 Web profile：

```bash
DSH_HOME="$PWD/.dsh" dsh plugin --profile web add .
DSH_HOME="$PWD/.dsh" dsh web --no-open
```

当前使用相邻源码仓库时，首次使用其已编译的官方 CLI，将插件安装到本目录的 Web profile：

```bash
DSH_HOME="$PWD/.dsh" node --env-file-if-exists=.env ../deepseek-harness/apps/cli/lib/bin.js plugin --profile web add .
```

之后在 `agent-scenarios` 目录执行默认启动命令：

```bash
pnpm start
```

该命令固定使用本目录 `.dsh`，读取 `.env` 并加载 `config/openai-compatible.patch.yml`，直接调用官方 CLI，无需额外设置 `DSH_HOME`。安装与启动使用同一个 Web profile，避免误加载用户主目录下的默认模式。

打开终端输出的带 token 地址，新会话默认选择 `water-hazard`。没有桌面 Documents 目录的 Linux 可使用目录选择器；也可给官方 `--patch` 传入自有配置，将 `workspace-controller.config.documentsDirectory` 设为有效绝对目录。

### 模型与业务配置

参考 `.env.example` 配置环境变量。通过官方 CLI 启动时，显式使用 `--env-file-if-exists=.env` 或在启动前导出变量；`pnpm start` 已包含该参数，插件不会自行读取 `.env`。

默认 `pnpm start` 沿用原系统的 OpenAI-compatible 网关，需要配置 `WATER_HAZARD_MODEL_BASE_URL / WATER_HAZARD_MODEL_ID / WATER_HAZARD_MODEL_API_KEY`。如果通过 Harness 设置页或 `DEEPSEEK_API_KEY` 配置模型，可以省略模型补丁，使用：

```bash
DSH_HOME="$PWD/.dsh" node --env-file-if-exists=.env ../deepseek-harness/apps/cli/lib/bin.js web --no-open
```

该网关配置声明 Qwen 模型的推理能力，默认选择 `off`，通过 `chat-template` 协议实际发送 `chat_template_kwargs.enable_thinking=false`，让报告进入正文。单次输出上限默认32768 tokens，可通过 `WATER_HAZARD_MODEL_MAX_TOKENS` 调整；上下文容量通过 `WATER_HAZARD_MODEL_CONTEXT_WINDOW` 指定。完整报警明细可能超过8192 tokens，实际部署应为输入与报告配置足够容量；工具渲染器不截断表格。修改该补丁后重启 `pnpm start`，在新一轮查询中验证；历史会话中的思考块不会自动转换为正文。

| 业务环境变量 | 默认值 |
| --- | --- |
| `WATER_HAZARD_API_BASE_URL` | `http://123.184.7.170:9002/hydrologyScreen` |
| `WATER_HAZARD_MONITOR_SCREEN_ID` | `222a2e161a2d11edb4de005056c00001` |
| `WATER_HAZARD_WARNING_SCREEN_ID` | `175b77671a2d11edb4de005056c00001` |
| `WATER_HAZARD_CONVERSATION_DATE` | `2026-09-01` |
| `WATER_HAZARD_API_TIMEOUT_SECONDS` | `20` |
| `WATER_HAZARD_API_MAX_RETRIES` | `2`，首次请求之外的重试次数 |
| `WATER_HAZARD_API_RETRY_BACKOFF_SECONDS` | `0.5`，线性重试间隔基数 |
| `WATER_HAZARD_API_TOKEN` | 空；有值时发送 Bearer 头 |

领域插件的显式 `config` 优先于环境变量。测点通过 `sensors.inflow / drainage / borehole / sump` 配置，默认沿用原系统的矿井涌水量、排水量、ZK4水位和中央水仓液位。

## 工具与结果

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `get_device_status` | `{}` | 区域、类型、在线离线统计表 |
| `get_device_alarm` | `{}` | 单因素报警摘要、完整明细及四级阈值 |
| `get_model_warning` | `{}` | 模型预警摘要、完整明细及判识信息 |
| `get_warning_statistics` | `{}` | 事件总数摘要；类型、等级、每日数量统计仅作图表数据源 |
| `get_hydrological_trend` | `{start_time?, end_time?}` | 四项指标统计、预警次数及原始时间序列 |

统一业务结果为 `title / summary / period? / tables`，趋势额外返回 `series`。每个表格包含 `title / columns / rows`；原始序列包含 `name / unit / source / sensor / points`。`output.render` 输出摘要和展示用 Markdown 表格，数值最多显示两位小数，字符串阈值保留原始精度；标记 `chartOnly` 的表格仅作图表数据源，不进入模型文本。`series` 供程序化调用使用，不展开到模型文本。

活动会话中，设备、预警统计和趋势查询额外返回 `chart_source` 目录：`source_id` 和每个数据集的 `id / title / columns / row_count`。只有最终成功的工具结果才发布来源；数据缓存按会话和轮次隔离，轮次结束后释放。无活动会话的程序化业务调用继续返回原有结果。

### 图表工具与展示

| 工具 | 用途 | 额外约束 |
| --- | --- | --- |
| `render_line_chart` | 时间趋势 | 横轴为时间，保留重复点和空值断点，支持时间轴缩放 |
| `render_bar_chart` | 分类对比 | 使用业务已汇总的数据，可选系列字段 |
| `render_pie_chart` | 类别占比 | 数值非负、总值大于零，允许单类别 |
| `render_stacked_bar_chart` | 分类构成 | 必须提供系列字段，各系列使用数据集声明的同一单位 |
| `render_scatter_chart` | 逐行数值分布 | 数值横轴、分类纵轴，保留同分类的多条记录 |

公共参数为 `source_id / dataset_id / title / x_field / value_field`，折线及柱状工具另支持 `series_field`（堆叠必填）。单位由数据集数值字段提供。工具不接收模型编写的数据数组或 ECharts option，不重新取数、聚合或采样；重复类别需由业务层先行汇总。空数据或占比总量为零返回 `no_data`，非法字段和不可用来源明确失败。

设备类型按区域汇总后绘制一张饼图；预警类型、等级各一张饼图，每日数量一张柱状图。趋势的涌水量、排水量、ZK4水位、中央水仓水位各一张独立折线图。两个 skill 规定这些调用关系；用户只问单项时只生成相关图。

图表工具向模型输出图表 ID、标题、状态和摘要；完整配置存于 `output.presentationMeta` 的 `agentScenariosChart` 版本1载荷，随 Harness 会话保存。模型在最终回答的对应分析段落后，独立一行输出 `[图表:真实chart_id]`。Client 在 `conversation.chat.response.body` 中从本轮持久化元数据查找配置，复用 `InteractiveChart` 内嵌渲染，保留悬浮、图例、缩放、主题、尺寸适配和刷新回放。代码块和行内示例中的引用不作为图表；找不到本轮ID时显示不可用说明，不重新查询。工具调用卡片仅展示阶段和摘要，报告末尾不再通过 `turnTail` 汇总。

该正文插槽由同工作区 Harness 的 `ui-chat` 前端提供；未安装图表插件时继续使用原生 Markdown。旧会话的最终回答没有引用标记时，在最终正文末尾恢复本轮已保存的图表；有引用的回答按标记位置展示。查询、来源注册及后端生成协议保持不变。

图表插件的公开入口职责：

| 入口 | 职责 |
| --- | --- |
| `dsh-agent-charts` | 全局 Host 服务，导出 `ChartSources`、数据集类型、来源目录 schema 和纯函数 `renderChart`；不注册模型工具 |
| `dsh-agent-charts/tools` | 在调用者 preset 内注册五类图表工具 |
| `dsh-agent-charts/client` | 标准浏览器入口，声明依赖 `dsh-client-ui-tool`，由 `dsh.client` 自动加载；提供工具卡片、普通回复图表及独立报告正文 Factory |

图表服务拥有全部来源缓存和会话监听；业务插件仅声明 `inject: ['tools', 'skills', 'systemPrompt', 'chartSources']`，使用 `ctx.chartSources.prepare(exec, datasets)` 返回目录。业务工具不管理图表服务的生命周期，通用表格模块也不依赖图表协议。

业务口径保持原实现：默认含参考日在内30个自然日；趋势显式日期成对提供，含首尾且最多31天。报警按事件ID去重，保留全部处置及误报状态；阈值按蓝黄橙红顺序，补充配置失败保留事件。统计页总数与等级明细严格核对，缺事件日期补零。趋势保留原始精度、重复时间点和空值，统计使用有限值，缺单位显示“单位未提供”。主接口失败明确报错，不用空结果替代。

示例问题：“当前矿井总体水害监测预警情况汇总分析”“近30天关键水文指标的变化趋势”“分析2026-08-01至2026-08-30的水文趋势”。

## 新增领域

### 水文监测查数

新会话继续默认使用 `water-hazard`。在 preset 菜单选择“水文监测查数”（`hydrology-monitoring`），可查询监测点、实时状态、历史趋势和预警报警。“水文查询子智能体”（`hydrology-query`）用于单任务委派。场景入口为 `dsh-agent-hydrology-monitoring/tools`，子智能体插件入口为 `dsh-agent-hydrology-monitoring/query-child`，源码位于 `packages/hydrology-monitoring/src/`，技能位于 `packages/hydrology-monitoring/skills/`。

该场景参考原 `hydrology_semantic_query` 的业务口径，保留现有 Cube 语义服务，只迁移完整目录模式；不包含向量检索、原 Python 父智能体、报告子智能体或 LangGraph。宿主使用官方 profile 提供的 `subagent`、`subagent-spawn-in-process`、Session 持久化及 Session 查询服务，不重复注册这些全局服务。全局 Host 插件 `dsh-agent-hydrology-monitoring/results` 提供唯一的 `hydrologyQueryResults` 文件服务，两个 preset 共享该服务，不各自配置不同结果目录。

全局 Host 插件 `dsh-agent-hydrology-monitoring` 注册 `ctx.hydrologyParentTasks`。主智能体理解问题并提交结构化计划；服务固定业务任务ID、报告ID、查询ID与依赖，在后台通过官方 `ctx.subagents.startActivation` 执行，固定 `provider: spawn`、`agentPreset: hydrology-query`、`maxDepth: 1`、`delivery: caller`。查询 preset 只提供目录和查询工具，默认继承主会话模型。父任务服务统一收集全部查询、生成声明的图表，然后集中唤醒主智能体成文。水文主 preset 不再提供逐项委派或直接绘图工具。

| 工具 | 参数与行为 |
| --- | --- |
| `query_hydrology` | `{plan}`，提交完整计划并立即返回 `task_id / report_id / phase`；工具最终接受后才启动后台执行 |
| `get_hydrology_query_result` | `{task_id}`，读取本父会话任务的真实查询结果、状态、图表ID和报告结构，不再次查询 Cube |
| `publish_hydrology_report` | `{task_id, markdown}`，校验标题、完整章节和全部成功图表引用，通过后发布独立报告 |
| `cancel_hydrology_task` | `{task_id}`，仅在用户要求时取消未发布任务并释放在途查询；不删除已保存结果 |
| `search_semantic_catalog` | 子智能体工具；省略 `model_names` 读取公开模型摘要，指定名称读取完整成员和语义约束 |
| `run_semantic_query` | 子智能体工具；`query_goal / semantic_query`，执行本地校验、Cube `/sql` 编译预检及 `/load` 查询 |

计划示例（主智能体根据实际问题和技能确定查询条件及章节）：

```json
{
  "title": "主斜井水位关联分析",
  "queries": [
    {"id": "current", "prompt": "查询主斜井水位的当前值、单位和采集时间"},
    {"id": "history", "prompt": "查询主斜井水位2025-09-01至2025-09-07的历史原始采样，保留单位和时间"}
  ],
  "charts": [
    {"id": "history-line", "query_id": "history", "dataset": "history", "type": "line", "title": "历史水位", "x_field": "time", "value_field": "value", "series_field": "point"}
  ],
  "report": {"title": "主斜井水位关联分析", "sections": ["当前水位", "历史变化", "关联分析与异常点", "结论"]}
}
```

每个查询的 `depends_on` 声明上游查询ID；可选 `inputs: [{query_id, columns}]` 从已校验的上游完整行集中绑定真实字段。依赖必须无环，查询和图表意图ID不能重复。依赖失败、无数据或缺少指定字段时跳过下游，独立查询继续执行。每个父会话最多一个未结束任务；同一用户请求重复提交同一计划复用原任务，不重复派发，改变计划需结束旧任务并发起新请求。

状态按 `querying → charting → composing → published` 推进；取消为 `cancelled`，结果损坏或无法确认执行归属等需要处理的情况为 `blocked`。服务保证查询全部结束后绘图、图表全部收敛后成文、结构校验通过后发布。只有网络错误、超时、HTTP 5xx 和恢复时确认的中断允许自动重试，默认最多两次尝试；认证、业务参数、结果文件损坏等错误不会因此重新查询。

`hydrology-parent-tasks` Host 条目可配置 `maxConcurrentQueries`（默认3）、`maxQueryAttempts`（默认2，含首次）、`retryDelayMs`（默认1000）。每次派发前持久化尝试及预留子会话ID；恢复时先核对真实子会话回执与完整结果，已提交结果直接复用，尚未创建的预留身份沿用原ID，确认中断才在剩余预算内新建尝试。仅在父 Agent 被恢复时续作，Host 启动不扫描或激活历史任务。

任务状态使用官方 `appendPluginRecord` 写入版本1外部插件记录 `plugin:dsh-agent-scenarios/parent-task`，带 `ignorable: true`；Session 投影重放恢复状态，就绪消息先持久化再投递。它不是 Harness 内建正式事件，框架未来格式迁移对外部记录仅尽力保留，升级前应备份会话及结果目录。

查询输入字段为 `query_mode / models / measures / dimensions / segments / filters / time_dimensions / order / limit / offset / ungrouped`。只执行明细查询，固定 `measures=[]`、`ungrouped=true`；View 返回完整 `default_projection`，Cube 限定同一连接组件内1至4个模型。过滤叶子严格使用 `member / operator / values`，`set/notSet` 不带 `values`，逻辑组只接受两层非空 `and/or`；不接受字段简写。`time_dimensions` 保留 `dimension / date_range`，不接受聚合粒度 `granularity`。原生校验失败提供具体过滤字段路径和示例；子智能体提示词要求只修错误字段，保留日期、对象、地点、排除条件及 AND/OR 关系。本次未增加结构化任务语义守卫，语法合法的错误业务范围仍需核对。语义目录提供模型、成员、规范过滤标识和业务约束；不接受原始 SQL。未要求 TopN、最新或分页时不设置行数上限，客户端不另行截断 Cube 返回的行集。

一个子智能体只执行一个独立小任务，先加载模型详情，再形成一次成功或无数据的最终查询。参数、目录或 Cube 400 错误可以修正；认证、网络、超时、非法响应和 Continue wait 耗尽终止查询。完整版本1 `QueryRecord` 原子写入独立文件，包含实际查询、列、完整行集和错误；工具输出改为版本2回执，只有状态、行数、错误和 `result_ref: { id, bytes, sha256 }`。官方 `output.presentationMeta` 将回执存于 `meta.hydrologyQuery`，目录详情加载状态存于 `meta.hydrologyCatalog`，冷恢复和父会话读取均不解析模型展示文本，兼容 Harness spill 的首尾预览与省略提示。结果读取文本明确展示实际模型、过滤和时间条件，供成文前核对业务范围。

结果文件位于 `<resultsDirectory>/<子会话ID的SHA-256>/<随机结果ID>.json`，封装格式版本、父子会话归属和完整记录。目录/文件以私有权限创建，先写临时文件并同步，再原子提交。引用不是任意路径；读取校验父子归属、preset、完成状态、引用、文件长度、SHA-256、记录版本与行数。文件不可用或损坏明确失败，不当作无数据；保存失败产生终止错误回执，不把尚未保存的数据标记为可读取。工具最终被拒绝或取消时清理本次未提交文件，卸载等待在途操作；已提交文件默认长期保留，不随会话关闭或插件卸载删除，需由管理员按保存需求手动清理。

历史会话保持原样，不恢复或迁移旧 spill 文件。没有版本2结构化回执的历史查询会明确提示重新委派；重新查询后使用新结果文件，避免复用上次条件已错误的温度结果。

业务范围采用 Schema 和提示词约束，自由成文没有程序化事实校验；仍需核对测点去重数量及“无事件不等于运行正常”等结论，查询或绘图成功不代表报告全文正确。

主智能体收到 `hydrology-task-ready` 集中通知后，读取任务结果，按计划标题及二级章节生成整篇 Markdown，通过发布工具一次提交。每个成功图表在相应段落后独立一行引用 `[图表:真实chart_id]`，每个ID恰好一次；失败或无数据图表明确说明，不引用。普通回复及子智能体 closing message 不作为发布或重试依据。服务复用 `dsh-agent-charts` 的纯绘图实现，图表意图可指定实际数据集ID，或 `history / realtime` 族按真实类型及单位分别绘图。

发布记录固定报告ID、完整正文和图表快照，Client 通过标准 Conversation Definition 渲染为独立报告节点，使用图表插件的 `agent-scenarios.report.body` Factory。报告不依赖 Turn 最后一条助手回复或当前轮图表缓存；后续完成通知、执行区折叠及刷新回放不会改变已发布报告的身份和正文。相同正文重复发布幂等，不同正文不能覆盖，修订需新的用户请求。工具执行状态留在执行区，不进入报告节点。

`cordis.patch.yml` 的 `hydrology-parent-tasks` 条目通过裸包 `dsh-agent-hydrology-monitoring` 注册父任务服务，并使 Harness 发现该包的标准 Client。主智能体工具使用 `/tools` 子入口，仅在水文主 preset 中注册。原根包 Client 条目和 `clientOnly` 配置已移除。图表和水文的 Client 声明分别属于各自包，根 Bundle 不再承担前端职责。

适配器按稳定语义成员识别类型、测点、数值、单位、时间和状态，包含测点部署 `view_point_deployment_analysis`：`point_types / point_names / value_statuses / device_statuses` 为按测点唯一标识去重的数量分布；`realtime_* / history_*` 分别为按监测类型和单位拆分的实时及历史数据集。饼图使用 `category / count`；实时散点和柱状图使用 `point / value`；折线图使用 `time / value`，可按 `point` 分系列。历史保留重复时间、空值和原精度，统计仅使用有限数值。测点定义分布明细和可绘图的历史采样明细复用现有 `chartOnly` 标记，完整保留在结构化表格和图表来源中，模型文本展示分布/指标统计与图表目录，避免多项原始明细表耗尽上下文。事件明细继续完整展示，只依据实际起止时间计算已结束时长，结束时间为空标记“未结束”。

| 技能 | 查询拆分 | 章节和展示 |
| --- | --- | --- |
| `mine-hydrology-analysis` | 类型分布、实时水流量、异常、三个指定关键测点历史，共6项 | 总体、实时、三类趋势、预警报警、总结；饼图、散点图、独立折线图及事件表 |
| `mine-hydrology-indicator-analysis` | 指定指标的测点设备、实时、历史、事件，共4项 | 分布、实时、历史、事件、总结；饼图、散点图、分单位折线图及事件表 |
| `workface-hydrology-analysis` | 指定工作面的分布状态、实时、液位/水温/水流量历史、异常，共6项 | 分布状态、实时、历史、事件、总结；饼图、分类型分单位柱状图、折线图及事件表 |
| `hydrology-mine-realtime-overview` | 当前有效测点、实时水流量、预警报警，共3项 | 总览、实时、事件；数量状态表、散点图及事件表 |
| `hydrology-single-point-recent` | 同一点位实时、历史、事件，共3项 | 当前、历史、事件、总结；实时表、折线图及事件表 |
| `hydrology-daily-report` | 当天液位、水流量、温度历史及事件，共4项 | 日期范围、指标统计、事件、关注点；统计表及事件表，用户要求时展示日内曲线 |

六个技能要求将各查询项一次性纳入计划，保留原完整测点名称、工作面范围与排除“麦垛山煤矿总排水日累计水流量”的适用规则。默认历史窗口沿用原技能：综合/指标/单点为2025年9月前7天，工作面为2025年9月，日报为2025年9月15日 `[00:00, 次日00:00)`；事件时间仅按相应技能已声明的口径处理。用户明确日期优先。无记录、字段缺失和查询失败分别说明，失败不等同于无事件，无事件不代表运行正常。

| 环境变量（前缀 `HYDROLOGY_SEMANTIC_QUERY_`） | 默认值 |
| --- | --- |
| `CUBE_URL / CUBE_TOKEN` | `http://127.0.0.1:58025` / 空；Token 原样放入 Authorization 头 |
| `TIMEOUT_SECONDS` | `30`，覆盖请求和响应体读取 |
| `CONTINUE_WAIT_RETRIES / CONTINUE_WAIT_DELAY_SECONDS` | `6 / 0.1` |
| `META_CACHE_TTL_SECONDS` | `300` |
| `TIMEZONE` | `Asia/Shanghai` |
| `MAX_AGENT_ITERATIONS` | `6`，通过官方 `agent/pre-step` 扩展点限制 |
| `RESULTS_DIRECTORY` | 官方 Harness home 下的 `storages/hydrology-query-results`，不依赖临时 spill 目录 |

显式查询子智能体插件配置优先于环境变量，字段为对应 camelCase，例如 `cubeUrl`、`cubeToken` 和 `maxAgentIterations`。结果目录只在全局 `hydrology-query-results` Host 条目配置 `resultsDirectory`，该值优先于 `HYDROLOGY_SEMANTIC_QUERY_RESULTS_DIRECTORY`；相对目录在 Host 启动时解析为绝对路径。修改结果目录时需同步迁移已保存的目录结构，否则已有新格式回执将无法读取。修改既有安装的 preset 组合后，重新执行本文的官方 `plugin --profile web add .` 安装命令并重启 `pnpm start`，在新会话选择新增场景。现有会话继续使用其原 preset。

水文监测测试使用本地 Cube fixture 和固定模型响应，验证查询约束、失败分类、官方 caller 激活、跨会话拒绝、结果持久化、重复计划幂等、并发限制、依赖跳过、重试预算、取消、提前发布拒绝及中断恢复，覆盖193行、77行和万行结果在真实12500-token spill 策略下的完整读取、新服务实例读取、文件损坏/缺失、写入失败和取消清理；参数纠错回放核对最终 Cube 请求保留日期、AND及排除条件，并检查实际主会话模型请求包含完整成文规则。浏览器测试同时验证原水害场景和新场景的正文图表、交互与刷新回放，并在报告发布后注入晚到的子会话通知，验证执行区折叠与刷新后报告ID、标题、图表前后章节仍保持完整，正文内没有工具分组状态。运行 `pnpm test / typecheck / build / test:browser`，不需要业务接口或模型密钥。

### 添加其他领域

1. 在 `packages/<领域>/` 增加独立 manifest、源码、技能、领域测试及构建配置；按现有复杂度分层。
2. 通过公开入口依赖 `dsh-agent-shared` 的结果契约和所需的图表能力，不跨包导入生产源码。
3. 在 `presets/` 增加组合补丁，将业务插件、persona 和技能加载工具放入该 preset，并加入根 manifest 的有序补丁列表。
4. 在根 Bundle 的 dependencies 和 bundledDependencies 中加入业务包，并在 peerDependencies 汇总其宿主依赖；需要图表时按实际查询结果适配 `ChartDataset[]`，在技能中规定数据集与图表调用关系。
5. 增加领域测试，并扩展 preset 隔离和必要的跨插件集成验证。拥有 Client 的包须通过裸包 Host 条目加载。

## 验证与迁移说明

`pnpm test` 运行各包自身测试，再通过集成测试验证业务口径、完整表格、数据集适配、完整 Harness 调用链，以及两个场景共享服务时的来源隔离和独立卸载。模型网关测试通过真实适配器检查关闭思考的请求参数及报告正文，不需要密钥或浏览器。

```bash
# 可选：读取 .env 后查询真实水文系统，不调用模型
pnpm test:live
# 检查标准插件的打包内容
pnpm pack
# 首次安装浏览器后验证真实 Web 交互和刷新回放（独立临时 profile，无需密钥）
pnpm exec playwright install chromium
pnpm test:browser
```

水害工具、图表工具、技能名、环境变量和默认参考日期保持兼容。水文主会话的 `query_hydrology / get_hydrology_query_result` 已切换为父任务协议，不兼容旧逐子会话参数；已生成的普通历史回复不自动转换为独立报告。图表继续保持工具名称、参数、来源目录及 `agentScenariosChart` 版本1协议，原有新图表会话仍可回放。旧 `meta.waterHazard` 图表不转换，缺少新元数据的历史记录继续显示原有文本和表格。仅生成图表所需的数据进入持久展示载荷，业务原始 `series` 不另存一份。

已移除 `pnpm start:web / test:web / smoke:api`；安装启动改用官方 CLI，真实接口检查统一为 `test:live`。旧版针对全局 `coal-mine-scenarios` 的配置应移到水害 preset 内的 `water-hazard-tools` 条目。已有 `.env`、`.dsh` 和 `temp/new.md` 保留，Harness 源码不变。

本次目录重构移除了旧业务入口，已有安装需按 [入口迁移说明](docs/architecture.md#入口迁移) 重新安装 Bundle 并重启；preset ID、工具参数、技能内容及历史记录格式保持原样。
