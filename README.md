# 煤矿场景工具与技能插件

`dsh-agent-scenarios` 是一个标准的 DeepSeek Harness Host 插件包。每个业务领域使用独立的源码目录、技能目录和 preset；目前提供水害领域的五个工具和两个技能。业务代码全部为 TypeScript，直接查询现有水文接口，不依赖原 Python 服务。

## 目录与职责

```text
agent-scenarios/
├── package.json                     # bundle、子入口、运行时 peers 和发布文件
├── cordis.patch.yml                 # 领域 preset 及其工具、persona、技能加载器
├── tsconfig*.json                   # 类型检查与 ESM 编译
├── pnpm-workspace.yaml              # 单包的依赖构建权限，仅允许 esbuild
├── config/
│   └── openai-compatible.patch.yml  # 可选模型网关配置
├── src/
│   ├── index.ts                     # 包根入口，转出水害插件
│   ├── shared/
│   │   └── result.ts                # 共用表格、输出 schema、Markdown 渲染
│   └── scenarios/
│       └── water-hazard/
│           ├── index.ts             # name / inject / Config / apply
│           ├── config.ts            # 部署配置、参考日期和测点映射
│           ├── api.ts               # 表单 POST、分页、校验、重试和取消
│           ├── tools.ts             # 五个 defineTool 定义
│           └── services/
│               ├── devices.ts       # 设备分类与在线离线统计
│               ├── warnings.ts      # 单因素、模型预警及统计页数据
│               └── trends.ts        # 原始历史、周期统计和测点预警次数
├── skills/
│   └── water-hazard/
│       ├── water-hazard-overview/SKILL.md
│       └── water-hazard-trend/SKILL.md
└── tests/
    ├── water-hazard/                # HTTP 和业务口径回归
    ├── shared/                      # 完整 Markdown 表格输出
    ├── integration/                 # preset 隔离、工具调用及可选真实接口
    └── fixtures/                    # 固定接口和模型响应
```

`src/scenarios/<领域>/index.ts` 是该领域的插件入口，只做配置解析和注册。`tools.ts` 负责 Harness 参数及结果校验，`services/` 负责取数和确定性计算。`skills/` 负责工具选择、调用顺序、报告章节及异常说明。

业务工具、技能提供器和参考日期提示均注册在 `water-hazard` preset 内，其他 preset 不会看到这些能力。公共目录只保留当前确实共用的结果定义和 Markdown 渲染，没有额外路由、动态发现或场景注册框架。

## 构建与安装

需要 Node.js `^22.19.0 || >=24` 和 pnpm。当前开发依赖链接旁边已经编译的 `deepseek-harness`，运行时 peers 固定匹配该 Harness 版本。

```bash
cd agent-scenarios
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 清除旧产物后通过 TypeScript 直接编译到 `lib/`，不依赖 Harness 内部构建脚本。发布内容只包含编译结果、技能、配置和 bundle patch。

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

该网关配置使用 Qwen 兼容参数，默认关闭额外思考，单次输出上限8192 tokens；上下文容量通过 `WATER_HAZARD_MODEL_CONTEXT_WINDOW` 指定。完整明细会占用模型上下文和输出额度，实际部署应配置足够容量；工具渲染器不截断表格。

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
| `get_warning_statistics` | `{}` | 类型、等级、每日事件数量统计表 |
| `get_hydrological_trend` | `{start_time?, end_time?}` | 四项指标统计、预警次数及原始时间序列 |

统一结果为 `title / summary / period? / tables`，趋势额外返回 `series`。每个表格包含 `title / columns / rows`；原始序列包含 `name / unit / source / sensor / points`。`output.render` 输出摘要和全部 Markdown 表格，数值最多显示两位小数，字符串阈值保留原始精度。`series` 供程序化调用使用，不展开到模型文本，也不作为额外元数据持久化。

技能指导智能体按章节引用工具结果和完整表格。工具结果文本由 Harness 的默认工具视图和会话记录保存，没有自定义客户端、图表、结果卡片或展示协议。

业务口径保持原实现：默认含参考日在内30个自然日；趋势显式日期成对提供，含首尾且最多31天。报警按事件ID去重，保留全部处置及误报状态；阈值按蓝黄橙红顺序，补充配置失败保留事件。统计页总数与等级明细严格核对，缺事件日期补零。趋势保留原始精度、重复时间点和空值，统计使用有限值，缺单位显示“单位未提供”。主接口失败明确报错，不用空结果替代。

示例问题：“当前矿井总体水害监测预警情况汇总分析”“近30天关键水文指标的变化趋势”“分析2026-08-01至2026-08-30的水文趋势”。

## 新增领域

1. 在 `src/scenarios/<领域>/` 增加插件入口、配置、工具与业务模块。
2. 在 `skills/<领域>/` 增加标准 `SKILL.md`，由该领域插件注册该目录。
3. 在 `package.json` 增加对应领域子入口，在 `cordis.patch.yml` 增加其 preset，将业务插件、persona 和技能加载工具放入该 preset。
4. 新增该领域的业务及隔离测试；通用表格继续复用 `shared/result.ts`，不改已有领域。

## 验证与迁移说明

`pnpm test` 使用固定响应验证业务口径、完整表格、两个场景的 Harness 循环，以及工具、技能、日期提示的 preset 隔离和卸载，不需要密钥或浏览器。

```bash
# 可选：读取 .env 后查询真实水文系统，不调用模型
pnpm test:live
# 检查标准插件的打包内容
pnpm pack
```

本次重构保留工具名、参数、技能名、环境变量和默认参考日期；结构化结果改为上述字段，移除旧 `version / data / charts` 副本及 `meta.waterHazard`。新报告直接使用 Markdown，旧会话中的自定义图表不再渲染，历史数据不转换。

已移除 `pnpm start:web / test:web / smoke:api`；安装启动改用官方 CLI，真实接口检查统一为 `test:live`。旧版针对全局 `coal-mine-scenarios` 的配置应移到水害 preset 内的 `water-hazard-tools` 条目。已有 `.env`、`.dsh` 和 `temp/new.md` 保留，Harness 源码不变。
