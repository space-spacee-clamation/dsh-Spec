/**
 * dsh-spec — OpenSpec command surface (Host half).
 *
 * Registers the twelve DSH commands that expose the native OpenSpec workflow and
 * multi-role orchestration: `/openspec-init`, `/opsx-explore`, `/opsx-propose`,
 * `/opsx-apply`, `/opsx-update`, `/opsx-sync`, `/opsx-archive`,
 * `/opsx-validate`, `/opsx-status`, `/opsx-role`, `/opsx-plan` and `/opsx-pm`.
 *
 * DSH command names cannot contain a colon, so the native `/opsx:*` core
 * commands map to kebab-case identifiers (`/opsx:propose` → `/opsx-propose`);
 * every command description records the native name for discoverability.
 *
 * Two kinds of commands exist:
 * - model phases (explore / propose / apply / update) compose a native prompt
 *   from the project's effective schema and submit it through
 *   `agent.followup()`, exactly like the shipped `/plan` command;
 * - direct commands (init / validate / status) return the deterministic
 *   engine output and never submit a model message.
 *
 * `/opsx-sync` and `/opsx-archive` have two paths (§10.5):
 * - default: compose the vendored OPSX AI workflow prompt (adapted
 *   `sync-specs` / `archive-change` skill + engine facts + finish contract),
 *   submit it through `agent.followup()` and write nothing;
 * - deterministic: `--dry-run` returns the merge/archive preview only, `--yes`
 *   runs the deterministic merge / plan+execute path. Neither submits a model
 *   message, and `--skip-specs` (archive only) moves the change without writing
 *   the main specs.
 *
 * All handlers are wrapped so a thrown error becomes a direct
 * `{ kind: 'error', text: 'OpenSpec 命令失败：…' }` result instead of a
 * command crash.
 *
 * @module dsh-spec/commands
 */

import { randomUUID } from 'node:crypto'

import {
  buildApplyPrompt,
  buildArchiveWorkflowPrompt,
  buildAutoProposePrompt,
  buildExplorePrompt,
  buildProposePrompt,
  buildSyncWorkflowPrompt,
  buildUpdatePrompt,
  firstToken,
  restAfterFirstToken,
  slugify,
} from './prompts.js'
import { withPhaseTitle } from './session-titles.js'
import { executeArchive, planArchive, previewArchive } from './native/archive.js'
import { readProjectConfig } from './native/config.js'
import { pathExists, readText, writeText } from './native/fsio.js'
import { ensureSkeleton } from './native/init.js'
import { applySyncPlan, planSync, previewSyncPlan } from './native/merge.js'
import {
  formatLocalDate,
  readChangeMetadata,
  resolveSchemaName,
  serializeChangeMetadata,
} from './native/metadata.js'
import { loadBundledSchemas, loadProjectSchemas, resolveSchema } from './native/schema.js'
import { computeChangeState, computeWorkspaceState, validateChangeByName } from './native/state.js'
import {
  ROLE_IDS,
  buildPlanPrompt,
  buildPmPrompt,
  buildRolePrompt,
  evaluateProgram,
  readPlanDraft,
  readProgram,
} from './native/orchestration.js'

/** Maximum number of validation issue lines shown in one direct result. */
const MAX_ISSUE_LINES = 40

/** Maximum number of pending task lines shown in one archive refusal. */
const MAX_TASK_LINES = 40

/** Direct text used whenever a command needs `openspec/` but the workspace has none. */
const MISSING_WORKSPACE_TEXT = '此工作区还没有 openspec/。先运行 /openspec-init，或用输入框下方快捷条的「初始化」按钮。'

/** Human labels for the native artifact statuses shown in direct command output. */
const ARTIFACT_STATUS_LABELS = {
  done: '已完成',
  skipped: '已跳过',
  ready: '可创建',
  blocked: '阻塞',
}

/**
 * Workspace-relative filesystem port used by the command handlers.
 *
 * The native engine reads files itself; commands only need the few probes and
 * writes the propose scaffold performs, plus raw main-spec reads for the merge
 * planner. It wraps `native/fsio.js` (atomic, containment-checked writes) and
 * is injectable, so unit tests never touch the real disk.
 */
const realFs = { pathExists, readText, writeText }

/**
 * Default dependency map: the real native engine, prompt builders and fs port.
 * `registerCommands(ctx, deps)` replaces it in unit tests (fake state, memory
 * fs, fake prompt builders) so no test writes a real file.
 */
const realDeps = {
  fs: realFs,
  init: { ensureSkeleton },
  metadata: { formatLocalDate, readChangeMetadata, readProjectConfig, resolveSchemaName, serializeChangeMetadata },
  schema: { loadBundledSchemas, loadProjectSchemas, resolveSchema },
  state: { computeChangeState, computeWorkspaceState, validateChangeByName },
  merge: { applySyncPlan, planSync, previewSyncPlan },
  archive: { executeArchive, planArchive, previewArchive },
  orchestration: {
    readProgram,
    evaluateProgram,
    buildRolePrompt,
    buildPlanPrompt,
    buildPmPrompt,
    readPlanDraft,
  },
  prompts: {
    buildApplyPrompt,
    buildArchiveWorkflowPrompt,
    buildAutoProposePrompt,
    buildExplorePrompt,
    buildProposePrompt,
    buildSyncWorkflowPrompt,
    buildUpdatePrompt,
    firstToken,
    restAfterFirstToken,
    slugify,
  },
}

/** Wrap one handler so unexpected failures become a direct command error. */
function safe(handler) {
  return async (invocation) => {
    try {
      return await handler(invocation)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `OpenSpec 命令失败：${message}` }
    }
  }
}

/** Resolve the session's working directory the way the shipped tools do. */
async function resolveCwd(ctx, agent) {
  const wd = ctx?.workingDirectory
  if (wd && typeof wd.ensure === 'function') {
    try {
      const value = await wd.ensure(agent)
      if (value) return value
    } catch {
      /* fall through to the read-only getter */
    }
  }
  if (wd && typeof wd.get === 'function') {
    const value = wd.get(agent)
    if (value) return value
  }
  throw new Error('无法确定当前会话的工作目录')
}

/**
 * Standalone command flags (§10.5). They are stripped from the raw input before
 * the change-name parse, so `/opsx-sync --dry-run -- add-x`-style ordering and
 * `--yes` anywhere in the string are safe.
 */
const FLAG_PATTERNS = {
  yes: /(^|\s)--yes(?=\s|$)/,
  dryRun: /(^|\s)--dry-run(?=\s|$)/,
  skipSpecs: /(^|\s)--skip-specs(?=\s|$)/,
}

/** All known flag tokens, for stripping from raw input. */
const ALL_FLAGS_PATTERN = /(^|\s)--(?:yes|dry-run|skip-specs)(?=\s|$)/g

/**
 * Parse the command flags and return the remaining input (flags removed).
 *
 * @param {unknown} rawInput raw command input
 * @returns {{yes: boolean, dryRun: boolean, skipSpecs: boolean, rest: string}}
 */
function parseCommandFlags(rawInput) {
  const raw = String(rawInput ?? '')
  return {
    yes: FLAG_PATTERNS.yes.test(raw),
    dryRun: FLAG_PATTERNS.dryRun.test(raw),
    skipSpecs: FLAG_PATTERNS.skipSpecs.test(raw),
    rest: raw.replace(ALL_FLAGS_PATTERN, '$1').trim(),
  }
}

/** Raw command input without any known flag token (for change-name parsing). */
function stripFlags(rawInput) {
  return parseCommandFlags(rawInput).rest
}

/** One ordinary user message carrying a phase prompt (same shape as the shipped `/plan`). */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Submit a composed prompt as the user's request and answer the command directly. */
function submit(agent, prompt, label) {
  if (typeof agent?.followup !== 'function') {
    throw new Error('当前会话不能接受命令提交（agent.followup 不可用）')
  }
  agent.followup(userMessage(prompt))
  return { kind: 'success', text: label }
}

/** Count validation issues from the flat native shape (`{errors,warnings,infos,issues}`); also tolerates a compact `{summary}` wrapper. */
function validationCounts(validation) {
  if (Number.isFinite(validation?.errors)) {
    return {
      errors: Number(validation.errors),
      warnings: Number(validation.warnings ?? 0),
      infos: Number(validation.infos ?? 0),
    }
  }
  if (Number.isFinite(validation?.summary?.errors)) {
    return {
      errors: Number(validation.summary.errors),
      warnings: Number(validation.summary.warnings ?? 0),
      infos: Number(validation.summary.infos ?? 0),
    }
  }
  const counts = { errors: 0, warnings: 0, infos: 0 }
  for (const issue of Array.isArray(validation?.issues) ? validation.issues : []) {
    if (issue?.level === 'ERROR') counts.errors += 1
    else if (issue?.level === 'WARNING') counts.warnings += 1
    else counts.infos += 1
  }
  return counts
}

/** Render `E ERROR / W WARNING / I INFO`. */
function countsText(counts) {
  return `${counts.errors} ERROR / ${counts.warnings} WARNING / ${counts.infos} INFO`
}

/** Render issue rows (`[LEVEL] path:line — message`) for direct output. */
function formatIssueLines(issues, limit = MAX_ISSUE_LINES) {
  const rows = []
  const list = Array.isArray(issues) ? issues : []
  for (const issue of list.slice(0, limit)) {
    const level = issue?.level ?? 'INFO'
    const where = issue?.path ? ` ${issue.path}${Number.isFinite(issue.line) ? `:${issue.line}` : ''}` : ''
    rows.push(`  [${level}]${where} — ${issue?.message ?? ''}`)
  }
  if (list.length > limit) rows.push(`  …还有 ${list.length - limit} 条问题。`)
  return rows.join('\n')
}

/** Workspace-level warnings suffix for fatal-read results. */
function warningsSuffix(state) {
  const warnings = Array.isArray(state?.warnings) ? state.warnings : []
  return warnings.length > 0 ? `：${warnings.slice(0, 3).join('；')}` : ''
}

/**
 * Warnings reported next to a preview/apply result: native validation warnings
 * (never block a write) plus non-ERROR issues from the deterministic plan.
 */
function warningsAppendix(validation, plan = null) {
  const rows = []
  const counts = validationCounts(validation)
  if (counts.warnings > 0) {
    const warnings = (Array.isArray(validation?.issues) ? validation.issues : [])
      .filter((issue) => issue?.level === 'WARNING')
    rows.push(`注意：原生校验有 ${counts.warnings} 个 WARNING（不阻断执行）。`)
    if (warnings.length > 0) rows.push(formatIssueLines(warnings, 10))
  }
  const planWarnings = (Array.isArray(plan?.issues) ? plan.issues : [])
    .filter((issue) => issue?.level !== 'ERROR')
  if (planWarnings.length > 0) {
    rows.push('计划警告：')
    rows.push(formatIssueLines(planWarnings, 10))
  }
  if (rows.length === 0) return ''
  rows.push('问题清单可用 /opsx-validate 复核。')
  return `\n${rows.join('\n')}`
}

/** Refuse sync/archive when native validation reports any ERROR. */
function validationGate(changeName, validation, action) {
  const counts = validationCounts(validation)
  if (counts.errors === 0) return null
  const errorIssues = (Array.isArray(validation?.issues) ? validation.issues : [])
    .filter((issue) => issue?.level === 'ERROR')
  const list = errorIssues.length > 0
    ? formatIssueLines(errorIssues)
    : `  问题清单见 /opsx-validate ${changeName}。`
  return {
    kind: 'error',
    text: `变更 ${changeName} 校验存在 ${counts.errors} 个 ERROR，已拒绝${action}；主 specs 与 change 目录保持原样。\n${list}\n修复后重新执行。`,
  }
}

/** Refuse a merge/archive plan the deterministic engine rejected; nothing has been written. */
function planRefusal(changeName, plan, action) {
  const issues = Array.isArray(plan?.issues) ? plan.issues : []
  const errors = issues.filter((issue) => issue?.level === 'ERROR').length
  const list = issues.length > 0
    ? formatIssueLines(issues)
    : `  问题清单见 /opsx-validate ${changeName}。`
  return {
    kind: 'error',
    text: `变更 ${changeName} 的${action}计划未通过（${errors} 个 ERROR），未写入任何文件。\n${list}`,
  }
}

/** One-line status for a change candidate. */
function candidateStatus(change) {
  const parts = []
  if (change?.schemaName) parts.push(`schema ${change.schemaName}`)
  if (change?.listStatus === 'complete') parts.push('已完成')
  else if (change?.listStatus === 'in-progress') parts.push('进行中')
  else if (change?.listStatus === 'no-tasks') parts.push('无任务清单')
  const tasks = change?.tasks
  if (tasks && Number(tasks.total) > 0) parts.push(`任务 ${tasks.done ?? 0}/${tasks.total}`)
  const errors = Number(change?.validation?.errors ?? 0)
  const warnings = Number(change?.validation?.warnings ?? 0)
  if (errors > 0) parts.push(`${errors} ERROR`)
  else if (warnings > 0) parts.push(`${warnings} WARNING`)
  return parts.length > 0 ? parts.join('；') : '状态未知'
}

/** Candidate list for ambiguous or unknown change selection. */
function formatChangeCandidates(changes) {
  return changes
    .map((change) => `  • ${change?.name ?? '(未命名)'} — ${candidateStatus(change)}`)
    .join('\n')
}

/** Error text used when an explicitly named change does not exist among active changes. */
function unknownChangeText(state, asked) {
  const changes = Array.isArray(state?.changes) ? state.changes : []
  if (changes.length === 0) {
    return `找不到变更 "${asked}"。当前没有进行中的变更；用 /opsx-propose <change-name> 创建一个。`
  }
  return `找不到变更 "${asked}"。当前进行中的变更：\n${formatChangeCandidates(changes)}\n请确认名称后重试。`
}

/**
 * Choose the change a command acts on from the workspace state and raw input.
 *
 * Rules (opsx-command-surface spec § "Change selection"):
 * - an explicit name always wins; an unknown name returns the active list;
 * - no name + exactly one active change auto-selects it (`auto === true`);
 * - no name + multiple active changes returns the candidate list with status,
 *   so the caller performs no action and no guessing.
 *
 * @param {object} state WorkspaceState (§4) with `changes: ChangeState[]`
 * @param {string} rawInput Raw command input (`--yes` tokens are ignored)
 * @param {{slugify: Function, firstToken: Function}} [prompts] Prompt helpers, injected in tests
 * @returns {{ok: true, change: object, auto: boolean}|{ok: false, text: string}}
 */
export function selectChange(state, rawInput, prompts = realDeps.prompts) {
  const changes = Array.isArray(state?.changes) ? state.changes : []
  const cleaned = stripFlags(rawInput)
  const asked = prompts.slugify(prompts.firstToken(cleaned))
  if (asked) {
    const match = changes.find((change) => change?.name === asked)
    if (match) return { ok: true, change: match, auto: false }
    return { ok: false, text: unknownChangeText(state, asked) }
  }
  if (changes.length === 0) {
    return { ok: false, text: '没有进行中的变更，先用 /opsx-propose <change-name> 创建一个。' }
  }
  if (changes.length === 1) return { ok: true, change: changes[0], auto: true }
  return {
    ok: false,
    text: `有 ${changes.length} 个进行中的变更，请指定名称后重试：\n${formatChangeCandidates(changes)}`,
  }
}

/** Direct result for commands that need an initialized `openspec/` workspace. */
function requireWorkspace(state) {
  if (!state) return { kind: 'error', text: '无法读取 OpenSpec 工作区状态（状态为空）。' }
  if (state.status === 'missing') return { kind: 'error', text: MISSING_WORKSPACE_TEXT }
  if (state.status === 'error') {
    return {
      kind: 'error',
      text: `读取 OpenSpec 工作区状态失败${warningsSuffix(state)}；请检查 openspec/ 目录与文件权限。`,
    }
  }
  return null
}

/** Resolve the effective schema definition; falls back to the bundled snapshot. */
async function resolveEffectiveSchema(deps, cwd, schemaName) {
  const project = await deps.schema.loadProjectSchemas(cwd)
  const resolved = deps.schema.resolveSchema({ name: schemaName, projectSchemas: project?.schemas ?? [] })
  if (resolved?.schema) return resolved
  const bundled = deps.schema.loadBundledSchemas()
  const fallback = bundled instanceof Map ? bundled.get('spec-driven') : bundled?.['spec-driven']
  if (fallback?.schema) {
    return { schema: fallback.schema, source: fallback.source ?? 'builtin', issues: resolved?.issues ?? [] }
  }
  return resolved ?? { schema: null, source: null, issues: [] }
}

/**
 * Shape handed to the `src/prompts.js` builders as `schema`.
 *
 * The builders receive the resolved schema object produced by
 * `schema.resolveSchema` (it carries both the schema definition and its
 * source, so a snapshot fallback can be named in the prompt metadata).
 */
function schemaForPrompts(resolved) {
  return resolved
}

/** Whether a native artifact status means the artifact file already exists. */
function isPresentArtifact(status) {
  return status === 'done' || status === 'skipped'
}

/** Artifacts named in the user's update request (matched by artifact id or output basename). */
function mentionedArtifacts(change, text) {
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  const words = new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
  return artifacts.filter((artifact) => {
    const id = String(artifact?.id ?? '').toLowerCase()
    const base = String(artifact?.outputPath ?? '').split('/').pop() ?? ''
    const baseName = base.replace(/\.md$/i, '').toLowerCase()
    return (id.length > 0 && words.has(id)) || (baseName.length > 0 && words.has(baseName))
  })
}

/** Normalize archive task progress from parsed tasks and the change-level counts. */
function normalizeTaskProgress(parsedTasks, stateTasks) {
  const total = Number(parsedTasks?.total ?? stateTasks?.total ?? 0)
  const done = Number(parsedTasks?.done ?? stateTasks?.done ?? 0)
  const items = Array.isArray(parsedTasks?.items) ? parsedTasks.items : []
  return { total, done, items }
}

/** Render the pending task list used by the archive refusal. */
function pendingTaskLines(progress) {
  const rows = []
  let hidden = 0
  for (const item of progress.items) {
    if (!item || item.done) continue
    if (rows.length >= MAX_TASK_LINES) {
      hidden += 1
      continue
    }
    const body = String(item.text ?? '')
    // tasks.js preserves the leading `N.M` token inside `text`, so only add the
    // id prefix when the text does not already carry it.
    const id = item.id && body !== item.id && !body.startsWith(`${item.id} `) ? `${item.id} ` : ''
    const indent = Number.isFinite(item.depth) ? '  '.repeat(Math.min(Number(item.depth), 3)) : ''
    rows.push(`  • ${indent}${id}${body}`.trimEnd())
  }
  if (hidden > 0) rows.push(`  …还有 ${hidden} 项未列出。`)
  return rows
}

/** Collect `[{ path, text }]` for every existing main spec, for the merge planner. */
async function readMainSpecs(deps, cwd, state) {
  const mainSpecs = []
  const specs = Array.isArray(state?.specs) ? state.specs : []
  for (const spec of specs) {
    const rel = typeof spec === 'string' ? spec : spec?.path
    if (!rel) continue
    const text = await deps.fs.readText(cwd, rel)
    mainSpecs.push({ path: rel, text })
  }
  return mainSpecs
}

/**
 * Normalize the engine's change-relative delta paths to the workspace-relative
 * paths the merge planner requires (`specs/<cap>/spec.md` →
 * `openspec/changes/<name>/specs/<cap>/spec.md`).
 */
function workspaceDeltas(changeName, deltas) {
  return (Array.isArray(deltas) ? deltas : []).map((delta) => {
    const path = String(delta?.path ?? '')
    if (!path || path.startsWith('openspec/')) return delta
    return { ...delta, path: `openspec/changes/${changeName}/${path.replace(/^\.\//, '')}` }
  })
}

/** Read the merge inputs shared by sync and archive: main spec texts + workspace-relative parsed deltas. */
async function collectMergeInput(deps, cwd, state, validated, changeName) {
  const mainSpecs = await readMainSpecs(deps, cwd, state)
  const deltas = workspaceDeltas(changeName, validated?.deltas)
  return { mainSpecs, deltas }
}

/**
 * Normalize one engine delta into a workflow fact row: the workspace-relative
 * path, the capability it targets and the parsed ADDED/MODIFIED/REMOVED/RENAMED
 * counts (docs/native-module-contract §10.4).
 *
 * @param {string} changeName change name
 * @param {{path?: string, parsed?: {operations?: object}}} delta engine delta row
 * @returns {{path: string, capability: string|null, added: number, modified: number, removed: number, renamed: number}|null}
 */
function deltaFactOf(changeName, delta) {
  const raw = String(delta?.path ?? '')
  if (raw.length === 0) return null
  const prefix = `openspec/changes/${changeName}/`
  const inner = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.replace(/^\.\//, '')
  const path = inner.startsWith('openspec/') ? inner : `${prefix}${inner}`
  const match = inner.match(/(?:^|\/)specs\/([^/]+)\/spec\.md$/)
  const operations = delta?.parsed?.operations ?? {}
  const count = (operation) => (Array.isArray(operations?.[operation]) ? operations[operation].length : 0)
  return {
    path,
    capability: match ? match[1] : null,
    added: count('ADDED'),
    modified: count('MODIFIED'),
    removed: count('REMOVED'),
    renamed: count('RENAMED'),
  }
}

/**
 * Main spec facts for the capabilities touched by the deltas: the deterministic
 * main spec path, whether it exists yet (a new capability starts absent) and its
 * current requirement count when the workspace state already knows it.
 *
 * @param {Array<{capability: string|null}>} deltaFacts
 * @param {object|null} state WorkspaceState (§4)
 * @returns {Array<{path: string, capability: string, exists: boolean, requirementCount: number}>}
 */
function mainSpecFactsOf(deltaFacts, state) {
  const known = new Map()
  for (const spec of Array.isArray(state?.specs) ? state.specs : []) {
    const path = typeof spec === 'string' ? spec : spec?.path
    if (typeof path !== 'string' || path.length === 0) continue
    known.set(path, {
      path,
      exists: true,
      requirementCount: Number.isFinite(Number(spec?.requirementCount)) ? Number(spec.requirementCount) : 0,
    })
  }
  const rows = []
  const seen = new Set()
  for (const delta of deltaFacts) {
    if (delta.capability === null) continue
    const path = `openspec/specs/${delta.capability}/spec.md`
    if (seen.has(path)) continue
    seen.add(path)
    const existing = known.get(path)
    rows.push({
      path,
      capability: delta.capability,
      exists: existing !== undefined,
      requirementCount: existing === undefined ? 0 : existing.requirementCount,
    })
  }
  return rows
}

/**
 * Task progress facts: total/done plus the pending task texts the workflow must
 * ask the user about (`null` when the change has no tasks file yet).
 *
 * @param {object|null} validated result of `validateChangeByName`
 * @returns {{total: number, done: number, pending: string[]}|null}
 */
function workflowTaskFacts(validated) {
  const parsed = validated?.tasks
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') return null
  const items = Array.isArray(parsed.items) ? parsed.items : []
  return {
    total: Number.isFinite(Number(parsed.total)) ? Number(parsed.total) : 0,
    done: Number.isFinite(Number(parsed.done)) ? Number(parsed.done) : 0,
    pending: items
      .filter((item) => item && item.done !== true)
      .map((item) => String(item.text ?? ''))
      .filter((text) => text.length > 0),
  }
}

/**
 * Build the engine-derived facts injected into the AI sync/archive workflow
 * prompts (docs/native-module-contract §10.4).
 *
 * Pure: it only reads the engine state handed in, so both the commands and the
 * read-only host `instructions` route can reuse it. The caller supplies the
 * archive target (`openspec/changes/archive/<local-date>-<name>`) and whether it
 * already exists; everything else derives from the change, workspace state and
 * `validateChangeByName` result.
 *
 * @param {object} [options]
 * @param {object} [options.change] ChangeState from the native engine
 * @param {object} [options.state] WorkspaceState from the native engine
 * @param {object} [options.validated] `validateChangeByName` result (validation, deltas, tasks)
 * @param {string|null} [options.archiveTarget] deterministic archive target path
 * @param {boolean|null} [options.archiveTargetExists] whether the archive target already exists
 * @returns {{validation: object, artifacts: Array<{id: string, status: string}>, tasks: object|null, deltas: Array<object>, mainSpecs: Array<object>, isPlanningComplete: boolean, archiveTarget: string|null, archiveTargetExists: boolean|null}}
 */
export function collectWorkflowFacts({
  change = null,
  state = null,
  validated = null,
  archiveTarget = null,
  archiveTargetExists = null,
} = {}) {
  const changeName = typeof validated?.name === 'string'
    ? validated.name
    : typeof change?.name === 'string' ? change.name : ''
  const deltaFacts = (Array.isArray(validated?.deltas) ? validated.deltas : [])
    .map((delta) => deltaFactOf(changeName, delta))
    .filter((delta) => delta !== null)
  const validation = validated?.validation ?? change?.validation ?? { errors: 0, warnings: 0, infos: 0, issues: [] }
  return {
    validation,
    artifacts: (Array.isArray(change?.artifacts) ? change.artifacts : [])
      .filter((artifact) => artifact && typeof artifact.id === 'string')
      .map((artifact) => ({ id: artifact.id, status: typeof artifact.status === 'string' ? artifact.status : 'unknown' })),
    tasks: workflowTaskFacts(validated),
    deltas: deltaFacts,
    mainSpecs: mainSpecFactsOf(deltaFacts, state),
    isPlanningComplete: change?.isPlanningComplete === true,
    archiveTarget: typeof archiveTarget === 'string' && archiveTarget.length > 0 ? archiveTarget : null,
    archiveTargetExists: typeof archiveTargetExists === 'boolean' ? archiveTargetExists : null,
  }
}

/** Compose + submit the OPSX sync AI workflow; the command itself writes nothing. */
async function submitSyncWorkflow(deps, invocation, { cwd, autoNote, change, state, validated }) {
  const schemaName = change?.schemaName || state?.config?.schema || 'spec-driven'
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) {
    return { kind: 'error', text: `无法解析变更 ${change.name} 的 schema "${schemaName}"，无法组合 sync 工作流提示词。` }
  }
  const prompt = await deps.prompts.buildSyncWorkflowPrompt({
    cwd,
    changeName: change.name,
    schema: schemaForPrompts(resolvedSchema),
    config: state?.config ?? {},
    change,
    facts: collectWorkflowFacts({ change, state, validated }),
  })
  const counts = validationCounts(validated?.validation ?? change.validation)
  const warningNote = counts.warnings > 0 ? `（校验有 ${counts.warnings} 个 WARNING，AI 会一并评估）` : ''
  const blockingNote = counts.errors > 0
    ? `\n校验有 ${counts.errors} 个 ERROR：AI 会先停止并报告问题与修复建议，不会合并主 specs。`
    : ''
  return submit(
    invocation.agent,
    prompt,
    `${autoNote}已发送 OPSX 同步工作流：${change.name}。命令本身没有写入任何文件。AI 会先评估 delta 与主 specs 并向你确认，再按 OPSX 智能合并、按 canonical 契约验证，最后运行 /opsx-validate${warningNote}。${blockingNote}`,
  )
}

/** Compose + submit the OPSX archive AI workflow; the command itself writes/moves nothing. */
async function submitArchiveWorkflow(deps, invocation, { cwd, autoNote, change, state, validated, archiveRel, targetExists, skipSpecsRequested = false }) {
  const schemaName = change?.schemaName || state?.config?.schema || 'spec-driven'
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) {
    return { kind: 'error', text: `无法解析变更 ${change.name} 的 schema "${schemaName}"，无法组合 archive 工作流提示词。` }
  }
  const prompt = await deps.prompts.buildArchiveWorkflowPrompt({
    cwd,
    changeName: change.name,
    schema: schemaForPrompts(resolvedSchema),
    config: state?.config ?? {},
    change,
    facts: collectWorkflowFacts({
      change,
      state,
      validated,
      archiveTarget: archiveRel,
      archiveTargetExists: targetExists,
    }),
  })
  const counts = validationCounts(validated?.validation ?? change.validation)
  const tasks = workflowTaskFacts(validated)
  const notes = []
  if (counts.errors > 0) {
    notes.push(`校验有 ${counts.errors} 个 ERROR：AI 会先停止并报告问题与修复建议，不会合并主 specs、不会移动目录。`)
  }
  if (targetExists === true) {
    notes.push(`归档目标 ${archiveRel} 已存在：AI 会先停止并报告冲突，不会合并主 specs、不会移动目录或覆盖已归档内容。`)
  }
  if (tasks !== null && tasks.total > tasks.done) {
    notes.push(`变更还有 ${tasks.total - tasks.done} 项任务未完成（${tasks.done}/${tasks.total}），AI 会先与你确认。`)
  }
  if (counts.warnings > 0) notes.push(`校验有 ${counts.warnings} 个 WARNING，AI 会先与你确认。`)
  if (skipSpecsRequested) notes.push('--skip-specs 只影响确定性收尾（只移动目录）；AI 工作流仍会先向你确认是否同步主 specs。')
  if (notes.length > 0) notes.push('')
  return submit(
    invocation.agent,
    prompt,
    `${autoNote}已发送 OPSX 归档工作流：${change.name}（归档目标 ${archiveRel}）。命令本身没有写入或移动任何文件。AI 会先检查 artifact / 任务完成度并征得确认，再智能合并或跳过同步，验证后用 /opsx-archive ${change.name} --yes --skip-specs 确定性收尾。${notes.length > 0 ? `\n${notes.join('\n')}` : ''}`,
  )
}

/** Warning for the deterministic archive path when tasks are still pending (upstream CLI parity: continue). */
function incompleteTasksNote(changeName, progress) {
  const pending = pendingTaskLines(progress)
  const list = pending.length > 0 ? `\n未完成任务：\n${pending.join('\n')}` : ''
  return `警告：变更 ${changeName} 还有 ${progress.total - progress.done} 项任务未完成（${progress.done}/${progress.total}）；按上游 openspec CLI 行为继续归档（校验 ERROR 仍会拒绝）。${list}`
}

/** Compose the direct status text from the native workspace state. */
function formatStatus(state) {
  const changes = Array.isArray(state.changes) ? state.changes : []
  const specs = Array.isArray(state.specs) ? state.specs : []
  const archivedCount = Number.isFinite(state.archivedCount)
    ? state.archivedCount
    : Array.isArray(state.archived) ? state.archived.length : 0
  const config = state.config ?? {}
  const lines = ['OpenSpec 工作区状态']
  if (config.found) {
    lines.push(`项目配置：openspec/${config.file ?? 'config.yaml'}（schema：${config.schema ?? 'spec-driven'}）`)
  } else {
    lines.push(`项目配置：未找到，使用默认 schema：${config.schema ?? 'spec-driven'}`)
  }
  if (changes.length === 0) {
    lines.push('进行中的变更：无（用 /opsx-propose <change-name> 开始一个）')
  } else {
    lines.push(`进行中的变更：${changes.length} 个`)
    for (const change of changes) lines.push(...formatChangeStatus(change))
  }
  lines.push(`已归档：${archivedCount} 个变更`)
  lines.push(`主 specs：${specs.length} 个 capability`)
  const warnings = Array.isArray(state.warnings) ? state.warnings : []
  if (warnings.length > 0) lines.push(`工作区警告：${warnings.length} 条`)
  return lines.join('\n')
}

/** Per-change block for `/opsx-status`: schema, task progress, artifacts, next step. */
function formatChangeStatus(change) {
  const lines = []
  const meta = []
  if (change?.schemaName) {
    meta.push(`schema ${change.schemaName}${change.schemaSource === 'builtin' ? '（内置快照）' : ''}`)
  }
  if (change?.metadata?.skip_specs) meta.push('skip_specs')
  const tasks = change?.tasks
  if (tasks && Number(tasks.total) > 0) meta.push(`任务 ${tasks.done ?? 0}/${tasks.total}`)
  else meta.push(change?.listStatus === 'complete' ? '任务已完成' : '无任务清单')
  const counts = validationCounts(change?.validation)
  if (counts.errors > 0) meta.push(`${counts.errors} ERROR`)
  if (counts.warnings > 0) meta.push(`${counts.warnings} WARNING`)
  lines.push(`  • ${change?.name ?? '(未命名)'} — ${meta.join('；')}`)
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  if (artifacts.length > 0) {
    const chips = artifacts.map((artifact) => {
      const label = ARTIFACT_STATUS_LABELS[artifact?.status] ?? artifact?.status ?? '未知'
      return `${artifact?.id ?? artifact?.outputPath ?? '?'} ${label}`
    })
    lines.push(`    artifacts：${chips.join('，')}`)
  }
  const nextSteps = Array.isArray(change?.nextSteps) ? change.nextSteps : []
  if (nextSteps.length > 0) lines.push(`    下一步：${nextSteps.join('；')}`)
  return lines
}

/** `/openspec-init`: idempotent native skeleton, direct output only. */
async function runInit(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const skeleton = await deps.init.ensureSkeleton(cwd)
  const created = Array.isArray(skeleton?.created) ? skeleton.created : []
  if (created.length === 0) {
    return { kind: 'success', text: 'OpenSpec 已初始化过，没有需要补建的文件。用 /opsx-status 查看当前状态。' }
  }
  return {
    kind: 'success',
    text: `OpenSpec 骨架已就绪（新建：${created.join('、')}）。\n下一步：/opsx-explore 想清楚，或 /opsx-propose <change-name> 直接写计划；/opsx-status 与面板会自动显示原生状态。`,
  }
}

/** `/opsx-explore`: submit the read-only exploration prompt. */
async function runExplore(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const topic = String(invocation.rawInput ?? '').trim()
  const config = await deps.metadata.readProjectConfig(cwd)
  const prompt = await deps.prompts.buildExplorePrompt({ cwd, config, topic })
  const label = `已向会话发送 OpenSpec 探索任务${topic ? `（主题：${topic}）` : ''}。这是只读调查与讨论，不会改动任何文件。`
  const result = submit(invocation.agent, prompt, label)
  return withPhaseTitle(ctx, invocation.agent, 'explore', topic, result)
}

/**
 * `/opsx-propose --auto <描述>`: let the model summarize the description and
 * choose the change name, then create the native change and planning artifacts
 * itself. The Host only prepares the skeleton and submits the prompt, so the
 * name is the model's decision rather than a local slug heuristic.
 */
async function runProposeAuto(ctx, deps, invocation, description) {
  const intent = String(description ?? '').trim()
  if (intent === '') {
    return {
      kind: 'error',
      text: '用法：/opsx-propose --auto <描述>——AI 会先总结描述、自动选择 kebab-case change 名，再创建变更与规划工件。',
    }
  }
  const cwd = await resolveCwd(ctx, invocation.agent)
  const skeleton = await deps.init.ensureSkeleton(cwd)
  const initCreated = Array.isArray(skeleton?.created) ? skeleton.created : []
  const config = await deps.metadata.readProjectConfig(cwd)
  const schemaName = deps.metadata.resolveSchemaName({ changeMetadata: null, projectConfig: config, fallback: 'spec-driven' })
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) {
    return {
      kind: 'error',
      text: `无法解析生效 schema "${schemaName}"：openspec/schemas/ 与内置快照中都没有该定义。请检查 openspec/config.yaml 的 schema，或提供 openspec/schemas/${schemaName}/schema.yaml。`,
    }
  }
  let existingNames = []
  try {
    const workspace = await deps.state.computeWorkspaceState(cwd)
    existingNames = (Array.isArray(workspace?.changes) ? workspace.changes : [])
      .map((change) => change?.name)
      .filter((name) => typeof name === 'string' && name !== '')
  } catch {
    existingNames = []
  }
  const createdDate = deps.metadata.formatLocalDate()
  const prompt = await deps.prompts.buildAutoProposePrompt({
    cwd,
    description: intent,
    schema: schemaForPrompts(resolvedSchema),
    config,
    created: createdDate,
    existingNames,
  })
  const initNote = initCreated.length > 0 ? `已先初始化 openspec/ 骨架（新建：${initCreated.join('、')}）。\n` : ''
  const label = [
    `${initNote}已发送自动命名提案任务。`,
    `AI 会先总结描述并选择 kebab-case change 名，再创建 openspec/changes/<name>/（schema：${schemaName}，created：${createdDate}）与规划工件；写完计划后停止等待评审。`,
  ].join('\n')
  const subject = intent.length > 30 ? `${intent.slice(0, 29)}…` : intent
  const result = submit(invocation.agent, prompt, label)
  // The `自动命名：` prefix keeps the generic title watcher from treating the
  // description as an explicit change name; the client's new-change watcher
  // binds the actual AI-chosen name when the directory appears.
  return withPhaseTitle(ctx, invocation.agent, 'propose', `自动命名：${subject}`, result)
}

/**
 * Direct text for a schema that neither the project nor the bundled snapshot defines.
 *
 * @param {string} schemaName effective schema name
 * @returns {{kind: 'error', text: string}} command result
 */
function unresolvableSchemaText(schemaName) {
  return {
    kind: 'error',
    text: `无法解析生效 schema "${schemaName}"：openspec/schemas/ 与内置快照中都没有该定义。请检查 openspec/config.yaml 的 schema，或提供 openspec/schemas/${schemaName}/schema.yaml。`,
  }
}

/**
 * Native artifact status summary used by the `/opsx-propose` resume result.
 *
 * @param {object|null} change ChangeState
 * @returns {string[]} one line listing existing and pending artifacts
 */
function resumeArtifactLines(change) {
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  if (artifacts.length === 0) return []
  const present = artifacts.filter((artifact) => isPresentArtifact(artifact?.status)).map((artifact) => artifact.id)
  const pending = artifacts
    .filter((artifact) => !isPresentArtifact(artifact?.status))
    .map((artifact) => `${artifact.id}（${ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status ?? '未知'}）`)
  return [
    `已有工件：${present.length > 0 ? present.join('、') : '无'}；待补齐：${pending.length > 0 ? pending.join('、') : '无'}。`,
  ]
}

/**
 * Direct result for `/opsx-propose` on a change whose planning is complete.
 *
 * The plan already exists, so this branch never submits a model message: it
 * reports the artifact state plus validation findings and points at the next
 * phase (update / apply / archive).
 *
 * @param {object|null} change ChangeState
 * @returns {{kind: 'success', text: string}} command result
 */
function completeProposeResult(change) {
  const name = typeof change?.name === 'string' && change.name.length > 0 ? change.name : '<change-name>'
  const schemaName = typeof change?.schemaName === 'string' && change.schemaName.length > 0 ? change.schemaName : 'spec-driven'
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  const counts = validationCounts(change?.validation)
  const lines = [`变更 ${name} 的规划工件已全部完成（schema：${schemaName}）。`]
  if (artifacts.length > 0) {
    const rows = artifacts
      .map((artifact) => `${artifact.id}（${ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status ?? '未知'}）`)
      .join('、')
    lines.push(`工件：${rows}。`)
  }
  if (counts.errors > 0) {
    lines.push(`原生校验有 ${counts.errors} 个 ERROR，建议先用 /opsx-update ${name} 修复后再实施；问题清单见 /opsx-validate ${name}。`)
  } else if (counts.warnings > 0) {
    lines.push(`原生校验有 ${counts.warnings} 个 WARNING（不阻断实施）；问题清单见 /opsx-validate ${name}。`)
  }
  const next = change?.listStatus === 'complete' ? `/opsx-archive ${name}` : `/opsx-apply ${name}`
  lines.push(`下一步：${next}；要修订规划本身请用 /opsx-update ${name}。`)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Resume branch for `/opsx-propose` when `openspec/changes/<name>/` already exists.
 *
 * The native state is the source of truth: a complete plan returns direct
 * guidance, an incomplete plan submits the resume prompt, and the existing
 * `.openspec.yaml` is never rewritten. A directory without metadata (an
 * interrupted or hand-made scaffold) gets the metadata completed once.
 */
async function resumePropose(ctx, deps, invocation, { cwd, changeName, changeDir, metadataPath, intent, config }) {
  const metadata = await deps.metadata.readChangeMetadata(cwd, changeDir)
  if (metadata?.found === true && metadata?.error) {
    const line = Number.isFinite(metadata.error.line) ? `（第 ${metadata.error.line} 行）` : ''
    return {
      kind: 'error',
      text: `变更 ${changeName} 的元数据 ${metadataPath} 无法解析${line}：${metadata.error.message}。已停止，未覆盖任何文件；请修复该文件后重试。`,
    }
  }
  if (metadata?.found !== true) {
    // Keep the scaffold coherent: write the missing native metadata once.
    const schemaName = deps.metadata.resolveSchemaName({ changeMetadata: null, projectConfig: config, fallback: 'spec-driven' })
    const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
    if (!resolvedSchema?.schema) return unresolvableSchemaText(schemaName)
    const createdDate = deps.metadata.formatLocalDate()
    await deps.fs.writeText(cwd, metadataPath, deps.metadata.serializeChangeMetadata({ schema: schemaName, created: createdDate }))
  }

  const change = await deps.state.computeChangeState(cwd, changeName, { projectConfig: config })
  const schemaName =
    typeof change?.schemaName === 'string' && change.schemaName.length > 0
      ? change.schemaName
      : deps.metadata.resolveSchemaName({ changeMetadata: change?.metadata ?? null, projectConfig: config, fallback: 'spec-driven' })
  if (change?.isPlanningComplete === true) return completeProposeResult(change)
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) return unresolvableSchemaText(schemaName)

  const prompt = await deps.prompts.buildProposePrompt({
    cwd,
    changeName,
    intent,
    schema: schemaForPrompts(resolvedSchema),
    config,
    change,
    resume: true,
  })
  const label = [
    `变更 ${changeDir}/ 已存在，规划未完成：继续该 change 的规划（不重写 ${metadataPath}）。`,
    ...resumeArtifactLines(change),
    '已发送提案续做任务：AI 只创建缺失/可规划的工件，已有工件只读；写完计划后停止等待评审，不会写产品代码。',
  ].join('\n')
  const result = submit(invocation.agent, prompt, label)
  return withPhaseTitle(ctx, invocation.agent, 'propose', changeName, result)
}


/**
 * `/opsx-propose`: validate/normalize the change name, initialize a missing
 * workspace, then decide from the native state:
 * - new name: write the native `.openspec.yaml` (effective schema + local
 *   `created`) and submit the plan-only prompt;
 * - existing change with an incomplete plan: keep the metadata, read the
 *   artifact state and submit the resume prompt (missing artifacts only);
 * - existing change with a complete plan: return next-step guidance directly
 *   without submitting a model message.
 */
async function runPropose(ctx, deps, invocation) {
  const rawInput = String(invocation.rawInput ?? '')
  const auto = /(^|\s)--auto(?=\s|$)/.test(rawInput)
  if (auto) {
    const description = rawInput.replace(/(^|\s)--auto(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
    return runProposeAuto(ctx, deps, invocation, description)
  }
  const raw = stripFlags(rawInput)
  const changeName = deps.prompts.slugify(deps.prompts.firstToken(raw))
  if (!changeName) {
    return {
      kind: 'error',
      text: '用法：/opsx-propose <change-name> [说明]，或 /opsx-propose --auto <描述>。前者显式指定 kebab-case 名称；后者让 AI 先总结描述再自动命名并创建变更。示例：/opsx-propose add-dark-mode 支持深色主题。',
    }
  }
  const intent = deps.prompts.restAfterFirstToken(raw)
  const cwd = await resolveCwd(ctx, invocation.agent)

  // Idempotent native initialization first: creates only missing anchors/config.
  const skeleton = await deps.init.ensureSkeleton(cwd)
  const created = Array.isArray(skeleton?.created) ? skeleton.created : []

  const changeDir = `openspec/changes/${changeName}`
  const metadataPath = `${changeDir}/.openspec.yaml`
  const config = await deps.metadata.readProjectConfig(cwd)
  if (await deps.fs.pathExists(cwd, changeDir)) {
    return resumePropose(ctx, deps, invocation, { cwd, changeName, changeDir, metadataPath, intent, config })
  }

  const schemaName = deps.metadata.resolveSchemaName({ changeMetadata: null, projectConfig: config, fallback: 'spec-driven' })
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) return unresolvableSchemaText(schemaName)

  const createdDate = deps.metadata.formatLocalDate()
  const metadataText = deps.metadata.serializeChangeMetadata({ schema: schemaName, created: createdDate })
  // Native scaffolding is written before the model prompt is submitted.
  await deps.fs.writeText(cwd, metadataPath, metadataText)

  const change = await deps.state.computeChangeState(cwd, changeName, { projectConfig: config })
  const prompt = await deps.prompts.buildProposePrompt({
    cwd,
    changeName,
    intent,
    schema: schemaForPrompts(resolvedSchema),
    config,
    change,
    resume: false,
  })
  const initNote = created.length > 0 ? `已先初始化 openspec/ 骨架（新建：${created.join('、')}）。\n` : ''
  const label = [
    `${initNote}已创建 ${metadataPath}（schema：${schemaName}，created：${createdDate}）。`,
    '已发送提案任务：AI 将按原生 schema 产出规划工件（proposal / specs / design / tasks 中适用的部分），写完计划后停止等待评审，不会写产品代码。',
  ].join('\n')
  const result = submit(invocation.agent, prompt, label)
  return withPhaseTitle(ctx, invocation.agent, 'propose', changeName, result)
}

/** `/opsx-apply`: submit the native apply prompt; validation is not a gate here. */
async function runApply(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  const unavailable = requireWorkspace(state)
  if (unavailable) return unavailable

  const picked = selectChange(state, invocation.rawInput, deps.prompts)
  if (!picked.ok) return { kind: 'error', text: picked.text }
  const change = picked.change
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  const hasPlanning = artifacts.some((artifact) => isPresentArtifact(artifact?.status))
  const hasTasks = Boolean(change?.tasks && Number(change.tasks.total) > 0)
  if (!hasPlanning && !hasTasks) {
    return {
      kind: 'error',
      text: `变更 ${change?.name} 还没有任何规划工件（proposal / specs / tasks）。请先用 /opsx-propose ${change?.name} 创建计划，或用 /opsx-update 补全后再 apply。`,
    }
  }

  const schemaName = change?.schemaName || state?.config?.schema || 'spec-driven'
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) {
    return { kind: 'error', text: `无法解析变更 ${change?.name} 的 schema "${schemaName}"，无法组合 apply 提示词。` }
  }
  const prompt = await deps.prompts.buildApplyPrompt({
    cwd,
    changeName: change.name,
    schema: schemaForPrompts(resolvedSchema),
    config: state.config,
    change,
    // The phase builder owns the apply instruction; commands add no extra artifact prompt.
    artifactPrompt: '',
  })

  const lines = []
  if (picked.auto) lines.push(`已自动选择唯一进行中的变更 ${change.name}。`)
  const progress = change?.tasks ? `${change.tasks.done ?? 0}/${change.tasks.total}` : '无任务清单'
  lines.push(`已发送实施任务：${change.name}（任务 ${progress}）。AI 会从第一个未勾选任务开始逐项实现，并随进度勾选 tasks.md；随时可用 /opsx-status 查看进度。`)
  if (change?.listStatus === 'complete') lines.push('注意：tasks.md 已全部勾选，AI 会做最终核对与收尾。')
  const errors = Number(change?.validation?.errors ?? 0)
  if (errors > 0) {
    lines.push(`注意：该变更校验存在 ${errors} 个 ERROR，apply 不阻断实现，但建议先 /opsx-validate ${change.name} 修正计划问题。`)
  }
  const result = submit(invocation.agent, prompt, lines.join('\n'))
  return withPhaseTitle(ctx, invocation.agent, 'apply', change.name, result)
}

/** `/opsx-update`: revise existing planning artifacts only; never product code. */
async function runUpdate(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  const unavailable = requireWorkspace(state)
  if (unavailable) return unavailable

  const picked = selectChange(state, invocation.rawInput, deps.prompts)
  if (!picked.ok) return { kind: 'error', text: picked.text }
  const change = picked.change
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  const hasPlanning = artifacts.some((artifact) => isPresentArtifact(artifact?.status))
  if (!hasPlanning) {
    return {
      kind: 'error',
      text: `变更 ${change?.name} 还没有任何规划工件，/opsx-update 没有可修订的内容。请先用 /opsx-propose ${change?.name} 创建计划。`,
    }
  }

  const intent = picked.auto
    ? String(invocation.rawInput ?? '').trim()
    : deps.prompts.restAfterFirstToken(stripFlags(invocation.rawInput))

  // update only revises existing artifacts: a target that does not exist yet
  // belongs to propose (or its create step), never to update.
  const requested = mentionedArtifacts(change, intent)
  const missing = requested.filter((artifact) => !isPresentArtifact(artifact?.status))
  if (missing.length > 0) {
    const described = missing
      .map((artifact) => `${artifact.id}（${artifact.outputPath ?? artifact.id}，当前状态：${ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status ?? '未知'}）`)
      .join('、')
    return {
      kind: 'error',
      text: `变更 ${change.name} 的规划工件 ${described} 尚不存在。该工件应由 /opsx-propose ${change.name}（或 propose 阶段的创建步骤）生成；/opsx-update 只修订已有规划工件，不会凭空创建。`,
    }
  }

  const schemaName = change?.schemaName || state?.config?.schema || 'spec-driven'
  const resolvedSchema = await resolveEffectiveSchema(deps, cwd, schemaName)
  if (!resolvedSchema?.schema) {
    return { kind: 'error', text: `无法解析变更 ${change?.name} 的 schema "${schemaName}"，无法组合 update 提示词。` }
  }
  const prompt = await deps.prompts.buildUpdatePrompt({
    cwd,
    changeName: change.name,
    schema: schemaForPrompts(resolvedSchema),
    config: state.config,
    change,
    // Optional extra property accepted by the prompt builder: renders the
    // concrete revision request as a labelled block inside the phase prompt.
    intent,
  })

  const lines = []
  if (picked.auto) lines.push(`已自动选择唯一进行中的变更 ${change.name}。`)
  lines.push(`已发送修订任务：${change.name}。AI 只修改已有规划工件并保持它们之间一致，不会改产品代码；需要代码实现请用 /opsx-apply ${change.name}。`)
  const result = submit(invocation.agent, prompt, lines.join('\n'))
  return withPhaseTitle(ctx, invocation.agent, 'update', change.name, result)
}

/**
 * `/opsx-sync`: default OPSX AI workflow → validation gate → `--dry-run`
 * preview → `--yes` deterministic merge.
 *
 * The default path composes the vendored OPSX sync prompt and submits it before
 * the validation gate, so a command sent from the DSH hero page (where direct
 * command results have no transcript to render in) always produces a visible
 * model turn; the prompt facts still carry every issue, and the finish
 * contract's STOP gate makes the model stop and report them. It never plans or
 * writes. `--dry-run` returns the deterministic preview only, `--yes` applies
 * the deterministic merge; the gate still refuses both direct paths before any
 * work and neither produces a model message.
 */
async function runSync(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const flags = parseCommandFlags(invocation.rawInput)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  const unavailable = requireWorkspace(state)
  if (unavailable) return unavailable

  const picked = selectChange(state, invocation.rawInput, deps.prompts)
  if (!picked.ok) return { kind: 'error', text: picked.text }
  const change = picked.change
  const autoNote = picked.auto ? `已自动选择唯一进行中的变更 ${change.name}。\n` : ''

  const validated = await deps.state.validateChangeByName(cwd, change.name)
  const validation = validated?.validation ?? change.validation

  // Default: submit the OPSX AI workflow before the validation gate; no plan,
  // no writes, no move. The facts (and the result text) still carry every
  // issue, so the prompt's STOP gate reports a blocking state instead of the
  // command returning a direct result the hero page cannot render. A change
  // that declares skip_specs has nothing to sync, so it keeps its direct
  // result (and therefore keeps the gate below).
  if (!flags.yes && !flags.dryRun && change?.metadata?.skip_specs !== true) {
    const result = await submitSyncWorkflow(deps, invocation, { cwd, autoNote, change, state, validated })
    return withPhaseTitle(ctx, invocation.agent, 'sync', change.name, result)
  }

  const gate = validationGate(change.name, validation, '同步')
  if (gate) return gate

  if (change?.metadata?.skip_specs) {
    return {
      kind: 'success',
      text: `${autoNote}变更 ${change.name} 声明了 skip_specs：没有 delta specs 可同步，无需执行 sync。用 /opsx-archive ${change.name} 直接归档。`,
    }
  }

  const { mainSpecs, deltas } = await collectMergeInput(deps, cwd, state, validated, change.name)
  const plan = deps.merge.planSync({
    changeName: change.name,
    mainSpecs,
    deltas,
    retireCapabilities: false,
  })
  if (plan?.ok === false) return planRefusal(change.name, plan, '同步')

  const preview = deps.merge.previewSyncPlan(plan)
  if (flags.dryRun) {
    return {
      kind: 'success',
      text: `${autoNote}同步预览：变更 ${change.name}\n${preview?.text ?? '（没有需要同步的内容）'}\n\n未写入任何文件（--dry-run）。确认无误后：/opsx-sync ${change.name} --yes 确定性写入，或不带参数让 AI 按 OPSX 智能合并。${warningsAppendix(validation, plan)}`,
    }
  }

  const applied = await deps.merge.applySyncPlan({ cwd, plan })
  const written = Array.isArray(applied?.written) ? applied.written : []
  const body = written.length > 0
    ? `已写入 ${written.length} 个主 spec 文件：\n${written.map((path) => `  • ${path}`).join('\n')}`
    : '没有需要写入的主 spec（delta 为空或无需变更）。'
  const result = {
    kind: 'success',
    text: `${autoNote}已同步变更 ${change.name} 的主 specs。\n${body}${warningsAppendix(validation, plan)}`,
  }
  return withPhaseTitle(ctx, invocation.agent, 'synced', change.name, result)
}

/**
 * `/opsx-archive`: default OPSX AI workflow → validation gate + archive target
 * check → `--dry-run` preview → `--yes` deterministic plan+execute.
 *
 * The default path composes the vendored OPSX archive prompt and submits it
 * before either gate, so a command sent from the DSH hero page (where direct
 * command results have no transcript to render in) always produces a visible
 * model turn; the prompt facts and result text still carry every validation
 * issue and the archive-target state, and the finish contract's STOP gates make
 * the model stop and report them. It never plans, writes or moves. Incomplete
 * tasks no longer block: the AI path asks the user to confirm, and the
 * deterministic `--yes` path warns and continues (upstream CLI parity). The
 * deterministic `--dry-run` / `--yes` paths still refuse on validation ERROR
 * and on an existing archive target before any work. `--skip-specs` makes the
 * deterministic path move the change without writing any main spec.
 */
async function runArchive(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const flags = parseCommandFlags(invocation.rawInput)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  const unavailable = requireWorkspace(state)
  if (unavailable) return unavailable

  const picked = selectChange(state, invocation.rawInput, deps.prompts)
  if (!picked.ok) return { kind: 'error', text: picked.text }
  const change = picked.change
  const autoNote = picked.auto ? `已自动选择唯一进行中的变更 ${change.name}。\n` : ''

  const validated = await deps.state.validateChangeByName(cwd, change.name)
  const validation = validated?.validation ?? change.validation
  const localDate = deps.metadata.formatLocalDate()
  const archiveRel = `openspec/changes/archive/${localDate}-${change.name}`
  const targetExists = await deps.fs.pathExists(cwd, archiveRel)

  const progress = normalizeTaskProgress(validated?.tasks, change.tasks)
  const incomplete = progress.total > 0 && progress.done < progress.total

  // Default: submit the OPSX AI workflow before the deterministic gates; no
  // plan, no writes, no move. The facts (and the result text) still carry the
  // validation issues and the archive-target state, so the prompt's STOP gates
  // report a blocking state instead of the command returning a direct result
  // the hero page cannot render.
  if (!flags.yes && !flags.dryRun) {
    const result = await submitArchiveWorkflow(deps, invocation, {
      cwd,
      autoNote,
      change,
      state,
      validated,
      archiveRel,
      targetExists,
      skipSpecsRequested: flags.skipSpecs,
    })
    return withPhaseTitle(ctx, invocation.agent, 'archive', change.name, result)
  }

  const gate = validationGate(change.name, validation, '归档')
  if (gate) return gate

  if (targetExists) {
    return {
      kind: 'error',
      text: `归档目标 ${archiveRel} 已存在，已拒绝归档；不会覆盖已归档内容。`,
    }
  }

  const skippedByFlag = flags.skipSpecs
  const skipSpecs = skippedByFlag || change?.metadata?.skip_specs === true
  const { mainSpecs, deltas } = skipSpecs
    ? { mainSpecs: [], deltas: [] }
    : await collectMergeInput(deps, cwd, state, validated, change.name)
  // skip_specs archives without touching main specs; otherwise the merge plan
  // travels inside the archive plan and executeArchive applies it before moving.
  const syncPlan = skipSpecs
    ? null
    : deps.merge.planSync({
      changeName: change.name,
      mainSpecs,
      deltas,
      retireCapabilities: Boolean(change?.metadata?.retire_capabilities),
    })
  if (syncPlan?.ok === false) return planRefusal(change.name, syncPlan, '归档')

  const metadata = skipSpecs ? { ...(change?.metadata ?? {}), skip_specs: true } : change?.metadata ?? {}
  const plan = deps.archive.planArchive({
    changeName: change.name,
    localDate,
    metadata,
    validation,
    syncPlan,
    targetExists,
  })
  if (plan?.ok === false) return planRefusal(change.name, plan, '归档')

  const preview = deps.archive.previewArchive(plan)
  const taskWarning = incomplete ? incompleteTasksNote(change.name, progress) : ''
  if (flags.dryRun) {
    const warningBlock = taskWarning.length > 0 ? `\n\n${taskWarning}` : ''
    const skipNote = skippedByFlag ? '（--skip-specs：只移动目录）' : ''
    return {
      kind: 'success',
      text: `${autoNote}归档预览：变更 ${change.name}${skipNote}\n${preview?.text ?? `归档目标：${archiveRel}`}\n\n未写入或移动任何文件（--dry-run）。${warningBlock}确认无误后：/opsx-archive ${change.name} --yes${skipNote ? ' --skip-specs' : ''} 确定性归档，或不带参数让 AI 按 OPSX 归档工作流处理。${warningsAppendix(validation, plan)}`,
    }
  }

  const executed = await deps.archive.executeArchive({ cwd, plan })
  const target = executed?.target ?? plan?.archiveRel ?? archiveRel
  const writes = Array.isArray(syncPlan?.writes) ? syncPlan.writes : []
  const writtenLines = writes.map((write) => `  • ${write.path}（${write.action}）`)
  let body = ''
  if (skippedByFlag) body = '--skip-specs：未写入主 specs，只移动 change 目录。\n'
  else if (skipSpecs) body = 'skip_specs：未写入主 specs。\n'
  else if (writtenLines.length > 0) body = `已同步主 specs：\n${writtenLines.join('\n')}\n`
  const warningBlock = taskWarning.length > 0 ? `\n${taskWarning}` : ''
  const result = {
    kind: 'success',
    text: `${autoNote}已归档变更 ${change.name} → ${target}\n${body}归档内容保留 .openspec.yaml 与全部工件。${warningBlock}${warningsAppendix(validation, plan)}`,
  }
  return withPhaseTitle(ctx, invocation.agent, 'archived', change.name, result)
}

/** `/opsx-validate`: direct native validation output (no model message). */
async function runValidate(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  if (!state || state.status === 'missing') {
    return { kind: 'success', text: '此工作区还没有 openspec/，没有可校验的内容。先运行 /openspec-init。' }
  }
  if (state.status === 'error') return requireWorkspace(state)

  const asked = deps.prompts.slugify(deps.prompts.firstToken(stripFlags(invocation.rawInput)))
  if (asked) {
    const match = (Array.isArray(state.changes) ? state.changes : []).find((change) => change?.name === asked)
    if (!match) return { kind: 'error', text: unknownChangeText(state, asked) }
    const validated = await deps.state.validateChangeByName(cwd, match.name)
    const validation = validated?.validation ?? match.validation
    return validationResult(match.name, validation)
  }

  // Workspace-wide validation: every active change plus the main specs.
  const changes = Array.isArray(state.changes) ? state.changes : []
  const specs = Array.isArray(state.specs) ? state.specs : []
  const totals = { errors: 0, warnings: 0, infos: 0 }
  const lines = ['OpenSpec 校验（工作区）']
  if (changes.length === 0) {
    lines.push('进行中的变更：无')
  } else {
    lines.push(`进行中的变更：${changes.length} 个`)
    for (const change of changes) {
      let validation = change.validation
      try {
        const validated = await deps.state.validateChangeByName(cwd, change.name)
        validation = validated?.validation ?? validation
      } catch {
        lines.push(`  • ${change.name}：读取失败（详见 /opsx-validate ${change.name}）`)
        continue
      }
      const counts = validationCounts(validation)
      totals.errors += counts.errors
      totals.warnings += counts.warnings
      totals.infos += counts.infos
      lines.push(`  • ${change.name}：${countsText(counts)}`)
      const issues = Array.isArray(validation?.issues) ? validation.issues : []
      if (issues.length > 0) lines.push(...formatIssueLines(issues, 20).split('\n').map((row) => `  ${row}`))
    }
  }
  if (specs.length > 0) {
    let specErrors = 0
    let specWarnings = 0
    for (const spec of specs) {
      specErrors += Number(spec?.validation?.errors ?? 0)
      specWarnings += Number(spec?.validation?.warnings ?? 0)
    }
    totals.errors += specErrors
    totals.warnings += specWarnings
    lines.push(`主 specs：${specs.length} 个 capability（${specErrors} ERROR / ${specWarnings} WARNING）`)
  }
  lines.push(`统计：${countsText(totals)}`)
  if (changes.length === 0 && specs.length === 0) lines.push('没有可校验的内容（还没有变更或主 specs）。')
  return { kind: totals.errors > 0 ? 'error' : 'success', text: lines.join('\n') }
}

/** Direct result for `/opsx-validate <name>`. */
function validationResult(name, validation) {
  const counts = validationCounts(validation)
  const lines = [`变更 ${name} 校验：${countsText(counts)}`]
  const issues = Array.isArray(validation?.issues) ? validation.issues : []
  if (issues.length === 0) lines.push('  无问题。')
  else lines.push(formatIssueLines(issues))
  return { kind: counts.errors > 0 ? 'error' : 'success', text: lines.join('\n') }
}

/**
 * `/opsx-role <program> <task> <role> [--force]`: submit one role's context pack.
 *
 * The Host checks the same dependency gate the panel shows, so a role cannot be
 * started ahead of the artifacts it depends on by typing the command manually.
 */
async function runRole(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const force = tokens.includes('--force')
  const [programId, taskId, role] = tokens.filter((token) => token !== '--force')
  if (programId === undefined || taskId === undefined || role === undefined) {
    return { kind: 'error', text: '用法：/opsx-role <program> <task> <product|design|dev|test> [--force]' }
  }
  if (!ROLE_IDS.includes(role)) {
    return { kind: 'error', text: `未知角色：${role}（可选：${ROLE_IDS.join(' / ')}）` }
  }
  const program = await deps.orchestration.readProgram(cwd, programId)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  const evaluated = await deps.orchestration.evaluateProgram(cwd, program, state)
  const task = evaluated.tasks.find((entry) => entry.id === taskId)
  if (task === undefined) return { kind: 'error', text: `找不到子任务：${taskId}` }
  const gate = task.roles?.[role]
  if (gate === undefined) return { kind: 'error', text: `子任务 ${taskId} 未启用角色：${role}` }
  if (gate.ready !== true && !force) {
    return {
      kind: 'error',
      text: `「${task.title}」的${role}角色尚未就绪：${(gate.missing ?? []).join('；') || '依赖未完成'}。确认要强制执行时加 --force。`,
    }
  }
  const prompt = await deps.orchestration.buildRolePrompt(cwd, evaluated, task, role, state)
  const label = `已向「${task.title}」的 ${role} 角色发送任务。上下文仅包含依赖工件与 handoff，不共享其他角色的对话。`
  const result = submit(invocation.agent, prompt, label)
  return withPhaseTitle(ctx, invocation.agent, role, task.title, result)
}

/**
 * `/opsx-plan <draft-id>`: ask the planner model to split the saved goal into
 * child tasks. The planner writes only `.plans/<id>.json`; the Host creates
 * change skeletons after the client confirms the plan.
 */
async function runPlan(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const draftId = deps.prompts.slugify(deps.prompts.firstToken(invocation.rawInput))
  if (!draftId) return { kind: 'error', text: '用法：/opsx-plan <draft-id>' }
  const draft = await deps.orchestration.readPlanDraft(cwd, draftId)
  const prompt = await deps.orchestration.buildPlanPrompt(cwd, draft)
  const label = `已向规划会话发送任务拆分请求；AI 只会写 openspec/orchestration/.plans/${draftId}.json，不会创建 change 或写业务代码。`
  const result = submit(invocation.agent, prompt, label)
  return withPhaseTitle(ctx, invocation.agent, 'plan', draft.goal, result)
}

/**
 * `/opsx-pm <program>`: PM oversight turn. The deterministic client scheduler is
 * the hands; the PM reviews the status matrix and writes `pm/status.md`.
 */
async function runPm(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const programId = deps.prompts.slugify(deps.prompts.firstToken(invocation.rawInput))
  if (!programId) return { kind: 'error', text: '用法：/opsx-pm <program>' }
  const program = await deps.orchestration.readProgram(cwd, programId)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  const evaluated = await deps.orchestration.evaluateProgram(cwd, program, state)
  const prompt = await deps.orchestration.buildPmPrompt(cwd, evaluated)
  const label = `已向 PM 会话发送「${program.title}」的巡检请求；PM 只写 pm/status.md，不写代码、不代替用户验收。`
  const result = submit(invocation.agent, prompt, label)
  return withPhaseTitle(ctx, invocation.agent, 'pm', program.title, result)
}

/** `/opsx-status`: direct workspace status output (no model message). */
async function runStatus(ctx, deps, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await deps.state.computeWorkspaceState(cwd, { signal: invocation.signal })
  if (!state || state.status === 'missing') {
    return { kind: 'success', text: `此工作区还没有 openspec/。运行 /openspec-init，或用输入框下方快捷条的「初始化」按钮。` }
  }
  if (state.status === 'error') return requireWorkspace(state)
  return { kind: 'success', text: formatStatus(state) }
}

/** Record the native `/opsx:*` → DSH kebab-case mapping in a command description (DSH names cannot contain a colon). */
function description(nativeName, dshName, tail) {
  return `OpenSpec 原生 /opsx:${nativeName} 的 DSH 形式 /${dshName}（DSH 命令名不能含冒号，改用 kebab-case）——${tail}`
}

/** Register the twelve OpenSpec commands on `ctx.commands`. */
function registerAll(ctx, deps, commands) {
  const register = (name, text, hint, run) => {
    const spec = { name, description: text, handler: safe((invocation) => run(ctx, deps, invocation)) }
    if (hint) spec.input = { hint }
    commands.register(spec)
  }

  register(
    'openspec-init',
    'OpenSpec：初始化 openspec/ 原生骨架（对应原生 openspec init；幂等，只补建缺失的 config 与锚点，不覆盖已有文件）',
    '',
    runInit,
  )
  register(
    'opsx-explore',
    description('explore', 'opsx-explore', '只调查与讨论，不写任何文件'),
    '[主题]',
    runExplore,
  )
  register(
    'opsx-propose',
    description(
      'propose',
      'opsx-propose',
      '创建原生 change 骨架（.openspec.yaml）并产出规划工件，只写计划不写代码；--auto <描述> 让 AI 先总结描述、自动选择 change 名再创建',
    ),
    '<change-name> [说明] | --auto <描述>',
    runPropose,
  )
  register(
    'opsx-apply',
    description('apply', 'opsx-apply', '按 tasks.md 逐项实现并勾选任务'),
    '[change-name]',
    runApply,
  )
  register(
    'opsx-update',
    description('update', 'opsx-update', '只修订已有规划工件并保持一致性，不改产品代码'),
    '[change-name] [修订要求]',
    runUpdate,
  )
  register(
    'opsx-sync',
    description(
      'sync',
      'opsx-sync',
      '默认提交 OPSX sync-specs AI 工作流（评估 delta、确认后智能合并主 specs、按契约验证）；--yes 走确定性合并，--dry-run 只输出预览',
    ),
    '[change-name] [--yes|--dry-run]',
    runSync,
  )
  register(
    'opsx-archive',
    description(
      'archive',
      'opsx-archive',
      '默认提交 OPSX archive-change AI 工作流（完成度检查、同步确认、验证后确定性收尾）；--yes 确定性归档，--dry-run 只预览，--skip-specs 只移动目录不写主 specs',
    ),
    '[change-name] [--yes|--dry-run|--skip-specs]',
    runArchive,
  )
  register(
    'opsx-validate',
    description('validate', 'opsx-validate', '直接输出原生校验的 ERROR/WARNING 清单与统计，不进入模型'),
    '[change-name]',
    runValidate,
  )
  register(
    'opsx-status',
    description('status', 'opsx-status', '直接输出进行中的变更、artifact 状态、任务进度与归档数量，不进入模型'),
    '',
    runStatus,
  )
  register(
    'opsx-role',
    'OpenSpec 多角色协作：向指定 program/task/role 发送只含依赖工件的上下文包，不共享其他角色的对话',
    '<program> <task> <product|design|dev|test> [--force]',
    runRole,
  )
  register(
    'opsx-plan',
    'OpenSpec 多角色协作：让规划模型把最终目标拆成子任务，只写规划文件，不创建 change / 不写业务代码',
    '<draft-id>',
    runPlan,
  )
  register(
    'opsx-pm',
    'OpenSpec 多角色协作：PM 巡检项目进度与阻塞，写 pm/status.md；自动推进由面板调度器执行',
    '<program>',
    runPm,
  )
}

/**
 * Register the twelve OpenSpec commands on `ctx.commands`.
 *
 * @param {object} ctx Cordis host context (needs `commands` and `workingDirectory`)
 * @param {object} [dependencies] Injectable dependency map used by unit tests;
 *   defaults to the real native engine + prompt builders + fs port
 * @returns {void}
 */
export function registerCommands(ctx, dependencies = realDeps) {
  const commands = ctx?.commands
  if (!commands || typeof commands.register !== 'function') {
    throw new Error('commands 服务不可用：无法注册 OpenSpec 命令')
  }
  registerAll(ctx, dependencies, commands)
}
