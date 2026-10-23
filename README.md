# dsh-spec

在 DeepSeek Harness 中管理 OpenSpec 项目：以 `openspec/` 文件为唯一状态源，提供变更面板、会话绑定与 `/opsx-*` 命令，不依赖 openspec CLI。

当前版本 **0.12.0**：在 0.11.0 的人类报告与 0.10.x 渐进式详情之上新增**多角色任务编排**——用户只填最终目标、PM 和四个角色模型，AI 自动拆分子任务并生成程序 / change；PM 按工件门禁自动推进，产品 / 设计 / 开发 / 测试分别使用不同模型会话，按依赖推进；每个角色只收到目标、依赖工件与 handoff，不共享其他角色的对话。0.9.x 的会话绑定、实时状态、等待验收、AI 自动命名与人工验收勾选保持不变。

## 为什么是 SDD

规格驱动开发（Spec-Driven Development，SDD）主张先写清「意图、行为契约与验收标准」，再进入实现。其收益主要在四个方面：

- **降低返工成本**：边界条件、失败路径与兼容性约束在写代码前暴露，而不是在联调或上线后才发现；
- **评审前移**：规格的 review 成本显著低于实现后的返工，讨论也更聚焦于行为而非代码细节；
- **实现可验证**：需求、场景、任务与最终行为之间存在可追溯的对应关系，验收标准不再含糊；
- **协作上下文稳定**：无论人还是 AI，都基于同一份显式规格工作，减少口头约定与上下文漂移。

OpenSpec 是 SDD 的一种轻量实现：把上述规格与任务落到仓库文件，而不是引入重型流程或专用服务。

## OpenSpec 的价值

OpenSpec 的核心机制，是将变更的规划与执行状态外化为仓库内的显式工件：`proposal.md`、delta specs、`design.md`、`tasks.md` 与归档记录。其首要收益是**状态的持久化与可恢复性**：会话只是执行载体，即使对话中断、上下文丢失或更换模型/客户端，任务状态仍可从 `openspec/changes/<name>/` 恢复，而不依赖会话历史。

由此派生的性质包括：

- **可审计**：每个阶段的产物均为 Markdown/YAML，可 diff、review、回滚；
- **增量规格**：实施期间只修改变更内的 delta，归档时再合并进主规格，避免主规格被过程性修改污染；
- **阶段边界清晰**：proposal → specs/design → tasks → apply → sync → archive，AI 与人都知道当前该做什么；
- **工具无关**：Git 即历史，无需数据库或专用服务。

## 插件提供的便利

- **单一视图**：工件进度、任务进度、变更状态、摘要、等待验收任务与归档记录集中在一个面板。
- **一变更一会话**：每个 change 绑定独立会话，可并行推进；切换 change 自动回到对应会话。
- **操作直达**：面板按钮直接执行 `/opsx-*`，无需填写命令后再按一次回车；直接执行失败（如目标会话运行中）时自动把命令填入该会话输入框，由你手动发送。
- **运行态可见**：会话运行或等待权限时禁用主操作；完成后通知并恢复。
- **等待验收**：汇总所有未勾选任务，按「人工验收 / 其他待办」分组，可勾选或打开 `tasks.md`。
- **AI 总结命名**：提案只需描述；AI 概括要点、选择 change 名并创建工件。
- **多角色协作**：一个目标拆成多个子 change，PM 自动推进，产品 / 设计 / 开发 / 测试各自绑定模型会话；角色之间只交换工件与 handoff。
- **原生兼容**：优先使用项目已有的 OpenSpec skills；缺失时提供内置 OPSX 工作流。

## 多角色协作

适合“一个目标需要多个专业角色 + 多个子任务”的场景，例如一套游戏技能拆成「技能核心 / 火球术 / 治疗术」。

### 创建

面板「多角色任务」→「新建多角色任务」，只需要填写两样东西：

- **最终目标**：例如“为游戏新增一套技能系统，包含火球术、治疗术、冰盾，并接入现有战斗流程”；
- **五个模型**：PM / 产品 / 设计 / 开发 / 测试的 `provider/model`，留空则跟随会话默认；PM 留空时由自动调度器承担协调。

提交后会打开一个规划会话：AI 只写任务拆分文件 `openspec/orchestration/.plans/<id>.json`（1–8 个子任务、标题、change 名、依赖），Host 校验后再创建：

```text
openspec/orchestration/<program>/program.json
openspec/changes/<change>/          # 每个子任务一个原生 change
```

程序标题、ID、子任务和 change 名都由 AI 生成，用户不需要手填。规划超过 5 分钟会超时并提示检查规划会话；规划文件不合法时会在面板显示错误，不会创建半成品。

### PM 自动推进

程序默认开启 **自动推进**：

- PM 调度器每轮最多启动 2 个已就绪角色，按门禁自动推进；
- 角色完成并写入工件后，下一角色自动开始；
- 同一角色失败或空闲后 2 分钟内不重复启动，避免刷模型；
- 用户验收仍然停在最后一步，不会由 PM 代替。

PM 还可以手动「PM 巡检」：PM 模型读取任务 × 角色矩阵和 handoff，写 `openspec/orchestration/<program>/pm/status.md`，指出阻塞、风险和下一步；报告显示在程序卡片上。PM 不写业务代码，也不修改 `program.json`。

### 门禁

| 角色 | 何时可以开始 | 完成条件 |
|---|---|---|
| 产品 | 依赖任务的产品 + 设计契约完成 | `proposal.md` + delta specs + `tasks.md` |
| 设计 | 产品完成 | `design.md` |
| 开发 | 产品完成；UI 任务等待设计 | `tasks.md` 全部完成 |
| 测试 | 设计 + 开发完成 | `qa/report.md` |
| 用户 | 测试完成 | 面板中手动验收 |

开发可以先做不依赖视觉的逻辑任务；`design.md` 出现后点「继续」再做 UI。测试不会代替用户勾选 `[人工验收]` 任务。

### 上下文

角色会话收到的是：

- 最终目标与当前子任务；
- 依赖任务的 proposal / specs / design / handoff；
- 自己的规格、设计、任务清单与验收标准。

不包含其他角色的对话历史。每个角色完成后写一份不超过 200 字的 handoff 到 `openspec/orchestration/<program>/handoffs/<task>-<role>.md`，下一角色只读这份摘要与工件。

### 命令

面板按钮最终执行：

```text
/opsx-plan <draft-id>                         # AI 拆分最终目标
/opsx-role <program> <task> <role>            # 启动某个角色
/opsx-pm <program>                            # PM 巡检并写 pm/status.md
```

`/opsx-role` 由 Host 再次校验门禁；需要强制执行时加 `--force`。角色会话模型由面板在启动时通过 DSH 的 per-session model selection 选择，之后可在「模型」中修改。

## 快速开始

要求 DSH 0.2.x，无需安装 openspec CLI。

安装方式：

- 侧栏「插件 → 添加插件」，填本地目录、Git 地址或包名；首次安装后重启 DSH。
- 或使用 CLI：

```powershell
dsh plugin --profile <profile> add <插件目录或仓库地址>
```

工作区没有 `openspec/` 时，在面板点击「初始化 OpenSpec」，生成 `config.yaml`、`specs/` 与 `changes/archive/`，不覆盖已有文件。

本地开发：

```powershell
node tools/build.mjs
node --test --test-isolation=none "tests/*.test.mjs"
```

Host 半改动需重启 DSH；client 半重新构建后刷新页面。混版运行时（旧 Host + 新 client）面板会按需回读 `proposal.md` 补全简略区，因此升级 client 后不必为了「为什么做 / 会改什么」而重启进程；Host 侧新增能力仍以重启 DSH 为准。

## 截图（0.10.0）

本机 DSH Web 验证实例，展示渐进式变更详情、文档分组与双进度圈：

| 面板（工件/任务双进度圈 · 摘要行 · 原生下一步） | 变更详情：概览优先（Why / 会改什么 / 影响状态） |
|---|---|
| ![面板](docs/panel.png) | ![变更详情概览](docs/panel-detail.png) |

| 变更详情：文档分组（Delta 只列一次） | 变更详情：任务清单按需展开 |
|---|---|
| ![文档分组](docs/panel-detail-groups.png) | ![任务清单](docs/panel-detail-tasks.png) |

| 深色模式 | 900px 窄屏 |
|---|---|
| ![深色模式](docs/panel-dark.png) | ![900px](docs/panel-900.png) |

| 会话快捷条（原生下一步 / 任务进度） | 归档视图（本地日期分组） |
|---|---|
| ![快捷条](docs/quickbar.png) | ![归档](docs/archive.png) |

## 演示视频

点击缩略图播放或下载 MP4。

| 多任务并行不抢会话窗口 | 一键使用与实时状态更新 | 变更自动提取摘要信息 |
|---|---|---|
| [![多任务并行不抢会话窗口](docs/videos/multi-session-parallel.jpg)](docs/videos/multi-session-parallel.mp4) | [![一键使用与实时状态更新](docs/videos/one-click-live-status.jpg)](docs/videos/one-click-live-status.mp4) | [![变更自动提取摘要信息](docs/videos/auto-summary.jpg)](docs/videos/auto-summary.mp4) |
| 每个 change 绑定独立会话，切换不打断。<br>[▶ 播放](docs/videos/multi-session-parallel.mp4) | 面板按钮直接执行，状态实时刷新。<br>[▶ 播放](docs/videos/one-click-live-status.mp4) | AI 概括描述，生成一句话摘要。<br>[▶ 播放](docs/videos/auto-summary.mp4) |

## 使用

### 总览与等待验收

顶部为工件/任务双进度圈及统计信息。其下的「等待验收」汇总所有未勾选任务：

- 按「人工验收 / 其他待办」分组并显示数量；
- 可直接勾选，或点击行打开对应 `tasks.md` 并定位行号；
- 变更会话运行中时禁用勾选；任务超出 200 条载入上限时提示查看原文件。

### 变更卡片

卡片显示 change 名、实时状态、绑定会话、工件 chips、任务进度与下一步操作。折叠时显示**一行摘要**（`.openspec.yaml` 的 `goal` → proposal `## Why` 首段 → 「尚未生成提案」提示），截断时提供「查看全文」入口。

展开后为渐进式详情：先给概览（Why 摘要、What Changes 首条与总条数、影响范围与状态、校验 / 同步预览入口）；文档按生效 schema 的 artifact 分组且默认收起，规格变更按 capability 各列一次并显示该文件 ADDED / MODIFIED / REMOVED / RENAMED 计数，Delta 文档只出现一次；0 条校验问题不渲染问题区，元数据降为末位折叠分组，任务清单在「任务」分组内可展开，并支持 `[人工验收]` 任务的手动勾选。展开状态只是内存视图态，不写入 `openspec/` 或插件存储。

### 提案与探索

「提案」只需填写描述。插件发送 `/opsx-propose --auto <描述>`，AI 将：

1. 概括描述；
2. 选择 kebab-case 的 change 名（避开已有 change）；
3. 写入 `goal`（一句话中文摘要）、`.openspec.yaml` 与规划工件；
4. 停止并等待评审。

已确定名称时可直接使用：

```text
/opsx-propose my-change-name 变更说明
```

「探索」为只读调查与讨论，不写文件。

### 快捷条、绑定与状态

快捷条在空白会话中并入「工作区 / 模式」行，对话开始后移至输入框下方。

- 一个 change 绑定一个会话，绑定保存在当前浏览器；
- 手打阶段命令时，按会话标题 `[阶段] 主题` 自动补绑定；
- 运行中或等待确认时禁用主操作；
- 完成或需要权限时发送系统通知（未授权则回退为页内提示）。

### 通知与文档

系统通知需浏览器授权。Markdown 文档在面板内的大尺寸阅读器中打开，支持放大、截断后继续读取与「去工作区对齐」。

### 人类报告

归档的目标是给人看，而不仅是给规格用。面板为两类范围提供报告入口：

- **单变更报告**：展开「已归档变更」后，每个归档条目右侧有报告按钮；点击打开报告对话框（报告目录、或直接写入归档目录、已有报告状态）。
- **时间段报告**：归档区标题右侧的「按时间段生成报告」入口，选择起止日期（默认近 7 天，按归档日期含首尾统计），对话框实时显示命中的已归档变更数量与清单。

对话框提交后只把组合好的报告提示词填入目标会话输入框，**不会自动发送**，可在发送前修改提示词。提示词要求报告按「先定位主线 → 再展开本次工作 → 最后回归主线」组织，细节默认折叠、证据分级（原文 / 推断 / 未验证）如实标注；时间段报告还要求主会话为每个 change 派发只读子 agent 收集事实卡，再汇总成**一份**按时间段命名的报告。

- 报告目录默认为工作区下的 `人类文档/`，按工作区记住（浏览器 `localStorage`，不写入 `openspec/`）；也可填绝对路径，但必须位于当前工作区内（工作区外路径会被 Host 拒绝，因为 DSH 文件策略无法写入或校验）。
- 输出命名：单变更写入 `<报告目录>/<change-name>/index.html`，或选择写入归档目录的 `report.html`；时间段写入 `<报告目录>/<from>_<to>/index.html`。
- 已生成的报告由只读动作 `report-status` 发现：对话框显示「已生成」、生成时间与路径，可沙箱预览（`<iframe sandbox="">`，不执行报告脚本）或复制路径。
- 可选的项目级主线卡 `openspec/report-context.md` 存在时，提示词锚定真实主线；缺失时报告标注「主线来源：推断」并列出缺口。

报告写到归档目录之外时，归档目录会留下 `report.json` 指针；时间段报告在 `<from>_<to>/report.json` 记录范围与纳入清单。报告自身在「归档信息」与页脚保留引用，并声明不替代规格真相源。

## 命令

DSH 命令名不能带冒号，原生 `/opsx:*` 映射为 kebab-case：

| 原生 | DSH 命令 | 作用 |
|---|---|---|
| `opsx:explore` | `/opsx-explore [主题]` | 只读调查与讨论 |
| `opsx:propose` | `/opsx-propose <name> [说明]` 或 `/opsx-propose --auto <描述>` | 创建 change 与规划工件；`--auto` 由 AI 总结并命名 |
| `opsx:update` | `/opsx-update [name] [修订要求]` | 只修订已有规划工件 |
| `opsx:apply` | `/opsx-apply [name]` | 从首个未勾选任务继续实施 |
| `opsx:sync` | `/opsx-sync [name] [--yes\|--dry-run]` | 默认 AI 工作流；`--yes` 确定性合并，`--dry-run` 只预览 |
| `opsx:archive` | `/opsx-archive [name] [--yes\|--dry-run\|--skip-specs]` | 默认 AI 工作流；`--yes` 确定性归档，`--skip-specs` 只移动 |
| — | `/opsx-validate [name]` | 直接输出原生分级校验结果 |
| — | `/opsx-status` | 直接输出进行中变更、工件状态、任务进度与归档数量 |
| — | `/opsx-plan <draft-id>` | 让规划模型把最终目标拆成子任务，只写规划文件（插件扩展，无原生对应） |
| — | `/opsx-pm <program>` | PM 巡检项目进度与阻塞，写 `pm/status.md`（插件扩展，无原生对应） |
| — | `/opsx-role <program> <task> <role>` | 向多角色任务的一个角色发送只含依赖工件的上下文包（插件扩展，无原生对应） |
| — | `/openspec-init` | 幂等创建原生骨架 |

### 命令细节

- **多变更选择器**：存在 ≥2 个进行中 change 时，裸提交上述 change 命令会先弹出列表；选中后回填命令。
- **阶段标题**：阶段命令成功后会话标题变为 `[探索] 主题`、`[提案] change` 等；`--yes` 收尾用 `[已同步]` / `[已归档]`。
- **sync / archive**：默认 AI 路径先评估、确认，再编辑主 specs / 归档；即使校验有 ERROR 或归档目标已存在，也先提交提示词，由 AI 按 STOP gate 停止并报告。确定性 `--yes` 在命令层拒绝并保证失败不落盘。
- **范围**：核心工作流提供命令；`new` / `continue` / `ff` / `verify` / `bulk-archive` / `onboard` 通过内置文件语义 skills 提供；store / workspace / initiative 不在范围内。

## 内置 OPSX 工作流 skills

插件内置上游 OpenSpec 1.14.3 的 12 个 OPSX skills（`src/native-snapshot/skills/`），运行时注入「CLI → 工作区文件」适配说明。原生技能存在时优先使用且不修改；缺失时注册工作区感知的 fallback。归属与刷新方式见 `src/native-snapshot/ATTRIBUTION.md`。

## 原生语义

artifact 状态仅由文件决定：

| 状态 | 判定 |
|---|---|
| `done` | `generates` 路径存在 |
| `skipped` | `skip_specs: true` 跳过 specs |
| `ready` | 依赖已完成，自身输出未生成 |
| `blocked` | 仍有未完成依赖，`missingDeps` 给出 ID |

`/opsx-validate` 与面板校验问题为确定性的原生校验子集：proposal 的 `## Why` 长度、`## What Changes`、delta 位置、ADDED/MODIFIED requirement 的 SHALL/MUST 与场景标题层级、`skip_specs` 冲突、`tasks.md` 复选框解析、change 元数据与主 spec 必需章节。非全量规则见「已知边界」。

## 架构

```text
src/host.js            Host 半：命令族、/dsh-spec 路由、fallback skills provider
src/commands.js        十二条命令：变更选择、propose 脚手架、AI sync/archive、确定性路径、直出、/opsx-plan、/opsx-role、/opsx-pm
src/session-titles.js  阶段会话标题组合与幂等写入
src/prompts.js         阶段提示词、OPSX sync/archive 提示词、AI 自动命名提示词、报告提示词
src/report/            报告方法论（内嵌进提示词）与自包含 HTML 模板（构建镜像到 lib/report/）
src/native/**          纯 JS 原生语义引擎：yaml / config / metadata / schema / graph /
                       spec / summary / tasks / validate / state / instruction / merge /
                       archive / skills / skill-adaptation / init / fsio / orchestration
src/native-snapshot/   固定版本 schema、模板与 12 个 OPSX SKILL.md 快照
src/client.js          浏览器半：面板、快捷条、绑定、直接执行、状态订阅、通知、文档阅读器、
                       报告对话框与沙箱预览
src/client-helpers.js  纯展示辅助：排序、摘要、分页、任务清单、等待验收聚合、报告区间与输出路径
tools/build.mjs        构建（Host 拷贝 + client 内联，无打包器）
tools/sync-native-snapshot.mjs  开发期刷新内置 schema/模板/skills 快照与版本标记
tests/                 node:test 单元与集成测试
```

设计原则：文件即真相源；Host 侧单一语义引擎；UI 使用宿主插槽与主题 token；命令直出不占模型 token；原生快照带版本与 MIT 归属；零新增运行时依赖。

## 已知边界

- **原生语义子集**：校验/合成为高保真子集，个别原生错误与警告不出现。
- **未覆盖的校验规则**：`--strict` 与默认模式区分、proposal `Capabilities` 与 delta 一一对应、`REMOVED` / `MODIFIED` / `RENAMED` 目标的跨文件校验、`**Reason**` / `**Migration**` 强制、场景内 `WHEN` / `THEN` 结构化检查等。
- **AI 合并风险**：默认 AI 工作流直接编辑主 specs；确定性 `--yes` 可作为对照与回退。
- **YAML 子集**：anchor / merge key / 多行 flow 等结构会带行号报错。
- **上下文长度**：`openspec/config.yaml` 的 `context` 超过 50KB 会被忽略并警告。
- **绑定作用域**：绑定保存在浏览器 `localStorage`，不写入仓库；换浏览器后可按会话标题重建或新建会话。
- **任务勾选**：`task-toggle` 只改写 `tasks.md` 的目标行；行号失效或非任务行会被拒绝。
- **模型依赖**：提案/实施由 AI 执行，需要会话已配置模型；插件本身不调用模型。
- **选择器边界**：仅在 Web 客户端、≥2 个进行中 change 时接管 change 命令；不做内联补全与标志二级选择。
- **新会话里的命令结果可见性**：hero 页没有会话轨迹，只有会产生模型回合的命令（探索 / 提案 / 实施 / 更新 / 同步 / 归档的默认 AI 路径）能在提交后切到对话并显示结果；返回直接命令结果的命令（`/opsx-status`、`/opsx-validate`、`--yes` 确定性归档、规划已完成的 `/opsx-propose` 直出等）需要已有会话轨迹才能看到输出。归档按钮因此固定走 AI 路径。
- **propose 续做边界**：同名 `/opsx-propose` 对已存在 change 按原生状态分支——规划未完成时原地续做（不重写 `.openspec.yaml`，只创建缺失工件；已有工件只读），规划已完成时直出下一步指引、不产生模型回合。`specs/**` 完整性由提示词按 capability 核对，不是引擎级强校验；中断造成的孤立 change 不会被自动删除或回滚。
- **面板失败兜底**：面板动作优先直接执行；被拒绝或执行失败时回退为「把命令填入目标会话输入框」而不自动发送，因此失败不再表现为点击无反应，最终发送仍由用户确认。
- **写操作范围**：面板只通过 `task-toggle`、`orchestration-*` 路由写任务勾选、编排元数据与子 change 骨架；sync / archive 仍由命令触发（默认 AI 工作流不写盘，`--yes` 才确定性写盘）。
- **expanded 命令族**：new / continue / ff / verify / bulk-archive / onboard 只通过内置 OPSX skills（文件语义）提供，不提供对应 `/opsx-*` 命令。
- **多角色门禁是工件级而非语义级**：门禁检查 proposal / specs / design / tasks / qa 报告是否存在、任务是否全部完成，不判断规格或代码质量；最终质量仍由用户验收。
- **自动推进是浏览器端调度器**：面板打开且程序开启自动推进时，每轮最多启动 2 个已就绪角色；页面关闭后不会在后台继续启动新角色。同一角色失败/空闲后 2 分钟内不重复启动；用户验收始终手动。
- **PM 是监督角色而非最终裁决**：PM 巡检写 `pm/status.md`，指出阻塞与下一步；真正启动角色的是确定性门禁调度器，PM 不会绕过门禁或代替用户验收。
- **UI 等待设计是提示词级门禁**：开发角色可在产品规格完成后启动，提示词要求先做不依赖视觉的任务；逐条 UI 任务不会在引擎层被硬阻断，测试门禁仍要求 `design.md` 存在。
- **模型绑定依赖 DSH 目录**：`provider/model` 必须是当前 DSH 已配置的模型；模型选择失败时该角色不会启动，也不会偷偷回退到默认模型。
- **编排元数据不是 OpenSpec 原生 schema**：`openspec/orchestration/<program>/program.json` 与 handoffs 是插件扩展；每个子任务仍是标准原生 change。

## License

MIT。OpenSpec 工作流语义、schema/模板快照与 12 个 OPSX skills 正文来自 [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)（MIT，1.14.3，commit `c794978`），归属见 `src/native-snapshot/ATTRIBUTION.md`。
