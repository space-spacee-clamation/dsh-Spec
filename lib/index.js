/**
 * dsh-spec — Host half.
 *
 * DSH front end for native OpenSpec content. The plugin owns no workflow state
 * of its own: every answer is derived from the workspace files by the pure-JS
 * engine in `./native/**`, and the browser half reads it through the read-only
 * `/dsh-spec` route below. Writes stay in commands (`src/commands.js`), so they
 * run inside a session and can be confirmed before touching disk.
 *
 * Contributions:
 * - twelve `/opsx-*` / `/openspec-init` commands (`registerCommands`);
 * - the `/dsh-spec` route used by the panel and the quick bar:
 *   `state`, `validate`, `instructions`, `sync-preview`, `document`,
 *   `archive-detail`, `task-toggle`, `orchestration-create`,
 *   `orchestration-accept`, `orchestration-roles`, `init`, plus the two
 *   read-only human-report actions `report-prompt` and `report-status`;
 * - a workspace-aware fallback skill provider for the six core workflows when
 *   the DSH composition exposes `ctx.skills` and no native OpenSpec skill is
 *   present in the workspace.
 *
 * @module dsh-spec
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerCommands } from './commands.js'
import { readProjectConfig } from './native/config.js'
import { isInside, joinRel, listTree, pathExists, readTextOrNull, toAbs, writeText } from './native/fsio.js'
import { ensureSkeleton } from './native/init.js'
import { planSync, previewSyncPlan } from './native/merge.js'
import { formatLocalDate, readChangeMetadata, resolveSchemaName } from './native/metadata.js'
import {
  acceptTask,
  buildPmPrompt,
  createProgram,
  evaluateProgram,
  readPlan,
  readProgram,
  readPrograms,
  updateProgramAuto,
  updateProgramRoles,
  writePlanDraft,
} from './native/orchestration.js'
import { loadProjectSchemas, resolveSchema } from './native/schema.js'
import { createFallbackProvider, detectNativeSkills } from './native/skills.js'
import { parseDeltaSpec, parseMainSpec } from './native/spec.js'
import { computeChangeState, computeWorkspaceState, validateChangeByName } from './native/state.js'
import { toggleTaskLine } from './native/tasks.js'
import {
  buildApplyPrompt,
  buildArchiveWorkflowPrompt,
  buildExplorePrompt,
  buildProposePrompt,
  buildReportPrompt,
  buildSyncWorkflowPrompt,
  buildUpdatePrompt,
} from './prompts.js'

/** Cordis plugin name; also the service key provided to other plugins. */
export const name = 'openSpec'

/** Commands register the slash family, workingDirectory resolves the session root, webServer + connection + workspaceRegistry serve the panel's read-only route. `skills` is optional and discovered through `ctx.get`. */
export const inject = ['commands', 'workingDirectory', 'webServer', 'connection', 'workspaceRegistry']

/** Absolute route the browser half calls for panel state, docs and direct actions. */
export const ROUTE = '/dsh-spec'

/** Largest request body accepted on the route, in bytes. */
const MAX_REQUEST_BYTES = 64_000

/** Default page size for `document` reads (the reader can ask for a later page). */
const DOCUMENT_PAGE_LINES = 400

/** Workspace-relative prefix every report action must stay under. */
const ARCHIVE_PREFIX = 'openspec/changes/archive/'

/** Default report root (workspace-relative) for human reports. */
const REPORT_ROOT_DEFAULT = '人类文档'

/** Report file names per output mode. */
const REPORT_FILE = 'index.html'
const ARCHIVE_REPORT_FILE = 'report.html'
const REPORT_POINTER_FILE = 'report.json'

/** Hard limit on one period report (keeps one prompt / one report bounded). */
const MAX_RANGE_CHANGES = 30

/** Strict calendar date shape used by period filtering. */
const REPORT_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Optional project mainline card consumed by report prompts (read-only). */
const MAINLINE_CARD_REL = 'openspec/report-context.md'
const MAINLINE_CARD_LIMIT = 50_000

/** Report template asset shipped beside the Host source (`lib/` mirrors it). */
const REPORT_TEMPLATE_PATH = fileURLToPath(new URL('./report/report-template.html', import.meta.url))
const REPORT_TEMPLATE_VERSION = 'report-template/v1'

/** Sort issues deterministically: path, then line, then level, then message. */
function sortIssues(issues) {
  return [...issues].sort((left, right) => {
    const pathOrder = String(left.path ?? '').localeCompare(String(right.path ?? ''))
    if (pathOrder !== 0) return pathOrder
    if ((left.line ?? 0) !== (right.line ?? 0)) return (left.line ?? 0) - (right.line ?? 0)
    if (left.level !== right.level) return left.level.localeCompare(right.level)
    return String(left.message).localeCompare(String(right.message))
  })
}

/** Count severity levels for one issue list. */
function summarizeIssues(issues) {
  const sorted = sortIssues(issues)
  let errors = 0
  let warnings = 0
  let infos = 0
  for (const issue of sorted) {
    if (issue.level === 'ERROR') errors += 1
    else if (issue.level === 'WARNING') warnings += 1
    else infos += 1
  }
  return { errors, warnings, infos, issues: sorted }
}

/** Accept only an absolute registry workspace path; reject everything else. */
async function resolveWorkspacePath(ctx, requested) {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  if (raw.length === 0 || raw.length > 1000 || !isAbsolute(raw)) {
    throw new Error('cwd 必须是工作区的绝对路径')
  }
  const workspace = await ctx.workspaceRegistry.resolveByPath(raw)
  if (workspace === undefined) throw new Error('该路径不是已注册的工作区：拒绝在工作区之外读写')
  return workspace.path
}

/** Read a change-side delta spec file list and parsed operations. */
async function readDeltas(cwd, changeName) {
  const root = `openspec/changes/${changeName}/specs`
  const files = await listTree(cwd, root)
  const deltas = []
  for (const entry of files) {
    if (entry.type !== 'file') continue
    if (!entry.rel.endsWith('.md')) continue
    const text = await readTextOrNull(cwd, entry.rel)
    if (text === null) continue
    deltas.push({ path: entry.rel, text, parsed: parseDeltaSpec(text) })
  }
  return deltas
}

/** Capability path from a delta spec path (`.../specs/<capability>/spec.md`). */
function capabilityOf(changeName, deltaPath) {
  const prefix = `openspec/changes/${changeName}/specs/`
  const rel = deltaPath.startsWith(prefix) ? deltaPath.slice(prefix.length) : deltaPath
  return rel.endsWith('/spec.md') ? rel.slice(0, -'/spec.md'.length) : rel.replace(/\.md$/, '')
}

/** Normalize the report scope; anything but `change` / `range` is rejected. */
function reportScopeOf(payload) {
  const scope = typeof payload.scope === 'string' ? payload.scope.trim() : ''
  if (scope === '' || scope === 'change') return 'change'
  if (scope === 'range') return 'range'
  throw new Error(`未知的报告范围：${scope}（可选 change / range）`)
}

/** Resolve a strict `YYYY-MM-DD` calendar date (rejecting e.g. `2026-02-30`). */
function reportDateOf(raw, label) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!REPORT_DATE.test(text)) throw new Error(`${label}必须是 YYYY-MM-DD 格式的日期`)
  const parsed = new Date(`${text}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label}不是真实存在的日期：${text}`)
  }
  return text
}

/**
 * Resolve the report root: default `人类文档`, workspace-relative, never escaping
 * the workspace (the DSH file policy cannot verify writes outside it).
 *
 * @param {string} cwd absolute workspace root
 * @param {unknown} raw requested root (relative or absolute)
 * @returns {{ rel: string, abs: string }}
 */
function resolveReportRoot(cwd, raw) {
  const requested = typeof raw === 'string' ? raw.trim().replaceAll('\\', '/') : ''
  const text = requested === '' ? REPORT_ROOT_DEFAULT : requested
  if (text.split('/').includes('..')) throw new Error('报告根目录无效：不允许包含 .. 段')
  if (isAbsolute(text)) {
    const abs = resolve(text)
    if (!isInside(cwd, abs)) {
      throw new Error('报告根目录必须位于工作区内：DSH 文件策略无法写入或校验工作区外的路径')
    }
    return { rel: relative(cwd, abs).replaceAll('\\', '/'), abs }
  }
  let rel = ''
  try {
    rel = joinRel(text)
  } catch {
    throw new Error(`报告根目录无效：${text}`)
  }
  const abs = toAbs(cwd, rel)
  if (!isInside(cwd, abs)) throw new Error('报告根目录必须位于工作区内')
  return { rel, abs }
}

/**
 * Resolve `path` / `name` to one archived change directory, mirroring
 * `archive-detail`: only `openspec/changes/archive/**` is accepted and active
 * changes or workspace escapes are rejected.
 *
 * @param {string} cwd absolute workspace root
 * @param {{path?: unknown, name?: unknown}} payload route payload
 * @returns {{ rel: string, dir: string, changeName: string }}
 */
function resolveArchivedChange(cwd, payload) {
  const rawPath = typeof payload.path === 'string' ? payload.path.replaceAll('\\', '/') : ''
  const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
  let rel = ''
  if (rawPath.length > 0) {
    rel = rawPath.replace(/^\/+/, '')
    if (!rel.startsWith('openspec/')) rel = `${ARCHIVE_PREFIX}${rel.replace(/^archive\//, '')}`
  } else if (rawName.length > 0) {
    rel = `${ARCHIVE_PREFIX}${rawName.replace(/^archive\//, '')}`
  } else {
    throw new Error('缺少归档路径或名称')
  }
  rel = rel.replace(/\/+$/, '')
  if (rel.includes('..') || !rel.startsWith(ARCHIVE_PREFIX)) {
    throw new Error('归档路径无效：只支持 openspec/changes/archive/ 下的已归档变更')
  }
  const dir = rel.slice(ARCHIVE_PREFIX.length)
  if (dir.length === 0 || dir.endsWith('/')) throw new Error('归档路径无效：缺少归档目录名')
  if (!isInside(cwd, toAbs(cwd, rel))) throw new Error('归档路径不在工作区内')
  const base = dir.split('/').pop()
  const dated = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(base)
  const changeName = dated === null || dated[1].length === 0 ? base : dated[1]
  return { rel, dir, changeName }
}

/** Read the delta specs of one archived change (same parser as active changes). */
async function readArchivedDeltas(cwd, archiveRel) {
  const files = await listTree(cwd, `${archiveRel}/specs`)
  const deltas = []
  for (const entry of files) {
    if (entry.type !== 'file' || !entry.rel.endsWith('.md')) continue
    const text = await readTextOrNull(cwd, entry.rel)
    if (text === null) continue
    deltas.push({ path: entry.rel, parsed: parseDeltaSpec(text) })
  }
  return deltas
}

/** Delta operation count from one parsed delta block. */
function deltaOperationCount(parsed, operation) {
  const list = parsed?.operations?.[operation]
  return Array.isArray(list) ? list.length : 0
}

/** Assemble the single-change facts block handed to `buildReportPrompt`. */
async function reportChangeFacts(cwd, archived, change) {
  const deltas = await readArchivedDeltas(cwd, archived.rel)
  const deltaFiles = []
  const mainSpecPaths = new Set()
  for (const delta of deltas) {
    const capability = capabilityOf(`archive/${archived.dir}`, delta.path)
    deltaFiles.push({
      path: delta.path,
      capability,
      added: deltaOperationCount(delta.parsed, 'ADDED'),
      modified: deltaOperationCount(delta.parsed, 'MODIFIED'),
      removed: deltaOperationCount(delta.parsed, 'REMOVED'),
      renamed: deltaOperationCount(delta.parsed, 'RENAMED'),
    })
    mainSpecPaths.add(`openspec/specs/${capability}/spec.md`)
  }
  const items = Array.isArray(change?.tasks?.items) ? change.tasks.items : []
  const validation = change?.validation ?? {}
  return {
    schemaName: typeof change?.schemaName === 'string' ? change.schemaName : null,
    metadata: change?.metadata ?? null,
    artifacts: Array.isArray(change?.artifacts)
      ? change.artifacts.map((artifact) => ({ id: artifact.id, status: artifact.status }))
      : [],
    tasks:
      change?.tasks === null || change?.tasks === undefined
        ? null
        : {
            total: change.tasks.total,
            done: change.tasks.done,
            pending: items.filter((item) => item.done !== true).map((item) => item.text),
          },
    deltaFiles,
    mainSpecPaths: [...mainSpecPaths],
    validation: {
      errors: validation.errors ?? 0,
      warnings: validation.warnings ?? 0,
      infos: validation.infos ?? 0,
    },
  }
}

/** Read the optional mainline card (bounded) and label its source. */
async function readMainlineCard(cwd) {
  const text = await readTextOrNull(cwd, MAINLINE_CARD_REL)
  if (text === null) return { text: '', source: 'inferred' }
  const trimmed = text.trim()
  if (trimmed.length === 0) return { text: '', source: 'inferred' }
  const capped =
    Buffer.byteLength(trimmed, 'utf8') > MAINLINE_CARD_LIMIT
      ? Buffer.from(trimmed, 'utf8').subarray(0, MAINLINE_CARD_LIMIT).toString('utf8')
      : trimmed
  return { text: capped, source: 'card' }
}

/** Read one `report.json` pointer; malformed JSON is ignored (`null`). */
async function readReportPointer(cwd, rel) {
  const text = await readTextOrNull(cwd, rel)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Resolve a pointer `report` value to an absolute path plus workspace containment. */
function resolvePointerTarget(cwd, raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return null
  const normalized = text.replaceAll('\\', '/')
  try {
    const absolute = isAbsolute(normalized) ? resolve(normalized) : toAbs(cwd, normalized)
    const inside = isInside(cwd, absolute)
    return {
      inside,
      absolute,
      rel: inside ? relative(cwd, absolute).replaceAll('\\', '/') : null,
      path: normalized,
    }
  } catch {
    return null
  }
}

/**
 * Validate one period range against the archived change list: strict dates,
 * `from <= to`, inclusive archived-date filtering, 1–30 included changes.
 *
 * @param {string} cwd absolute workspace root
 * @param {{from?: unknown, to?: unknown}} payload route payload
 * @returns {Promise<{from: string, to: string, included: Array<{name: string, changePath: string, date: string}>}>}
 */
async function resolveReportRange(cwd, payload) {
  const from = reportDateOf(payload.from, '起始日期')
  const to = reportDateOf(payload.to, '结束日期')
  if (from > to) throw new Error('起始日期不能晚于结束日期')
  const state = await computeWorkspaceState(cwd)
  const matched = state.archived.filter(
    (entry) => entry.date !== null && from <= entry.date && entry.date <= to,
  )
  if (matched.length === 0) {
    throw new Error(`时间段 ${from} ~ ${to} 内没有已归档的变更，不生成报告提示词`)
  }
  if (matched.length > MAX_RANGE_CHANGES) {
    throw new Error(
      `时间段 ${from} ~ ${to} 内命中 ${matched.length} 个已归档变更，超过上限 ${MAX_RANGE_CHANGES}，请缩小时间范围`,
    )
  }
  matched.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
  return {
    from,
    to,
    included: matched.map((entry) => ({ name: entry.changeName, changePath: entry.path, date: entry.date })),
  }
}

/** Resolve the effective schema for an optional change, and return config + project schemas too. */
async function schemaContext(cwd, changeName) {
  const config = await readProjectConfig(cwd)
  const { schemas } = await loadProjectSchemas(cwd)
  let metadata = null
  if (typeof changeName === 'string' && changeName.length > 0) {
    const found = await readChangeMetadata(cwd, `openspec/changes/${changeName}`)
    metadata = found.metadata
  }
  const schemaName = resolveSchemaName({ changeMetadata: metadata, projectConfig: config })
  const resolved = resolveSchema({ name: schemaName, projectSchemas: schemas })
  return { config, projectSchemas: schemas, metadata, schemaName, resolved }
}

/** Select one change by explicit name, or the only active change. */
function pickChange(state, name) {
  const asked = typeof name === 'string' ? name.trim() : ''
  if (asked.length > 0) {
    const found = state.changes.find((change) => change.name === asked)
    if (found === undefined) {
      const known = state.changes.map((change) => change.name).join('、') || '（无）'
      throw new Error(`找不到变更 "${asked}"。进行中的变更：${known}`)
    }
    return found
  }
  if (state.changes.length === 1) return state.changes[0]
  if (state.changes.length === 0) throw new Error('没有进行中的变更')
  const known = state.changes.map((change) => change.name).join('、')
  throw new Error(`有 ${state.changes.length} 个进行中的变更（${known}），请指定 change 名`)
}

/** `state`: full native workspace snapshot. */
async function methodState(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const state = await computeWorkspaceState(cwd)
  const orchestration = await readPrograms(cwd, state)
  state.orchestration = orchestration.programs
  if (orchestration.warnings.length > 0) {
    state.warnings = [...(Array.isArray(state.warnings) ? state.warnings : []), ...orchestration.warnings]
  }
  return state
}

/** `orchestration-draft`: persist the goal + role models while AI splits tasks. */
async function methodOrchestrationDraft(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const draft = await writePlanDraft(cwd, payload.draft ?? payload)
  return { ok: true, id: draft.id }
}

/** `orchestration-plan`: read the planner's split file (null while absent). */
async function methodOrchestrationPlan(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') throw new Error('缺少规划 id')
  try {
    return { ok: true, plan: await readPlan(cwd, id) }
  } catch (error) {
    // A model may still be writing the file; the client polls and can surface
    // the validation error without treating a transient read as fatal.
    return {
      ok: true,
      plan: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** `orchestration-create`: create a program manifest and one native change per task. */
async function methodOrchestrationCreate(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const program = await createProgram(cwd, payload.program ?? payload)
  return { ok: true, id: program.id }
}

/** `orchestration-accept`: record the user's final acceptance for one task. */
async function methodOrchestrationAccept(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const program = typeof payload.program === 'string' ? payload.program.trim() : ''
  const task = typeof payload.task === 'string' ? payload.task.trim() : ''
  if (program === '' || task === '') throw new Error('缺少 program 或 task')
  if (payload.accepted === true) {
    const definition = await readProgram(cwd, program)
    const evaluated = await evaluateProgram(cwd, definition, await computeWorkspaceState(cwd))
    const target = evaluated.tasks.find((entry) => entry.id === task)
    if (target === undefined) throw new Error(`找不到子任务：${task}`)
    if (target.roles?.test?.done !== true) {
      throw new Error('测试尚未完成（需要设计、开发任务与 qa/report.md），不能进行最终验收')
    }
  }
  await acceptTask(cwd, program, task, payload.accepted === true)
  return { ok: true }
}

/** `orchestration-auto`: pause or resume the PM auto-driver. */
async function methodOrchestrationAuto(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const program = typeof payload.program === 'string' ? payload.program.trim() : ''
  if (program === '') throw new Error('缺少 program')
  await updateProgramAuto(cwd, program, payload.auto === true)
  return { ok: true }
}

/** `orchestration-roles`: update role provider/model assignments. */
async function methodOrchestrationRoles(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const program = typeof payload.program === 'string' ? payload.program.trim() : ''
  if (program === '') throw new Error('缺少 program')
  const roles = payload.roles !== null && typeof payload.roles === 'object' ? payload.roles : {}
  await updateProgramRoles(cwd, program, roles)
  return { ok: true }
}

/** `validate`: one change, or a workspace-wide summary when no change is given. */
async function methodValidate(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const change = typeof payload.change === 'string' ? payload.change.trim() : ''
  if (change.length > 0) {
    const result = await validateChangeByName(cwd, change)
    return { name: result.name, validation: result.validation, metadata: result.metadata, schemaName: result.schemaName }
  }
  const state = await computeWorkspaceState(cwd)
  const issues = []
  for (const item of state.changes) {
    for (const issue of item.validation.issues) {
      issues.push({ ...issue, change: item.name, path: issue.path ? `openspec/changes/${item.name}/${issue.path}` : undefined })
    }
  }
  return { workspace: true, status: state.status, validation: summarizeIssues(issues), warnings: state.warnings }
}

/** Assemble the workflow facts injected into the OPSX sync/archive prompts. */
async function workflowFacts(cwd, changeName, change, projectConfig) {
  const validated = await validateChangeByName(cwd, changeName)
  const deltas = await readDeltas(cwd, changeName)
  const deltaFacts = []
  const mainSpecPaths = new Map()
  for (const delta of deltas) {
    const capability = capabilityOf(changeName, delta.path)
    const operations = delta.parsed.operations
    deltaFacts.push({
      path: delta.path,
      capability,
      added: operations.ADDED.length,
      modified: operations.MODIFIED.length,
      removed: operations.REMOVED.length,
      renamed: operations.RENAMED.length,
    })
    mainSpecPaths.set(capability, `openspec/specs/${capability}/spec.md`)
  }
  const mainSpecs = []
  for (const [capability, path] of mainSpecPaths) {
    const text = await readTextOrNull(cwd, path)
    mainSpecs.push({
      path,
      capability,
      exists: text !== null,
      requirementCount: text === null ? 0 : parseMainSpec(text).requirements.length,
    })
  }
  const items = Array.isArray(validated.tasks?.items) ? validated.tasks.items : []
  const archiveTarget = `openspec/changes/archive/${formatLocalDate()}-${changeName}`
  return {
    validation: validated.validation,
    artifacts: Array.isArray(change?.artifacts)
      ? change.artifacts.map((artifact) => ({ id: artifact.id, status: artifact.status }))
      : [],
    tasks: validated.tasks === null || validated.tasks === undefined
      ? null
      : {
          total: validated.tasks.total,
          done: validated.tasks.done,
          pending: items.filter((item) => item.done !== true).map((item) => item.text),
        },
    deltas: deltaFacts,
    mainSpecs,
    isPlanningComplete: change?.isPlanningComplete === true,
    archiveTarget,
    archiveTargetExists: await pathExists(cwd, archiveTarget),
    config: projectConfig,
  }
}

/** `instructions`: compose the native prompt for one workflow phase. */
async function methodInstructions(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const kind = typeof payload.kind === 'string' ? payload.kind : ''
  const topic = typeof payload.topic === 'string' ? payload.topic : ''
  const changeName = typeof payload.change === 'string' ? payload.change.trim() : ''

  if (kind === 'explore') {
    const config = await readProjectConfig(cwd)
    return { text: await buildExplorePrompt({ cwd, config, topic }), kind }
  }
  if (!['propose', 'apply', 'update', 'sync', 'archive'].includes(kind)) {
    throw new Error(`未知的指令类型：${kind}`)
  }

  const focus = await schemaContext(cwd, changeName)
  if (focus.resolved.schema === null) {
    throw new Error(`schema "${focus.schemaName}" 不存在：项目 openspec/schemas/ 与内置快照中都没有定义`)
  }
  const projectConfig = focus.config
  if (changeName.length === 0) {
    throw new Error('缺少 change 名称')
  }
  let change
  try {
    change = await computeChangeState(cwd, changeName, { projectConfig })
  } catch {
    if (kind !== 'propose') throw new Error(`变更 ${changeName} 不存在`)
    change = null
  }
  const schema = focus.resolved.schema
  if (kind === 'propose') {
    const text = await buildProposePrompt({ cwd, changeName, intent: topic, schema, config: projectConfig, change, resume: change !== null })
    return { text, kind, schemaName: focus.schemaName }
  }
  if (kind === 'apply') {
    if (change === null) throw new Error(`变更 ${changeName} 不存在`)
    const text = await buildApplyPrompt({ cwd, changeName, schema, config: projectConfig, change, artifactPrompt: '' })
    return { text, kind, schemaName: focus.schemaName }
  }
  if (change === null) throw new Error(`变更 ${changeName} 不存在`)
  if (kind === 'sync' || kind === 'archive') {
    const facts = await workflowFacts(cwd, changeName, change, projectConfig)
    const text = kind === 'sync'
      ? await buildSyncWorkflowPrompt({ cwd, changeName, schema: focus.resolved, config: projectConfig, change, facts })
      : await buildArchiveWorkflowPrompt({ cwd, changeName, schema: focus.resolved, config: projectConfig, change, facts })
    return { text, kind, schemaName: focus.schemaName, change: changeName }
  }
  const text = await buildUpdatePrompt({ cwd, changeName, schema, config: projectConfig, change })
  return { text, kind, schemaName: focus.schemaName }
}

/** `sync-preview`: dry-run deterministic merge plan (writes nothing). */
async function methodSyncPreview(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const change = typeof payload.change === 'string' ? payload.change.trim() : ''
  if (change.length === 0) throw new Error('缺少 change 名称')
  const projectConfig = await readProjectConfig(cwd)
  const state = await computeWorkspaceState(cwd)
  const changeState = state.changes.find((item) => item.name === change)
  if (changeState === undefined) throw new Error(`找不到进行中的变更 "${change}"`)
  const deltas = await readDeltas(cwd, change)
  const mainSpecs = []
  for (const delta of deltas) {
    const capability = capabilityOf(change, delta.path)
    const mainPath = `openspec/specs/${capability}/spec.md`
    const text = await readTextOrNull(cwd, mainPath)
    if (text !== null && !mainSpecs.some((spec) => spec.path === mainPath)) {
      mainSpecs.push({ path: mainPath, text })
    }
  }
  const plan = planSync({
    changeName: change,
    mainSpecs,
    deltas,
    retireCapabilities: changeState.metadata.retire_capabilities === true,
  })
  const preview = previewSyncPlan(plan)
  const validation = (await validateChangeByName(cwd, change)).validation
  return {
    change,
    validation,
    ok: plan.ok,
    issues: plan.issues,
    summary: plan.summary,
    writes: plan.writes.map((write) => ({ path: write.path, action: write.action, summary: write.summary })),
    text: preview.text,
    files: preview.files,
  }
}

/** `document`: one workspace-contained document read with an explicit truncation flag. */
async function methodDocument(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  let rel = typeof payload.path === 'string' ? payload.path.replaceAll('\\', '/') : ''
  if (isAbsolute(rel)) {
    if (!isInside(cwd, rel)) throw new Error('拒绝读取工作区之外的文件')
    rel = relative(cwd, rel).replaceAll('\\', '/')
  }
  rel = rel.replace(/^\/+/, '')
  if (rel.length === 0 || rel.includes('..')) throw new Error('文档路径无效')
  const absolute = toAbs(cwd, rel)
  if (!isInside(cwd, absolute)) throw new Error('拒绝读取工作区之外的文件')
  const text = await readTextOrNull(cwd, rel)
  if (text === null) throw new Error(`无法读取文档：${rel}`)
  const lines = text.split(/\r?\n/)
  const offset = Number.isFinite(payload.offset) && payload.offset > 0 ? Math.floor(payload.offset) : 1
  const limit = Number.isFinite(payload.limit) && payload.limit > 0 ? Math.min(Math.floor(payload.limit), 4000) : DOCUMENT_PAGE_LINES
  const start = Math.min(offset - 1, lines.length)
  const page = lines.slice(start, start + limit)
  const end = start + page.length
  return {
    path: rel,
    text: page.join('\n'),
    offset: start + 1,
    lines: page.length,
    totalLines: lines.length,
    truncated: end < lines.length,
    nextOffset: end < lines.length ? end + 1 : null,
  }
}

/** `archive-detail`: one archived change rendered with the same native shape as an active change. */
async function methodArchiveDetail(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const rawPath = typeof payload.path === 'string' ? payload.path.replaceAll('\\', '/') : ''
  const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
  let rel = ''
  if (rawPath.length > 0) {
    rel = rawPath.replace(/^\/+/, '')
    if (!rel.startsWith('openspec/')) rel = `openspec/changes/archive/${rel.replace(/^archive\//, '')}`
  } else if (rawName.length > 0) {
    rel = `openspec/changes/archive/${rawName.replace(/^archive\//, '')}`
  } else {
    throw new Error('缺少归档路径或名称')
  }
  if (rel.includes('..') || !rel.startsWith('openspec/changes/archive/')) throw new Error('归档路径无效')
  if (!isInside(cwd, toAbs(cwd, rel))) throw new Error('归档路径不在工作区内')
  const projectConfig = await readProjectConfig(cwd)
  const suffix = rel.slice('openspec/changes/'.length)
  try {
    return { change: await computeChangeState(cwd, suffix, { projectConfig }) }
  } catch {
    throw new Error(`找不到已归档的变更：${rel}`)
  }
}

/** `report-prompt`: compose the read-only human-report prompt for one archived change or one date period. */
async function methodReportPrompt(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const scope = reportScopeOf(payload)
  const template = { path: REPORT_TEMPLATE_PATH, version: REPORT_TEMPLATE_VERSION }
  const mainline = await readMainlineCard(cwd)
  if (scope === 'range') {
    const range = await resolveReportRange(cwd, payload)
    const root = resolveReportRoot(cwd, payload.reportRoot)
    const directory = joinRel(root.rel, `${range.from}_${range.to}`)
    const rel = joinRel(directory, REPORT_FILE)
    const absolutePath = toAbs(cwd, rel)
    const report = { path: rel, absolutePath, directory }
    const text = await buildReportPrompt({
      cwd,
      scope,
      range,
      report,
      template,
      mainline,
    })
    return {
      text,
      scope,
      report: { path: rel, absolutePath, exists: await pathExists(cwd, rel) },
      template,
      included: range.included,
    }
  }

  const archived = resolveArchivedChange(cwd, payload)
  const projectConfig = await readProjectConfig(cwd)
  let change
  try {
    change = await computeChangeState(cwd, `archive/${archived.dir}`, { projectConfig })
  } catch {
    throw new Error(`找不到已归档的变更：${archived.rel}`)
  }
  const facts = await reportChangeFacts(cwd, archived, change)
  const inArchive = payload.inArchive === true
  const root = resolveReportRoot(cwd, payload.reportRoot)
  const rel = inArchive
    ? joinRel(archived.rel, ARCHIVE_REPORT_FILE)
    : joinRel(root.rel, archived.changeName, REPORT_FILE)
  const absolutePath = toAbs(cwd, rel)
  if (!isInside(cwd, absolutePath)) throw new Error('报告输出路径不在工作区内')
  const report = { path: rel, absolutePath, inArchive }
  const text = await buildReportPrompt({
    cwd,
    scope,
    changeName: archived.changeName,
    changePath: archived.rel,
    change,
    facts,
    report,
    template,
    mainline,
  })
  return {
    text,
    scope,
    report: { path: rel, absolutePath, exists: await pathExists(cwd, rel) },
    template,
  }
}

/** `report-status`: read-only discovery of an existing report (pointer → convention → archive file). */
async function methodReportStatus(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const scope = reportScopeOf(payload)
  const root = resolveReportRoot(cwd, payload.reportRoot)

  if (scope === 'range') {
    const range = await resolveReportRange(cwd, payload)
    const directory = joinRel(root.rel, `${range.from}_${range.to}`)
    const rel = joinRel(directory, REPORT_FILE)
    const pointer = await readReportPointer(cwd, joinRel(directory, REPORT_POINTER_FILE))
    const exists = await pathExists(cwd, rel)
    const pointerIncluded = Array.isArray(pointer?.included) ? pointer.included.length : null
    return {
      scope,
      exists,
      path: exists ? rel : null,
      absolutePath: exists ? toAbs(cwd, rel) : undefined,
      generatedAt: exists && typeof pointer?.generatedAt === 'string' ? pointer.generatedAt : undefined,
      source: exists ? 'convention' : undefined,
      included: pointerIncluded ?? range.included.length,
    }
  }

  const archived = resolveArchivedChange(cwd, payload)

  // 1. Pointer written when the report lives outside the archive directory.
  const pointer = await readReportPointer(cwd, joinRel(archived.rel, REPORT_POINTER_FILE))
  if (pointer !== null && typeof pointer.report === 'string') {
    const target = resolvePointerTarget(cwd, pointer.report)
    if (target !== null) {
      const generatedAt = typeof pointer.generatedAt === 'string' ? pointer.generatedAt : undefined
      if (!target.inside) {
        // Outside the workspace the Host can only trust the pointer itself, not stat the file.
        return { scope, exists: true, path: target.path, absolutePath: target.absolute, generatedAt, source: 'pointer' }
      }
      if (await pathExists(cwd, target.rel)) {
        return { scope, exists: true, path: target.rel, absolutePath: target.absolute, generatedAt, source: 'pointer' }
      }
    }
  }

  // 2. Naming convention under the report root.
  const conventionRel = joinRel(root.rel, archived.changeName, REPORT_FILE)
  if (await pathExists(cwd, conventionRel)) {
    return { scope, exists: true, path: conventionRel, absolutePath: toAbs(cwd, conventionRel), source: 'convention' }
  }

  // 3. Report written directly inside the archived change directory.
  const archiveRel = joinRel(archived.rel, ARCHIVE_REPORT_FILE)
  if (await pathExists(cwd, archiveRel)) {
    return { scope, exists: true, path: archiveRel, absolutePath: toAbs(cwd, archiveRel), source: 'archive' }
  }

  return { scope, exists: false, path: null }
}

/** `init`: native scaffold, idempotent; returns the created list. */
async function methodInit(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const { created, configContent } = await ensureSkeleton(cwd)
  const text =
    created.length === 0
      ? 'OpenSpec 已初始化过，没有需要补建的文件。'
      : `OpenSpec 骨架已就绪（新建：${created.join('、')}）。下一步：/opsx-explore 想清楚，或 /opsx-propose <change-name> 直接写计划。`
  return { ok: true, text, created, configLength: configContent.length }
}

/**
 * `task-toggle`: tick or untick exactly one native task checkbox.
 *
 * The panel is read-only for planning artifacts, but a task is an execution
 * checklist: after a manual acceptance step the user must be able to record
 * that verification. The route still writes only `tasks.md`; it never accepts
 * an arbitrary path, and a stale line number is rejected instead of guessing.
 */
async function methodTaskToggle(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const change = typeof payload.change === 'string' ? payload.change.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change)) throw new Error('change 名称无效')
  const line = Number(payload.line)
  const done = payload.done === true
  const state = await computeChangeState(cwd, change)
  const tracks = typeof state.tracks === 'string' && state.tracks.trim() !== '' ? state.tracks.trim() : 'tasks.md'
  const rel = `openspec/changes/${change}/${tracks}`
  if (!isInside(cwd, toAbs(cwd, rel))) throw new Error('任务清单路径不在工作区内')
  const text = await readTextOrNull(cwd, rel)
  if (text === null) throw new Error(`找不到任务清单：${rel}`)
  const toggled = toggleTaskLine(text, line, done)
  await writeText(cwd, rel, toggled.text)
  return {
    ok: true,
    change,
    path: rel,
    line: toggled.line,
    done: toggled.done,
    manual: toggled.manual,
    task: toggled.task,
  }
}

/** Read and bound one request body. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** Register the panel route on the DSH web server (`init` / `task-toggle` write by design). */
function registerRoute(ctx) {
  const handlers = {
    state: methodState,
    validate: methodValidate,
    instructions: methodInstructions,
    'sync-preview': methodSyncPreview,
    document: methodDocument,
    'archive-detail': methodArchiveDetail,
    'report-prompt': methodReportPrompt,
    'report-status': methodReportStatus,
    'task-toggle': methodTaskToggle,
    'orchestration-draft': methodOrchestrationDraft,
    'orchestration-plan': methodOrchestrationPlan,
    'orchestration-create': methodOrchestrationCreate,
    'orchestration-accept': methodOrchestrationAccept,
    'orchestration-auto': methodOrchestrationAuto,
    'orchestration-roles': methodOrchestrationRoles,
    init: methodInit,
  }
  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const respond = (rpcId, result, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
          }
          let rpcId = ''
          try {
            const endpoint = new URL(req.url ?? '/', 'http://dsh-spec.invalid').pathname
              .slice(ROUTE.length)
              .replace(/^\//, '')
            const envelope = await readBody(req, MAX_REQUEST_BYTES)
            rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId.slice(0, 200) : ''
            if (envelope.type !== 'client-request' || rpcId.length === 0 || envelope.method !== endpoint) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('bad request envelope')
              return
            }
            const handler = handlers[endpoint]
            if (handler === undefined) throw new Error(`未知操作：${endpoint}`)
            const payload = envelope.payload !== null && typeof envelope.payload === 'object' ? envelope.payload : {}
            const value = await handler(ctx, payload)
            respond(rpcId, { ok: true, value })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            if (rpcId.length === 0) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('bad request')
              return
            }
            respond(rpcId, { ok: false, error: { code: 'dsh-spec/failed', message: detail, details: {} } })
          }
        },
      }),
    'dsh-spec: /dsh-spec route',
  )
}

/** Register the fallback skill provider when the composition exposes `ctx.skills`. */
function registerFallbackSkills(ctx) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') return
  const detect = (cwd, options = {}) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { skills: [], rootsScanned: [], warnings: [] }
    return detectNativeSkills(cwd, { signal: options?.signal })
  }
  ctx.effect(
    () => skills.registerProvider(() => createFallbackProvider(detect)),
    'dsh-spec: native OpenSpec fallback skills',
  )
}

/** Register the command family, the panel route and the optional skill provider. */
export function apply(ctx) {
  registerCommands(ctx)
  registerRoute(ctx)
  registerFallbackSkills(ctx)
}
