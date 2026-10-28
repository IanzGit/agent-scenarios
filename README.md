# 煤矿场景工具与技能插件

`dsh-agent-scenarios` 是一个标准的 DeepSeek Harness 插件包。每个业务领域使用独立的源码目录、技能目录和 preset；目前提供水害领域的五个查询工具、两个技能，以及五种通用图表工具。业务代码全部为 TypeScript，直接查询现有水文接口；通用图表由独立的标准 Host＋Client 插件 `dsh-agent-charts` 提供，不依赖原 Python 服务。

## 目录与职责

```text
agent-scenarios/
├── package.json                     # 业务包入口、领域子入口及 bundle
├── cordis.patch.yml                 # 公共图表服务与领域 preset 组合
├── pnpm-workspace.yaml              # packages/* 工作区
├── config/                         # 可选模型网关配置
├── src/
│   ├── index.ts                     # 保留水害插件根入口
│   ├── shared/
│   │   ├── result.ts               # 通用业务结果与完整 Markdown 表格
│   │   └── chart-result.ts         # 图表输出协议、结果渲染与来源挂接
│   └── scenarios/water-hazard/
│       ├── index.ts                 # 业务插件注册
│       ├── api.ts / config.ts       # 接口与部署配置
│       ├── tools.ts                 # 五个业务查询工具定义与调用编排
│       └── services/                # 设备、报警、统计和趋势取数、计算与数据集适配
├── skills/<领域>/                   # 工具选择、图表要求和报告规则
├── packages/charts/                 # dsh-agent-charts 标准插件
│   ├── package.json                 # . / tools / types / client 公开入口
│   ├── src/
│   │   ├── index.ts                 # Host 入口，注册 ctx.chartSources
│   │   ├── service.ts               # 来源授权、轮次隔离及资源释放
│   │   ├── types.ts / schemas.ts    # 场景无关的图表协议
│   │   ├── tools/
│   │   │   ├── index.ts             # preset 内的工具插件入口
│   │   │   ├── common.ts            # 公共参数、输出及数据处理
│   │   │   └── line.ts / bar.ts / pie.ts / stacked-bar.ts / scatter.ts
│   │   └── client/
│   │       ├── index.ts             # 客户端注册
│   │       ├── Charts.tsx           # 交互图表及 ECharts 实例
│   │       ├── ChartToolView.tsx    # 五类工具共用的状态与摘要卡片
│   │       ├── ChartResponseBody.tsx # 正文图表引用及历史回放
│   │       ├── chart-data.ts / chart-references.ts # 本轮元数据投影与引用解析
│   │       ├── chart-meta.ts        # 持久化图表元数据解析
│   │       └── styles.css           # 展示样式
│   ├── tests/                       # 图表及服务生命周期测试
│   └── esbuild.config.mjs           # 浏览器 factory 构建
└── tests/                           # 业务、插件集成和浏览器测试
```

`src/scenarios/<领域>/index.ts` 是该领域的插件入口，只做配置解析和注册。`tools.ts` 负责工具定义、输出配置及业务调用编排；图表输出协议、结果渲染与来源挂接统一由 `shared/chart-result.ts` 提供。`services/` 负责取数、确定性计算及对应业务的数据集适配；适配函数与业务函数放在同一文件，业务函数不依赖工具执行上下文。`skills/` 负责工具选择、调用顺序、报告章节及异常说明。

业务包单向依赖图表插件的公开入口；图表插件不导入任何业务场景。业务工具、图表工具、技能和参考日期提示均注册在 `water-hazard` preset 内；图表服务通过裸包名全局加载，只有场景显式提交的成功查询才成为可绘图来源。公共目录只保留业务结果、表格与图表输出适配，没有额外路由、动态发现或场景注册框架。

## 构建与安装

需要 Node.js `^22.19.0 || >=24` 和 pnpm。当前开发依赖链接旁边已经编译的 `deepseek-harness`，运行时 peers 固定匹配该 Harness 版本。

```bash
cd agent-scenarios
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 先构建图表插件的 Host、声明文件与 Client，再编译业务包。两个包各自拥有依赖及 `lib/` 产物；`pnpm typecheck` 先准备图表包的公开声明，再分别检查 Host、Client、业务和浏览器测试。图表插件使用 esbuild 生成标准的 Harness lazy-CJS factory，不依赖 Harness 内部构建脚本。通过 workspace 依赖开发，通过 `bundledDependencies` 随业务包发布；`pnpm pack` 包含完整图表插件。

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

图表插件的三个入口职责固定：

| 入口 | 职责 |
| --- | --- |
| `dsh-agent-charts` | 全局 Host 服务，导出 `ChartSources`、数据集类型和来源目录 schema；不注册模型工具 |
| `dsh-agent-charts/tools` | 在调用者 preset 内注册五类图表工具 |
| `dsh-agent-charts/client` | 标准浏览器入口，声明依赖 `dsh-client-ui-tool`，由 `dsh.client` 自动加载，与 Host 共用纯数据协议 |

图表服务拥有全部来源缓存和会话监听；业务插件仅声明 `inject: ['tools', 'skills', 'systemPrompt', 'chartSources']`，使用 `ctx.chartSources.prepare(exec, datasets)` 返回目录。业务工具不管理图表服务的生命周期，通用表格模块也不依赖图表协议。

业务口径保持原实现：默认含参考日在内30个自然日；趋势显式日期成对提供，含首尾且最多31天。报警按事件ID去重，保留全部处置及误报状态；阈值按蓝黄橙红顺序，补充配置失败保留事件。统计页总数与等级明细严格核对，缺事件日期补零。趋势保留原始精度、重复时间点和空值，统计使用有限值，缺单位显示“单位未提供”。主接口失败明确报错，不用空结果替代。

示例问题：“当前矿井总体水害监测预警情况汇总分析”“近30天关键水文指标的变化趋势”“分析2026-08-01至2026-08-30的水文趋势”。

## 新增领域

1. 在 `src/scenarios/<领域>/` 增加插件入口、配置、工具与业务模块。
2. 在 `skills/<领域>/` 增加标准 `SKILL.md`，由该领域插件注册该目录。
3. 在 `package.json` 增加领域子入口，在 `cordis.patch.yml` 增加 preset，将业务插件、persona 和技能加载工具放入该 preset。
4. 需要图表时在该 preset 加载 `dsh-agent-charts/tools`；在对应的业务服务文件中将查询结果适配为 `ChartDataset[]`，在工具定义中复用 `shared/chart-result.ts` 的输出协议与渲染函数，并通过 `withChartSource` 发布来源目录。在 skill 中指定数据集和图表工具的对应关系。
5. 新增该领域的业务及隔离测试。无需修改公共图表插件、Client 或其他场景；通用表格继续复用 `shared/result.ts`。

## 验证与迁移说明

`pnpm test` 先运行图表插件自身测试，再验证业务口径、完整表格、数据集适配、完整 Harness 调用链，以及两个场景共享服务时的来源隔离和独立卸载。模型网关测试通过真实适配器检查关闭思考的请求参数及报告正文，不需要密钥或浏览器。

```bash
# 可选：读取 .env 后查询真实水文系统，不调用模型
pnpm test:live
# 检查标准插件的打包内容
pnpm pack
# 首次安装浏览器后验证真实 Web 交互和刷新回放（独立临时 profile，无需密钥）
pnpm exec playwright install chromium
pnpm test:browser
```

保留业务工具名、参数、技能名、环境变量和默认参考日期。本次结构重构保持图表工具名称、参数、来源目录及 `agentScenariosChart` 版本1协议，原有新图表会话仍可回放。旧 `meta.waterHazard` 图表不转换，缺少新元数据的历史记录继续显示原有文本和表格。仅生成图表所需的数据进入持久展示载荷，业务原始 `series` 不另存一份。

已移除 `pnpm start:web / test:web / smoke:api`；安装启动改用官方 CLI，真实接口检查统一为 `test:live`。旧版针对全局 `coal-mine-scenarios` 的配置应移到水害 preset 内的 `water-hazard-tools` 条目。已有 `.env`、`.dsh` 和 `temp/new.md` 保留，Harness 源码不变。
