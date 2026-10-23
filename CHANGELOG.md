# Changelog

## 0.12.0

多角色任务编排：一个目标拆成多个原生 change 子任务，PM 把控进度并自动推进，产品 / 设计 / 开发 / 测试各自使用独立会话与模型，按依赖工件门禁推进；角色之间只交换工件与 handoff，不共享对话。

### Added

- **多角色任务面板**：新建程序时用户只填最终目标与 PM / 产品 / 设计 / 开发 / 测试五个角色的 `provider/model`；AI 规划会话自动拆分子任务、生成程序标题 / ID / change 名，Host 校验后再为每个子任务生成原生 change 骨架。
- **AI 任务拆分**：`/opsx-plan <draft-id>` 让规划模型把目标拆成 1–8 个任务（含依赖），只写 `openspec/orchestration/.plans/<id>.json`，不创建 change、不写业务代码；客户端轮询该文件，成功后调用 `orchestration-create`，超时 5 分钟并给出可读错误。
- **角色会话与模型**：每个 `(program, task, role)` 绑定独立会话；启动角色时通过 `ctx.sessions.selectModel` 应用该角色的 provider/model，支持之后在「模型」对话框中修改。
- **依赖门禁**：产品完成后设计/开发可开始；设计完成后 UI 开发才具备完整上下文；测试需设计 + 开发任务全部完成；用户验收需测试报告。面板显示每个角色的完成 / 可开始 / 等待 / 运行中状态与缺失原因。
- **`/opsx-role` 命令**：Host 再次校验门禁，组合角色上下文包并提交给会话；`--force` 可显式跳过门禁。
- **PM 自动推进**：程序默认 `auto: true`，面板调度器按门禁每轮最多启动 2 个已就绪角色；同一角色失败/空闲后 2 分钟冷却；测试完成后停在用户验收，不自动代替用户。
- **PM 巡检**：`/opsx-pm <program>` 让 PM 模型读取任务×角色矩阵与 handoff，写 `openspec/orchestration/<program>/pm/status.md`，报告阻塞、风险与下一步；`orchestration-auto` 路由可随时暂停/恢复自动推进。
- **上下文包**：只包含程序目标、当前子任务、依赖任务的 proposal/specs/design、角色自己的工件与短 handoff；不包含其他角色对话。
- **文件布局**：`openspec/orchestration/<program>/program.json`、`handoffs/<task>-<role>.md`、`pm/status.md`；程序元数据是插件扩展，子任务仍是标准 OpenSpec change。
- **测试**：`native-orchestration` 覆盖创建、依赖门禁、上下文包、验收、环检测与 PM 报告；Host 路由、`/opsx-plan`、`/opsx-pm` 与 `/opsx-role` 命令均有测试，并与 0.11.0 人类报告回归共存（全套 513 项）。

### Changed

- Host `state` 载荷新增 `orchestration` 数组、`auto` 与 `pmStatus`；新增 `orchestration-draft` / `orchestration-plan` / `orchestration-create` / `orchestration-accept` / `orchestration-auto` / `orchestration-roles` 路由。
- 命令注册新增 `/opsx-plan`、`/opsx-pm` 与 `/opsx-role`（共 12 条）；会话标题新增 `[规划]` / `[PM]` / `[产品]` / `[设计]` / `[开发]` / `[测试]` 阶段。
- README 增补多角色协作、门禁、上下文包与命令说明；保留 0.11.0 人类报告和演示视频。
- 插件版本 `0.11.0` → `0.12.0`。

## 0.11.0

新增「人类报告」：对已归档变更（单个，或按时间段汇总）一键生成给人看的 HTML 报告；面板只把报告提示词填入会话输入框，不自动发送。

### Added

- **面板入口**：归档条目新增报告按钮；归档区新增「按时间段生成报告」入口（默认近 7 天，按归档日期含首尾统计，实时显示命中数量与清单）。对话框支持报告目录与单变更的「写入归档目录」选项；已生成报告显示生成时间/路径，可沙箱预览（禁用脚本的 `iframe`）或复制路径；报告目录按工作区保存在浏览器 `localStorage`，不写入 `openspec/`。
- **方法论与模板资产**：`src/report/report-methodology.md` 作为单一真相源内嵌进提示词（先定位主线 → 展开本次工作 → 回归主线、渐进披露、时间段汇总、子 agent 编排、反模式、证据分级）；`src/report/report-template.html` 为自包含单文件模板（内联 CSS、无脚本/外链、可打印、`<details>` 折叠、单变更与时间段双形态），构建时镜像到 `lib/report/`。
- **只读 Host 动作**：`/dsh-spec` 新增 `report-prompt`（组合提示词：归档事实、delta 统计、主规格、主线卡或推断标记、模板/输出路径、子 agent 编排）与 `report-status`（指针 → 命名约定 → 归档目录回退发现报告），覆盖单变更与时间段两种范围；时间段按归档日期过滤（1–30 个 change），两个动作都不写盘、不发起模型回合。
- **主线卡**：可选 `openspec/report-context.md`（插件只读、≤50KB）存在时报告锚定真实主线/支线/目标；缺失时报告标注「主线来源：推断」并列出缺口。
- **引用保留**：单变更报告写到归档目录之外时在归档目录留下 `report.json` 指针；时间段报告在 `<from>_<to>/report.json` 记录范围与纳入清单；报告自身「归档信息」与页脚保留引用并声明不替代规格真相源。
- **多行提示词填入**：`composeFor` 优先使用宿主 `conversation.input.shell().setDraft()`（多行安全），DOM 插入仅作兜底；仍不自动发送。

### Changed

- `tools/build.mjs` 构建时镜像 `src/report/` 到 `lib/report/`；`package.json` 的 `files` 已包含 `src` 与 `lib`，无需新增 exports。

### Notes

- 本版 Host 半改动需重启 DSH 进程；client 半重建 `lib/client.js` 后刷新页面生效。混版运行时报告动作会以路由错误提示，其余面板功能不受影响。
- 报告生成是 AI 在会话内的写盘行为，面板与路由均只读；归档后 `MODIFIED` / `REMOVED` 的旧文本未留存，报告按「原文 / 推断 / 未验证 / 归档材料中未见」标注。

## 0.10.2

修复「快捷条/hero 里的『开始提案』『探索』点击无反应」：0.10.0 把面板的对话框提交函数改成唯一实现时，快捷条（`DockBody`）里的 `submitPropose` / `submitExplore` 闭包被删掉，而 JSX 仍在调用，点击会抛 `ReferenceError` 并静默无动作。现在两个座位复用同一份提交实现，并由源码结构测试钉住这条接线。

### Fixed

- **快捷条「开始提案」失效**：对话页/hero 快捷条（含 `conversation.hero.options` 座位）弹出的「新建提案」对话框，点「开始提案」只会抛 `Uncaught ReferenceError: submitPropose is not defined`——对话框不关、命令不发送、也没有错误提示；面板（`WorkspaceDetail`）里的同名对话框不受影响。修复提取 `createDialogSubmitters` 共享工厂，面板与快捷条都从它取 `submitPropose` / `submitExplore`，避免再次出现「删一处、留一处」。
- **快捷条「探索」对话框同样失效**：同一原因导致的 `submitExplore is not defined` 一并修复。
- **面板动作失败时不再「无反应」**：`WorkspaceDetail` 的命令按钮在直接执行被拒绝（目标会话运行中/等待权限、Host 校验失败等）时，把完整命令填入目标会话的输入框（不自动发送）并提示「命令已填入输入框，请手动发送」；成功路径仍是直接执行。
- **回归测试**：新增 `tests/client-structure.test.mjs`，从源码结构断言面板与快捷条都调用同一个 `createDialogSubmitters`，且两个对话框的提交调用都保留；全量 464 passed。

### Notes

- 本版只改浏览器半：`lib/client.js` 重建后刷新页面即可生效，不需要重启 DSH。
- 面板动作的兜底只在直接执行失败时触发；若目标会话无法打开，仍显示原来的失败提示。

## 0.10.1

修复「长驻 DSH 进程还没重启，刷新页面后面板简略区空白」：只更新了浏览器半时，Host 的 `state` 载荷仍是旧版（0.9.x 只有 `description` / `highlights`，0.8.x 连 `summary` 都没有），面板「为什么做 / 会改什么」只能显示「尚未生成提案」。浏览器半现在会在 state 发布后按需回读 `proposal.md` 自补摘要，旧 Host 无需重启即可看到简略内容。

### Fixed

- **旧 Host 下简略区为空**：`createWorkspaceSource` 在每次 state 发布后，对 `summary.why` 为空的 change 通过既有的 `document` 路由读取其 `proposal.md`，按 Host 同口径提取 Why 首段与 `## What Changes` 前 4 条（Why 280 字符、每条 140 字符），只补空槽、不覆盖 Host 已给的值；回读结果按 change+文档路径缓存 10 秒，避免 2 秒轮询变成文档读取循环。
- **混版载荷兼容**：`normalizeChangeSummary` 在缺少 `why` / `changes` 时回退到 0.9.x 的 `description` / `highlights`；`changeSummaryInfo` 再兜底 `description` → `headline`，折叠卡摘要行不再空白。
- **测试**：`proposalSummaryDigest`（`## Why` / `## What Changes` 提取、CRLF/BOM、缺失章节、280/140 字符上限与截断标记）、`proposalDocOf` / `summaryNeedsProposalFallback` / `applyProposalDigest` 的空槽合并、`normalizeChangeSummary` 旧字段回退与「pre-0.9 Host 载荷 + proposal.md 回填」整链场景；全量 461 passed。

### Notes

- 本版只改浏览器半（`src/client-helpers.js` + `src/client.js`），Host 无改动；`lib/client.js` 重新构建后刷新页面即可生效，不需要重启 DSH。
- 完整功能（如 Host 侧新增的逐文件 delta 计数、artifact `description` / `generates`）仍需在方便时重启 DSH 进程才会启用；简略区不再依赖这一步。

## 0.10.0

面板 change 详情改为渐进式披露：折叠卡新增一行摘要，展开先给概览，文档按 artifact 分组且默认收起，Delta 文档只列一次并带逐文件操作计数；0 校验问题与空区块不再占位，展开状态只存在于内存。0.9.2 的变更卡片 headline 由本版本的摘要行与 L1 概览取代（`summary.headline` 仍保留在 Host 载荷中供旧客户端降级读取）。

### Added

- **折叠卡摘要行**：change 名下方显示一行摘要，来源优先级 `.openspec.yaml` 的 `goal` → proposal `## Why` 首段 → 「尚未生成提案」提示。摘要与 `## What Changes` 要点由 Host 从已读的 `proposal.md` 提取（行内 Markdown 会被剥离），并设上限：Why 280 字符、What Changes 4×140 字符；截断时卡片与概览都提供「查看全文 / 展开全部」入口。
- **变更详情概览（L1）**：展开先展示 Why 摘要、What Changes 首条与总条数、影响范围与状态（工件 / 任务 / capability / 校验问题 / 下一步），以及「校验 / 同步预览」次要操作；不再先铺开文档列表。
- **文档分组（L2）**：文档按生效 schema 的 artifact 顺序分组（提案 / 规格变更 / 设计 / 任务 / `.openspec.yaml` 元数据），每组默认收起、点开才显示文档行；规格变更按 capability 各列一次，并显示该文件 ADDED / MODIFIED / REMOVED / RENAMED 计数。
- **Host 载荷（additive）**：`ChangeState.summary`、`delta.files[]` 逐文件操作计数、artifact `description` / `generates`；不新增文件读取（proposal / tasks / delta 文本本就在状态计算中读取，摘要不需要额外 IO）。
- **测试**：`extractProposalDigest` / `withArtifactMetadata`、摘要选择、文档分组、逐文件计数与旧载荷降级的单测；README 截图、`docs/native-module-contract.md` 载荷说明同步更新。

### Changed

- change 详情不再一次性渲染 `.openspec.yaml` 元数据、任务清单、全部文档、重复的 Delta 文档列表、校验问题与下一步建议：元数据降为末位默认收起分组，0 条校验问题不渲染问题区，「下一步建议」并入概览状态行，Delta 文档从「文档」区去重（只在规格变更分组出现一次）。
- 卡片/分组的展开状态仅存在于内存：文件变化刷新后保持，重新挂载后恢复默认收起，不写入 `openspec/` 或插件持久化存储。
- 0.9.0–0.9.2 的会话绑定 / 实时状态 / 等待验收 / 人工验收勾选保留：卡片头显示运行状态、绑定会话与「实施 / 归档」直接执行按钮，任务分组里的复选框支持人工验收勾选。
- 插件版本 `0.9.3` → `0.10.0`。

### Notes

- Host 半改动需重启 DSH 进程；client 半改动构建后刷新页面生效。
- 归档详情、工作区概览页与文档阅读器不在本次范围内，保持原样。

## 0.9.3

修复提案生成被中止（用户 Stop / 模型失败）后无法继续的问题：`/opsx-propose` 改为按原生规划状态分支——同名 change 可原地续做，规划已完成时直出下一步；面板/快捷条的「继续规划」也改为真正可执行的 propose 续做。

### Fixed

- **中断的提案无法续做**：`/opsx-propose <name>` 对已存在的 change 不再直接拒绝。规划未完成时读取原生 artifact 状态、保留 `.openspec.yaml`（不重写 `schema` / `created` / `skip_specs` / `goal`）并提交续做提示词，只创建缺失/可规划工件；规划已完成时直出下一步指引（`/opsx-update` 修订、`/opsx-apply` 实施、`/opsx-archive` 归档），不产生模型消息。此前 propose 拒绝、update 无法创建、apply 无工件可做，三者互相指回，中断后的 change 只能改名重来。
- **目录缺 metadata 的残留 change**：change 目录存在但 `.openspec.yaml` 缺失时补写一次（schema 取项目生效值、`created` 取本地日期）后按续做处理；metadata 无法解析时拒绝且不覆盖。
- **面板/快捷条「继续规划」指向不可执行命令**：规划未完成的下一步动作从 `/opsx-update` 改为 `/opsx-propose <name>` 续做（`nextActionResume`），点击把带 change 名的命令填入输入框（不自动发送），新会话 hero 页回车后产生可见模型回合。

### Changed

- **续做提示词**：`buildProposePrompt` 新增 `resume` 模式——续做声明（已有工件只读、只补缺失工件）、glob 工件核对（`specs/**` 按 proposal capability 核对缺失 delta 文件并只补缺失文件）、已有工件校验问题注入（上限 20 行，要求先修复再创建依赖工件）；停止边界不变。
- 文档：README 命令表 / 快捷条 / 已知边界记录 propose 三态行为与 hero 直出边界；`docs/native-module-contract.md` 更新 propose 提示词与命令契约。
- 测试：`tests/commands.test.mjs` 新增续做 / 已完成直出 / metadata 场景并改写旧「拒绝已存在目录」用例；`tests/prompts.test.mjs` 新增续做、glob 核对、校验问题用例；`tests/client-helpers.test.mjs` 的下一步断言改为 propose 续做。
- 插件版本 `0.9.2` → `0.9.3`。

### Notes

- Host 半改动需要 `node tools/build.mjs` 重建 `lib/` 并重启 DSH 进程后生效；client 半改动构建后刷新页面即可。
- 已知边界：规划已完成时 propose 的直出结果在 hero 页不可见（属既有直出命令限制）；`specs/**` 完整性由提示词核对而非引擎强校验；中断产生的孤立 change 不会被自动清理。

## 0.9.2

总面板新增「等待验收」聚合任务清单，并压缩变更卡片上的摘要文案。

### Added

- **等待验收任务清单**：面板总览新增可折叠 Section，汇总所有进行中变更的未勾选任务，并按「人工验收 / 其他待办」两组展示；每组显示数量、支持分页；行内显示 change 名、任务文本与人工验收标签，可直接勾选（变更会话运行中时禁用），点击行打开对应 `tasks.md` 并定位行号。任务超过单次 200 条载入上限时显示明确提示。
- `client-helpers.js` 新增纯函数 `pendingAcceptanceTasks(changes)`，负责跨 change 聚合、人工/非人工分类与稳定排序，并有单测。

### Changed

- **压缩变更卡片摘要**：新增 `ConfirmChangeState.summary.headline`，按「`.openspec.yaml` goal → `## What Changes` 首条要点 → `## Why` 首句」提取一句短标题（如「新增幼狮卡牌」，上限 32 字），折叠卡片只显示这一行；完整描述与 `## What Changes` 要点移至展开详情，不再把整段 Why 截到面板上。
- `buildAutoProposePrompt` 要求 AI 在 `.openspec.yaml` 写入 4–20 字的 `goal`（面板 headline）；显式 propose 提示词也要求 AI 在 goal 为空时补一句短摘要。
- README 重写为「SDD 收益 → OpenSpec 的价值（状态持久化与可恢复性）→ 插件便利 → 快速开始 → 使用与技术细节」的简洁结构。
- 插件版本 `0.9.1` → `0.9.2`。

## 0.9.1

提案改为 **AI 总结后自动命名**，不再使用本地关键词启发式。

### Changed

- 「新建提案」只填写描述；面板发送 `/opsx-propose --auto <描述>`。Host 先准备 `openspec/` 骨架，然后提交一个自动命名提案提示词：AI 先总结描述、按 kebab-case 规则选择 change 名（避开已有 change），再创建 `openspec/changes/<name>/.openspec.yaml` 和全部规划工件。
- 客户端在命令发出前记录当前 change 名单；命令成功后轮询工作区，发现第一个新 change 即把它绑定到发起提案的会话（最多等 10 分钟，超时会发通知）。这样「提案开始即绑定」仍然成立，即使名称直到 AI 回合结束才出现。
- 显式 `/opsx-propose <change-name> [说明]` 保持不变；`--auto` 是可选的自动命名路径。
- 移除客户端 `deriveChangeName` 关键词/哈希命名启发式，避免生成不准确的名称。
- **Markdown 阅读器恢复大尺寸**：`DocModal` 默认宽度从 800px 调整为响应式 `min(1200px, calc(100vw - 48px))`，正文视口默认 `min(78vh, 1040px)`，并新增「放大阅读 / 退出放大」切换；避免在高分辨率屏幕上变成小弹窗。
- `buildAutoProposePrompt` 新增于 `src/prompts.js`，`commands.test.mjs` / `prompts.test.mjs` 覆盖自动命名分支与提示词结构；README 与契约文档同步。
- 插件版本 `0.9.0` → `0.9.1`。

### Notes

- 自动命名仍需模型可用；AI 未在 10 分钟内创建新 change 时，面板会收到超时通知，可改用显式 `/opsx-propose <name> <描述>`。
- Host 半改动需要重新构建并重启 DSH；client 半重新构建后刷新页面。

## 0.9.0

面板与会话打通：变更实时状态、一变更一会话绑定、按钮直接发送、系统通知、自动变更名、变更摘要与人工验收任务勾选。

### Added

- **变更 ↔ 会话绑定（一变更一会话）**：面板/快捷条发起的探索、提案、实施、更新、同步、归档会解析或创建目标会话，并把 `change` 与会话 id 绑定后直接在该会话执行；绑定按工作区 + change 名保存在浏览器 `localStorage`，同一会话再绑定到新 change 时会自动解除旧绑定。直接手打 `/opsx-propose <name>` 等阶段命令时，客户端监听 Host 写入的 `[阶段] 主题` 会话标题并自动补绑定；面板会显示绑定会话的短 id，点击可切回该窗口。
- **按钮直接发送，不再二次回车**：面板与快捷条的「继续规划 / 实施 / 归档 / 状态」等动作改为调用 Host `command.execute`，在绑定会话中立即执行 `/opsx-*`；「探索 / 提案」先弹轻量输入框，确认后同样直接发送。
- **实时状态 + 进行中禁用**：订阅 `uiSession.sessionStatus` 的 running / pendingInteraction，并在面板每 2 秒轮询 Host 状态；变更卡片与快捷条显示「规划中 / 实施中 / 待实施 / 已完成 / 进行中 / 等待确认」。绑定会话运行中或等待权限/回答时，主操作按钮禁用并显示原因，避免对同一变更重复发起规划/实施。
- **系统通知**：绑定会话结束本轮或出现权限/问题等待时，通过浏览器 `Notification` 弹系统提示（点击可打开对应会话）；未授权或浏览器不支持时回退为面板/快捷条内提示。
- **按描述自动生成 change 名**：新建提案对话框输入中文或英文描述即可自动生成 kebab-case 变更名（ASCII 词 + 常用中文工作流词表 + 冲突哈希），名称可编辑，确认后直接执行 `/opsx-propose <name> <description>`。
- **面板变更摘要**：Host 从 `proposal.md` 的 `## Why` 提取一段变更说明、从 `## What Changes` 提取要点（纯函数 `src/native/summary.js`，有长度上限），变更卡片不再只有名字。
- **任务手动勾选 + 人工验收标记**：任务清单的复选框可直接勾选/取消，Host 新增 `task-toggle` 路由只改写目标 `tasks.md` 行（保留 CRLF/BOM、行号失效或非任务行直接拒绝）；任务正文带 `[人工验收]`（兼容 `【人工验收】`）会被解析为人工验收任务并显示标签，AI 不会自动勾选；提案/实施提示词同步要求人工验收任务加该前缀。

### Changed

- `ChangeState.tasks.items[]` 增加 `line`（1-based 源行号）与 `manual`（人工验收标记）；`ChangeState` 增加 `summary`。
- 面板/快捷条轮询从 4s 调整为 2s（会话状态变化还会即时触发一次 Host 状态重读）。
- 「填入输入框」不再是面板/快捷条动作按钮的行为；变更选择器（多 change 时的二级列表）仍只回填，避免误执行。
- `tools/build.mjs` 的 client-helper 内联改用函数替换，避免 helper 源码里的 `$&` / `$`` 被 `String.replace` 当成替换模式。
- 修复 `tools/sync-native-snapshot.mjs` 在 CRLF 检出下 `refreshAttribution` 误报 drift 的问题（保留原换行风格）。
- 插件版本 `0.8.0` → `0.9.0`。

### Notes

- Host 半改动（`src/host.js`、`src/native/**`、`src/prompts.js`）需要 `node tools/build.mjs` 后重启 DSH 进程；client 半重新构建后刷新页面即可。
- 系统通知受浏览器权限控制；首次从面板/快捷条发起动作时会请求权限。
- 绑定是本地 UI 状态（按浏览器 origin 保存），不写入仓库或 `.openspec.yaml`；换浏览器后会按会话标题自动重建，或在下一次操作时新建会话。

## 0.8.0

修复新会话（hero 页）里「归档」在 change 有校验 ERROR 或归档目标已存在时仍然「发送后没反应」的问题：命令层不再在提交 AI 工作流之前直接拒绝，阻塞事实交给提示词 STOP gate 由模型先停止并报告。

### Fixed

- **默认 AI 路径被命令层前置门禁截断**：`/opsx-sync`、`/opsx-archive` 未带 `--yes`/`--dry-run` 时，即使原生校验有 ERROR 或归档目标已存在，也先组装并提交 OPSX 工作流提示词；校验问题与 `archiveTargetExists` 作为当前事实进入提示词，由模型按 STOP gate 先停止并报告问题/冲突，命令本身不写盘、不移动目录。此前这类 change 在新会话里点「归档」只会得到一条 hero 页无法渲染的直接命令结果，表现为「指令已填入、回车后没反应」。
- **命令结果文案注明阻塞事实**：AI 路径的结果现在说明「校验有 N 个 ERROR / 归档目标已存在，AI 会先停止并报告」，即使模型不可用也能解释接下来会发生什么。
- **archive 收尾契约补强**：`src/prompts.js` 的 archive 工作流提示词在「校验 ERROR 先停」之外并列「`Archive target exists: yes` 先停」，明确禁止合并主 specs、移动目录、覆盖已归档内容，或用确定性收尾命令绕过冲突。

### Changed

- **确定性路径不变**：`--yes` 与 `--dry-run` 仍在命令层执行校验门禁与归档目标冲突拒绝，不产生模型消息；`specs-sync-archive` 引擎的写入前校验与写入安全不变。
- README 更新 sync / archive 两条路径说明与「新会话里的命令结果可见性」已知限制；`tests/commands.test.mjs` 的「所有路径都拒绝」用例改写为「AI 路径提交提示词、确定性路径仍拒绝」，并补充 `tests/prompts.test.mjs` / `tests/instruction.test.mjs` 的 archive 停止条款断言。
- 插件版本 `0.7.0` → `0.8.0`。

### Notes

- Host 半改动需要重新构建（`node tools/build.mjs`）、以本地目录安装并重启 DSH 进程后生效。
- 新会话里其余直接命令结果（`/opsx-status`、`/opsx-validate`、确定性 `--yes`）仍受 hero 页无轨迹限制，不在本次范围内；无效 change 请先用 `/opsx-update <name>` 修复。

## 0.7.0

阶段命令按工作流阶段命名会话，解决命令会话标题显示提示词开头、难以区分的问题。

### Added

- **阶段会话标题（Host 侧）**：六条模型阶段命令成功发起后，把当前会话标题设为 `[探索] 主题` / `[提案] change` / `[实施] change` / `[更新] change` / `[同步] change` / `[归档] change`；`/opsx-sync --yes` 与 `/opsx-archive --yes`（含 `--skip-specs`）成功收尾时分别使用 `[已同步]` / `[已归档]`。主题压成单行并按 UTF-8 字节裁剪到会话标题服务的 80 字节上限（超长补 `…`），阶段前缀始终保留。
- 直出命令（`/opsx-status`、`/opsx-validate`、`/openspec-init`）、`--dry-run` 与失败命令不改标题；重复执行同一阶段命令不重复写入标题事件；标题服务缺失或写入失败静默跳过，不影响命令结果。
- `src/session-titles.js` 新增标题组合纯函数与失败隔离写入助手，`tools/build.mjs` 同步拷贝到 `lib/`，并补充纯函数与命令级单测。

### Changed

- 显式设置标题会钉住会话：该会话不再自动更新标题，且用户手动改名会被下一次阶段命令覆盖（README 已记录该取舍）。
- 插件版本 `0.6.0` → `0.7.0`。

### Notes

- 需要 DSH 组合挂载 `@deepseek-ai/dsh-session-title`；未挂载该服务的组合命令照常工作，只是不改名。
- Host 半改动需要重新构建、以本地目录安装并重启 DSH 进程后生效。

## 0.6.0

快捷条 / 面板的「归档」按钮改回 OPSX AI 归档工作流，并修复新会话（还没进入对话）时点「归档」、回车后没有任何反应的问题。

### Fixed

- **新会话里「归档」按钮无效**：按钮此前填入 `/opsx-archive <name> --yes` 走确定性路径，Host 返回的是**直接命令结果**，而 DSH 只在会话轨迹里渲染它；新会话 hero 页没有轨迹，结果被静默丢弃，草稿被清空、页面停在 hero，用户看到的就是「点了没反应」。现在按钮填入 `/opsx-archive <name>`（OPSX AI 归档工作流）：命令提交后作为模型回合进入会话，hero 页会直接切到对话并显示归档工作流提示词，AI 先检查完成度并向用户确认，再智能合并 / 跳过同步、校验，最后用 `/opsx-archive <name> --yes --skip-specs` 确定性收尾。

### Changed

- `src/client-helpers.js` 的 `deriveNextAction()`：`complete` 状态的下一步改为输出 `/opsx-archive <name>`（AI 默认）；确定性快路径（`--yes`）/ 只读预览（`--dry-run`）/ 只移动（`--skip-specs`）仍由用户显式加参数触发。
- README 与单测同步更新；插件版本 `0.5.0` → `0.6.0`。

### Notes

- 确定性 `--yes` 仍是可用的对照/回退路径，但它返回的直接命令结果需要已有会话轨迹才能看见；新会话里请用默认 AI 路径（本次修复后的按钮行为）。

## 0.5.0

多进行中 change 时，五条 change 命令改为从列表选择 change 名并自动回填输入框。

### Added

- **变更名选择器（DSH Web 客户端）**：`/opsx-update`、`/opsx-apply`、`/opsx-sync`、`/opsx-archive`、`/opsx-validate` 在工作区存在两个及以上进行中 change 时，裸提交或从 `/` 菜单选中会先弹出可筛选的「选择变更」列表（DSH `commandUi.decorate` + `popupSelect`，与 `/model` 同款弹层）；每行显示 change 名与原生状态摘要（规划中 / 可实施 / 已完成、任务 x/y、N ERROR / N WARNING、`skip_specs`）。
- 选中后只把 `/opsx-<command> <change-name> ` 回填到会话输入框并把光标放到末尾，不自动发送、不产生模型消息；用户补充修订要求或参数后回车才执行。

### Changed

- 多 change 场景下，这五条命令的「裸提交」与「`/` 菜单点选」从直接执行 / 插入命令改为先弹选择器；单个进行中 change 仍自动选中，没有进行中 change 仍走既有提示，手打参数的命令行不变。
- `src/client-helpers.js` 新增 `CHANGE_PICKER_COMMANDS` / `changePickerAvailable` / `changePickerOptions` / `changePickerLine` 纯函数与单测；`src/client.js` 新增 zh/en 选择器文案与 `commandUi.decorate` 接线（嵌套 inject，缺少客户端服务时自动跳过，面板与快捷条不受影响）。
- 插件版本 `0.4.1` → `0.5.0`。

### Notes

- 选择器只在 DSH Web 客户端生效；TUI 等非 Web 客户端与未提供 `commandUi` 的组合保持既有命令语义。
- 已知限制：DSH 不支持空格后的内联参数补全，因此是「回车 / 菜单选中 → 二级列表」；不提供 sync / archive 标志（`--yes` / `--dry-run` / `--skip-specs`）的第二级选择，也不选择已归档 change。

## 0.4.1

窄窗口下快捷条排版不再换行错位。

### Fixed

- **窄窗口快捷条换行**：快捷条与宿主自带的 context meter 共用输入框下方同一行，窗口变窄时原来会折成两行（状态单独一行、动作按钮被顶到右边，和宿主的统计行挤在一起）。现在快捷条始终单行：变更名自动省略号截断；按窗口宽度分级隐藏次要控件——≤1300px 收起 skills 徽标、≤1200px 收起状态区徽标、≤1100px 收起「状态」按钮、≤1000px 收起「探索 / 提案」次级按钮，只保留「当前变更 + 下一步主按钮 + 面板入口」。
- **hero 行的变更切换菜单**：新会话态位于窗口顶部、工作区行右端，变更切换下拉改为向下展开并右对齐，避免超出视口被裁掉。

### Changed

- `src/client.js`：`QuickBar` 的 dock 改为 `flex-wrap:nowrap` + 可收缩状态区（`min-width:0` + 省略号），新增 `dshspec-dockSkills` / `dshspec-dockStatusBtn` / `dshspec-dockGhost` 分级隐藏钩子。
- 插件版本 `0.4.0` → `0.4.1`。

## 0.4.0

工作区概览拆成「工件 / 任务」两个独立进度圈；变更详情与归档详情恢复默认收起、可展开的任务清单。

### Added

- **双进度圈**：工作区概览同时显示工件进度圈（`(done + skipped) / artifact 总数`）与任务进度圈（`已勾选 / 任务总数`），两圈各自独立聚合、独立配色、各自到 100% 才变绿；没有任务清单时任务圈显示 `—` 并提示还没有任务清单，不再出现「工件 100% 但任务仍有几十项未完成」的单一 100% 误导。原本的 artifact 状态分布条保留，标题改为「工件状态」。
- **任务清单折叠块**：进行中与已归档 change 的详情新增「任务清单 done/total 已完成」一行，默认收起；展开后逐条显示勾选状态、文本、编号与层级缩进。文件监听/轮询刷新时清单随状态实时更新。
- **Host 契约**：`ChangeState.tasks` 新增 `items`（`id` / `text` / `done` / `depth`），单 change 最多 200 条；超出时面板提示「还有 N 项，打开 tasks.md」，不静默截断；旧 Host 未提供明细时面板给出降级提示。

### Changed

- `src/native/state.js` 新增 `limitTaskItems`（导出，供单测与面板契约使用）并在 `computeChangeState` 中携带任务明细；`docs/native-module-contract.md` 的 `ChangeState` 契约同步更新。
- `src/client-helpers.js` 新增 `workspaceProgress`（双进度口径）与 `taskChecklistView`（勾选明细视图，含超上限 / 旧 Host 降级标记）两个纯函数，并补齐单测。
- `artifactProgress` 文案保留给工件圈；阶段分布条改用新文案「工件状态」。
- **概览排版打磨**：圈内只留百分比、口径标签移到环下方（不再挤在 64px 环内），两个进度环成组呈现；「工件状态」标题与「原生技能 / 内置技能」徽标并排，去掉底部孤零零的技能行；状态条加高、卡片内边距收紧，整体更紧凑。
- **快捷动作不再弹窗**：面板与快捷条的「探索」「提案」入口不再先弹输入弹窗，点击直接把 `/opsx-explore ` / `/opsx-propose ` 填入会话输入框（不自动发送），主题与 change 名由用户在输入框补充；校验、同步预览、能力 spec 问题等只读结果弹窗保持不变。
- 插件版本 `0.3.1` → `0.4.0`。

## 0.3.1

对话开始前也显示快捷条按钮。

### Added

- **对话开始前的快捷条入口**：新会话（还没有任何消息）时，快捷条通过 `conversation.hero.options` 槽位显示在「工作区 / 模式」那一行的右端——DSH 的 `conversation.composer.dock` 只在对话开始后挂载，此前插件完全看不到入口。hero 工作区行本身只在空白会话渲染，与 composer.dock 天然互斥：对话开始后自动切换到输入框下方的条，不会同时出现两条。

### Changed

- `src/client.js` 的 QuickBar 新增 `heroOnly` 行内变体；注册面新增 `conversation.hero.options`（id 仍为 `openspec-quickbar`，与 composer.dock 共用注入）。
- **对话开始前的快捷条排版**：不再横向铺满整宽、中间留一大片空白，改为并入工作区行右端的紧凑行内簇（无容器描边、更小字号、变更名限宽、去掉重复的「提案」按钮）。
- 插件版本 `0.3.0` → `0.3.1`。

## 0.3.0

直接复用上游 OpenSpec OPSX 工作流逻辑（MIT，标注出处），sync / archive 默认由 AI 参与。

### Added

- **内置全部 12 个 OPSX 工作流 skills**：`explore / propose / apply-change / update-change / sync-specs / archive-change / new-change / continue-change / ff-change / verify-change / bulk-archive-change / onboard`。正文逐字来自 OpenSpec 1.14.3（commit `c794978`，MIT），存放在 `src/native-snapshot/skills/**`，随 `ATTRIBUTION.md` 记录来源与版本，`tools/sync-native-snapshot.mjs` 可复现刷新。
- **CLI → 文件语义适配层**（`src/native/skill-adaptation.js`）：加载 vendored SKILL.md 时重写 frontmatter（`vendoredFrom` / `upstreamVersion` / `upstreamCommit` / MIT / `adaptedFor: dsh-spec`）并在正文前注入映射说明（`openspec status/list/validate/instructions/show/archive/new change/sync/update` → 读 `openspec/` 文件或 `/opsx-*` 命令；声明无 CLI、无 store）。原生 skills 存在时 fallback 继续让位，且从不改写原生文件。
- **AI sync / archive 工作流**：`/opsx-sync`、`/opsx-archive` 默认组合「内置 OPSX 工作流正文 + 当前引擎事实（artifact/任务/delta/主 spec/校验/context/rules）+ 验证与收尾契约」并提交给模型；命令本身不写盘。
- **命令标志**：`--dry-run`（只读预览）、`--yes`（确定性合并/归档快路径，不产生模型消息）、archive 的 `--skip-specs`（AI 已完成合并时只移动目录）。
- Host `/dsh-spec` 的 `instructions` 路由新增 `sync`、`archive` 两种工作流提示词。

### Changed

- `/opsx-sync`、`/opsx-archive` 不带 `--yes` 时的默认行为从「确定性预览」改为「提交 OPSX AI 工作流」；预览改用 `--dry-run`。
- 面板/快捷条的「归档」按钮默认填入 `/opsx-archive <name> --yes`（确定性一键收尾）；手动输入不带 `--yes` 的 `/opsx-archive` 仍走 OPSX AI 归档工作流。
- 会话工作区在文件监听之外增加 4s 轮询兜底：归档（目录移动）等不一定触发文件监听的操作完成后，面板与快捷条会在几秒内刷新到新状态（归档按钮切换为下一步）。
- 归档未完成任务：确定性 `--yes` 路径对齐上游 CLI，改为**警告后继续**（校验 ERROR 仍一律拒绝）；AI 路径要求先向用户确认。
- 面板同步预览文案更新为「`--yes` 确定性写入，或直接执行让 AI 智能合并」；构建产物新增 `lib/native-snapshot/skills/**` 与 `lib/native/skill-adaptation.js`。
- 插件版本 `0.2.0` → `0.3.0`。

### Notes

- 扩展工作流（new / continue / ff / verify / bulk-archive / onboard）通过内置 skills 的**文件语义**完成，命令面仍保持九条（不新增 `/opsx-new` 等命令）。
- AI 智能合并直接编辑主 specs，提示词内嵌 canonical 验证契约（标题 / Purpose / 无 delta 头 / requirement+scenario 结构 / 四类操作结果）；确定性 `--yes` 路径始终可作为对照与回退。
- 测试改为使用提交到仓库的 `tests/fixtures/workspace/` 夹具，不再依赖宿主工作区的实时状态。

## 0.2.0

原生 OPSX 语义对齐（目标 OpenSpec 1.14.3，commit `c794978`，MIT）。插件从"硬编码四阶段 + 三件套"升级为 OpenSpec 原生内容的前端，仍然零运行时依赖、不调用 openspec CLI。

### Added

- **原生语义引擎**（`src/native/**`，Host 侧纯 JS，零子进程零网络）：YAML 子集解析、项目 `config.yaml`（`config.yml` 回退）、change `.openspec.yaml`（schema 优先级 change > project > 默认，`skip_specs` / `retire_capabilities`、未知键警告、`x-` 键静默接受）、schema 解析（项目 `openspec/schemas/<name>/` 优先，内置快照回退）、artifact 图校验（重复 ID / 悬空依赖 / 环 / apply 引用）、artifact 状态推导（`done` / `skipped` / `ready` / `blocked` + `missingDeps`，glob 输出）、change 级状态（`no-tasks` / `in-progress` / `complete` + `nextSteps` / `applyRequires` / `tracks`）、主 spec 与 delta spec 解析（ADDED / MODIFIED / REMOVED / RENAMED）、原生任务清单解析（`-`/`*`/`+`，只有 `x` 算完成，链接 bullet 忽略、编号任务 ID 保留）、确定性分级校验（ERROR / WARNING / INFO，带路径与行号）。
- **原生提示词组合**：按 `instruction` → `context` → `rules` → template → 依赖 → 解锁项的原生顺序组装 explore / propose / apply / update 提示词；仅注入当前 artifact 的 rules 与 `operations.apply.guidance`；`skipped` / blocked artifact 不生成创建指令。
- **内置快照**：`src/native-snapshot/spec-driven/`（schema + proposal/spec/design/tasks 四份模板）与 `ATTRIBUTION.md`；`tools/sync-native-snapshot.mjs` 可复现刷新，测试校验结构与版本标记。
- **确定性 sync / archive**：ADDED 追加、MODIFIED 整块替换、REMOVED 删除、RENAMED 重命名，delta 未提及内容逐字节保留；新 capability 自动写入 Purpose（缺失时写原生 TBD 占位）；`retire_capabilities` 删除最后一条 requirement 后移除主 spec；归档到本地日期 `YYYY-MM-DD-<name>`、拒绝已存在目标、保留 `.openspec.yaml`、遵守 `skip_specs`；写入前 dry-run 预览、ERROR 门禁、失败不落盘（临时文件 + rename）。
- **命令面补齐**：新增 `/opsx-update`、`/opsx-sync`、`/opsx-validate`；`/opsx-propose` 写入含生效 schema 与本地 `created` 的 `.openspec.yaml`；`/opsx-sync`、`/opsx-archive` 支持预览 + `--yes` 确认；`/opsx-status`、`/opsx-validate`、`/openspec-init` 直出不占模型 token；统一变更选择（显式名 / 单一自动选中 / 多个列候选）。
- **原生面板与快捷条**：面板展示生效 schema、artifact 状态 chips、可展开 `missingDeps`、`skip_specs` 信号、任务进度、原生下一步、按 `generates` 路径的工件文档、delta 操作统计、带行号的校验问题、项目配置/schema 来源、capability specs（Purpose/需求/场景计数、嵌套分组）、按本地日期分组的归档；列表分页/「还有 N 个」与文档截断提示取代静默截断。快捷条按原生下一步给出动作、显示 `skip_specs`/blocked 与检测到的原生 skills。
- **与原生 OpenSpec skills 共存**：检测项目 `.dsh/skills`、项目 `.agents/skills` 与用户技能根目录下的 `openspec-*` 技能；原生缺失且 DSH 提供 `ctx.skills` 时注册工作区感知 fallback provider（六个 core 工作流，文件语义、无 CLI 调用、带改编来源与版本标注），原生技能出现后自动让位，且从不改写原生技能文件。

### Changed

- `/openspec-init` 与面板初始化改为原生骨架：只创建 `openspec/config.yaml`（`schema` + 注释示例，不含占位 context）、`openspec/specs/`、`openspec/changes/archive/` 锚点；不再创建 `openspec/README.md` 与中文占位 context；已存在文件不覆盖，只报告新建项。
- 面板与命令中的 change 进展不再来自 draft / proposed / apply / ready 四阶段，而是 schema artifact 状态 + `nextSteps` + 任务进度；旧阶段徽标只保留为派生的样式映射。
- `/opsx-archive` 不再向模型提交归档提示词，改由确定性引擎执行。
- 构建流程：`node tools/build.mjs` 现在同时拷贝 `src/native/**`、`src/native-snapshot/**`，并内联 `src/client-helpers.js`；构建结束会 import 生成的 Host 模块做加载自检。
- 插件版本 `0.1.4` → `0.2.0`。

### Notes

- 原生校验与合并是"高保真子集"：个别 OpenSpec CLI 规则不在覆盖范围（见 README「已知边界」）。有意未覆盖：`--strict` 区分、proposal Capabilities 与 delta 文件的一一对应、校验期的跨文件 REMOVED/MODIFIED 目标检查（改为合并期 ERROR）、`**Reason**`/`**Migration**` 强制、场景 WHEN/THEN 结构检查、`affected_areas`/`initiative` 语义。
- YAML 解析器覆盖常见结构；anchor / merge key / 多行 flow 等会带行号报错。
- 已有 `openspec/` 内容不做迁移或删除；`openspec/config.yaml` 中超过 50KB 的 `context` 被忽略并告警。
