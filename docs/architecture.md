# 工作区与插件结构

根包是部署 Bundle，业务包是能力边界，preset 负责组合。全部生产代码跨包引用使用包名与公开 exports，不访问其他包的源码。

## 包内职责

| 包 | 目录与职责 |
| --- | --- |
| water-hazard | `src/index.ts` 配置与注册；`tools` 原生工具；`services` 设备、预警、趋势；`infrastructure` HTTP API；`presentation` 结果与图表来源适配 |
| hydrology-monitoring | `src/index.ts` 全局父任务服务入口；`tools` 主智能体工具和技能注册；`agents/query-child` 查询子智能体及提示词；`application` 查询执行、结果协调与父任务调度；`domain` 语义目录、查询校验、版本化协议和报告校验；`infrastructure` Cube HTTP、文件结果存储与 Session 投影；`presentation` 表格与图表数据集；`client` 任务及报告节点 |
| charts | 独立通用图表服务、工具及 Client，保持现有公开入口 |
| shared | `result.ts` 结果类型、Schema、表格构造与纯 Markdown 渲染；`index.ts` 公开导出 |

各业务包的技能位于本包 `skills`，领域测试位于本包 `tests`。跨插件及浏览器测试留在根部，共用 fixture 也在根部，避免复制。水害规模较小，三个 service 保留现有取数、计算及数据集适配，不为目录一致性强拆。水文领域层不依赖 Cordis Context、HTTP 或文件存储；语义目录解析和查询约束可直接测试。

依赖关系为水害、水文分别依赖 shared 和 charts，两个业务包互不依赖。shared 不注册服务或持有会话状态；`withChartSource` 等依赖执行上下文的适配由水害包持有。charts 不依赖业务包或 shared。

## 装配与构建

根 `package.json` 的 `dsh.bundle.patch` 依次加载 `cordis.patch.yml`、水害 preset、水文主 preset、水文查询 preset。根补丁注册 charts、水文结果服务和水文父任务服务，保留默认 water-hazard preset 与 native 工具模式。三个 preset 的 ID 和插件条目 ID 保持原样。

水文包的裸包入口就是全局父任务 Host 服务，同时用于标准 Client 发现；`/tools` 在主 preset 中注册四个工具及六个技能，`/query-child` 在查询 preset 中注册目录与查询工具。`/results` 提供两个 preset 共享的持久结果服务。Host 与 Client 都使用本包的领域任务协议。

每个包单独构建到自己的 `lib`。根构建按依赖拓扑顺序执行；根类型检查与测试会先准备 Host 产物，使包名引用和声明解析与安装后的行为一致。水文和 charts 的 Client 分别用各自 esbuild 配置生成以自身包名注册的 lazy-CJS factory。根 Bundle 将四个包作为 bundledDependencies 携带，业务包的 files 包含技能目录。pnpm 不会为 bundledDependencies 内的子包单独补齐 peers，因此根 Bundle 同时声明各子包的 peer 依赖并集，开发时均链接本地 Harness，安装 tgz 时由宿主提供。

## 入口迁移

| 旧入口 | 新入口 |
| --- | --- |
| `dsh-agent-scenarios` 的水害 Host 行为 | `dsh-agent-water-hazard` |
| `dsh-agent-scenarios/water-hazard` | `dsh-agent-water-hazard` |
| `dsh-agent-scenarios/hydrology-monitoring` | `dsh-agent-hydrology-monitoring/tools` |
| `dsh-agent-scenarios/hydrology-monitoring/query-child` | `dsh-agent-hydrology-monitoring/query-child` |
| `dsh-agent-scenarios/hydrology-monitoring/results` | `dsh-agent-hydrology-monitoring/results` |
| `dsh-agent-scenarios/hydrology-monitoring/parent-tasks` | `dsh-agent-hydrology-monitoring` |
| `dsh-agent-scenarios/client` | `dsh-agent-hydrology-monitoring/client`，由其裸包 Host 自动发现 |

根包继续以 `dsh-agent-scenarios` 安装为 Bundle，只公开补丁与 package.json，不再导出业务 Host 或 Client，也没有旧入口转发。自定义 profile 中直接引用旧入口的条目应按表修改；删除 `agent-scenarios-client` 条目与 `clientOnly` 配置。沿用根 Bundle 的安装执行：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
DSH_HOME="$PWD/.dsh" node ../deepseek-harness/apps/cli/lib/bin.js plugin --profile web add .
pnpm start
```

重装后重启 Host，使三个补丁中的新入口生效。验证安装时使用独立临时 profile；现有 `.env`、`.dsh`、结果目录及 `temp` 文件不作自动修改。安装打包产物时将上述 `add .` 的路径换成 `pnpm pack` 生成的 tgz。

工具名称、参数、环境变量、技能内容、服务名与 preset ID 保持原样。持久键 `plugin:dsh-agent-scenarios/parent-task`、查询回执、结果文件、图表元数据及报告 Factory 名称继续使用既有协议；这些字符串不是被废弃的模块入口，不改名、不迁移历史会话或结果文件。
