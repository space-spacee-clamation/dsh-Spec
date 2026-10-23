/**
 * Multi-role OpenSpec orchestration (Host half).
 *
 * A *program* groups child OpenSpec changes that share one goal. Each child
 * change is a normal native change; roles only exchange file artifacts and short
 * handoff notes, never conversation transcripts.
 *
 * Layout:
 *
 *   openspec/orchestration/<program>/program.json
 *   openspec/orchestration/<program>/handoffs/<task>-<role>.md
 *
 * The manifest is JSON on purpose: it is written by the panel and must remain
 * easy to parse without a YAML serializer dependency.
 *
 * @module dsh-spec/native/orchestration
 */

import { joinRel, listDir, pathExists, readTextOrNull, writeText } from './fsio.js'
import { ensureSkeleton } from './init.js'
import { readProjectConfig } from './config.js'
import {
  formatLocalDate,
  resolveSchemaName,
  serializeChangeMetadata,
} from './metadata.js'

/** Directory that holds all programs. */
export const ORCHESTRATION_DIR = 'openspec/orchestration'

/** Draft and plan files used by the AI task-splitting flow. */
export const PLAN_DRAFT_DIR = 'openspec/orchestration/.drafts'
export const PLAN_DIR = 'openspec/orchestration/.plans'

/** Work roles that participate in a task, in workflow order. */
export const ROLE_IDS = ['product', 'design', 'dev', 'test']

/** Roles that have a model (PM coordinates the program; work roles execute). */
export const MODEL_ROLE_IDS = ['pm', ...ROLE_IDS]

/** Default labels and prompts. */
export const ROLE_DEFINITIONS = {
  pm: {
    label: 'PM',
    color: 'cyan',
    summary: '把控项目进度、识别阻塞、决定下一步；不写业务代码，不代替用户最终验收。',
  },
  product: {
    label: '产品',
    color: 'blue',
    summary: '写出可评审的 proposal、delta specs、验收标准与任务清单；不写代码。',
  },
  design: {
    label: '设计',
    color: 'violet',
    summary: '根据产品规格产出 design.md、视觉规范与资源清单；不写业务代码。',
  },
  dev: {
    label: '开发',
    color: 'green',
    summary: '按规格与设计实现代码，勾选 tasks.md；UI 工作必须等设计完成。',
  },
  test: {
    label: '测试',
    color: 'amber',
    summary: '按验收标准做功能与视觉验证，写 qa/report.md；不代替用户最终验收。',
  },
}

/**
 * @typedef {{provider: string, model: string, label?: string}} RoleModel
 * @typedef {{id: string, title: string, change: string, description: string, dependsOn: string[], roles: string[], accepted: boolean}} Task
 * @typedef {{version: number, id: string, title: string, goal: string, created: string, roles: Record<string, RoleModel>, tasks: Task[]}} Program
 */

/**
 * Slugify an ASCII identifier. Chinese titles need an explicit id from the UI.
 * @param {string} value
 * @returns {string}
 */
export function slugifyId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Validate a change/program id.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value) && value.length <= 64
}

/**
 * Directory of one program.
 * @param {string} id
 * @returns {string}
 */
export function programRel(id) {
  return joinRel(ORCHESTRATION_DIR, id)
}

/**
 * Normalize the four role assignments shared by programs and planning drafts.
 * @param {any} rawRoles
 * @returns {Record<string, RoleModel>}
 */
export function normalizeRoles(rawRoles) {
  /** @type {Record<string, RoleModel>} */
  const roles = {}
  for (const role of MODEL_ROLE_IDS) {
    const value = rawRoles !== null && typeof rawRoles === 'object' ? rawRoles[role] : undefined
    const provider = value !== null && typeof value === 'object' && typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = value !== null && typeof value === 'object' && typeof value.model === 'string' ? value.model.trim() : ''
    roles[role] = { provider, model, label: ROLE_DEFINITIONS[role].label }
  }
  return roles
}

/**
 * Normalize a raw manifest into the stable shape used by the panel.
 *
 * Invalid references are rejected rather than silently rewritten: a wrong
 * dependency order is a coordination bug, not a display detail.
 *
 * @param {any} raw
 * @returns {Program}
 */
export function normalizeProgram(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('program 不是对象')
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!isValidId(id)) throw new Error('program id 无效（只允许小写字母、数字和连字符）')
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : id
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  const created = typeof raw.created === 'string' && raw.created.trim() !== '' ? raw.created.trim() : formatLocalDate()
  const roles = normalizeRoles(raw.roles)
  const auto = raw.auto === true

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error('program 至少需要一个子任务')
  const tasks = []
  const seenIds = new Set()
  const seenChanges = new Set()
  for (const item of raw.tasks) {
    if (item === null || typeof item !== 'object') throw new Error('子任务不是对象')
    const taskId = typeof item.id === 'string' ? item.id.trim() : ''
    if (!isValidId(taskId)) throw new Error(`子任务 id 无效：${String(item.id ?? '')}`)
    if (seenIds.has(taskId)) throw new Error(`子任务 id 重复：${taskId}`)
    seenIds.add(taskId)
    const change = typeof item.change === 'string' ? item.change.trim() : taskId
    if (!isValidId(change)) throw new Error(`子任务 ${taskId} 的 change 名称无效`)
    if (seenChanges.has(change)) throw new Error(`子任务 change 重复：${change}`)
    seenChanges.add(change)
    const roleList = Array.isArray(item.roles)
      ? [...new Set(item.roles.filter((role) => ROLE_IDS.includes(role)))]
      : [...ROLE_IDS]
    if (roleList.length === 0) throw new Error(`子任务 ${taskId} 没有参与角色`)
    tasks.push({
      id: taskId,
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : taskId,
      change,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      dependsOn: Array.isArray(item.dependsOn)
        ? [...new Set(item.dependsOn.filter((dep) => typeof dep === 'string' && dep.trim() !== '').map((dep) => dep.trim()))]
        : [],
      roles: roleList,
      accepted: item.accepted === true,
    })
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seenIds.has(dep)) throw new Error(`子任务 ${task.id} 依赖不存在的任务：${dep}`)
      if (dep === task.id) throw new Error(`子任务 ${task.id} 不能依赖自己`)
    }
  }
  // Detect dependency cycles (depth-first).
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (taskId) => {
    if (visited.has(taskId)) return
    if (visiting.has(taskId)) throw new Error('子任务依赖存在环')
    visiting.add(taskId)
    for (const dep of byId.get(taskId)?.dependsOn ?? []) visit(dep)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of tasks) visit(task.id)

  return { version: 1, id, title, goal, created, roles, auto, tasks }
}

/**
 * Read one program (without evaluation).
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<Program>}
 */
export async function readProgram(cwd, id) {
  if (!isValidId(id)) throw new Error('program id 无效')
  const text = await readTextOrNull(cwd, joinRel(programRel(id), 'program.json'))
  if (text === null) throw new Error(`找不到多角色任务：${id}`)
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`program.json 解析失败：${error.message}`)
  }
  return normalizeProgram(raw)
}

/**
 * Persist the user's goal + role models while the planner model splits it.
 * @param {string} cwd
 * @param {any} input
 * @param {{date?: string}} [options]
 * @returns {Promise<{id:string,goal:string,roles:Record<string,RoleModel>,created:string}>}
 */
export async function writePlanDraft(cwd, input, { date = formatLocalDate() } = {}) {
  if (input === null || typeof input !== 'object') throw new Error('缺少规划草稿')
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!isValidId(id)) throw new Error('规划草稿 id 无效')
  const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
  if (goal === '') throw new Error('最终目标不能为空')
  if (goal.length > 20_000) throw new Error('最终目标过长（最多 20000 字）')
  const draft = { id, goal, roles: normalizeRoles(input.roles), created: date }
  await writeText(cwd, joinRel(PLAN_DRAFT_DIR, `${id}.json`), `${JSON.stringify(draft, null, 2)}\n`)
  // Give the planner an existing directory to write into.
  await writeText(cwd, joinRel(PLAN_DIR, '.gitkeep'), '')
  return draft
}

/**
 * Read a planning draft.
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<{id:string,goal:string,roles:Record<string,RoleModel>,created:string}>}
 */
export async function readPlanDraft(cwd, id) {
  if (!isValidId(id)) throw new Error('规划草稿 id 无效')
  const text = await readTextOrNull(cwd, joinRel(PLAN_DRAFT_DIR, `${id}.json`))
  if (text === null) throw new Error(`找不到规划草稿：${id}`)
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`规划草稿解析失败：${error.message}`)
  }
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (goal === '') throw new Error(`规划草稿 ${id} 缺少最终目标`)
  return { id, goal, roles: normalizeRoles(raw.roles), created: typeof raw.created === 'string' ? raw.created : formatLocalDate() }
}

/**
 * Read the planner's proposed task split. Null means the planner has not
 * written it yet; malformed JSON / invalid tasks throw and the caller can show
 * a retryable error.
 *
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<{title:string,tasks:Task[]}|null>}
 */
export async function readPlan(cwd, id) {
  if (!isValidId(id)) throw new Error('规划 id 无效')
  const text = await readTextOrNull(cwd, joinRel(PLAN_DIR, `${id}.json`))
  if (text === null) return null
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`规划文件还不是合法 JSON：${error.message}`)
  }
  const draft = await readPlanDraft(cwd, id)
  const program = normalizeProgram({
    id,
    title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : draft.goal.slice(0, 80),
    goal: draft.goal,
    created: draft.created,
    roles: draft.roles,
    tasks: raw.tasks,
  })
  return { title: program.title, tasks: program.tasks }
}

/**
 * Build the planner prompt. The planner writes exactly one JSON file; the Host
 * remains responsible for creating `.openspec.yaml` and the change directories.
 *
 * @param {string} cwd
 * @param {{id:string,goal:string,roles:Record<string,RoleModel>}} draft
 * @returns {Promise<string>}
 */
export async function buildPlanPrompt(cwd, draft) {
  const planPath = joinRel(PLAN_DIR, `${draft.id}.json`)
  const roleLines = MODEL_ROLE_IDS.map((role) => {
    const model = draft.roles?.[role]
    const value = model?.provider && model?.model ? `${model.provider}/${model.model}` : '会话默认'
    return `- ${role}（${ROLE_DEFINITIONS[role].label}）：${value}`
  })
  return [
    '你在为 OpenSpec 多角色任务做**任务拆分规划**，不写业务代码，也不创建 change。',
    '',
    '## 最终目标',
    '',
    draft.goal,
    '',
    '## 角色与模型',
    '',
    ...roleLines,
    '',
    '## 任务',
    '',
    `把目标拆成 1–8 个子任务，写入唯一文件：\`${planPath}\`。`,
    'Host 拿到这个文件后才会创建每个子任务的 change、`.openspec.yaml` 和程序清单；你不要创建 `openspec/changes/**` 或 `program.json`。',
    '',
    '文件必须是合法 JSON，结构如下：',
    '',
    '```json',
    JSON.stringify(
      {
        title: '简短的中文程序标题',
        tasks: [
          {
            id: 'core',
            change: 'skill-core',
            title: '技能核心',
            description: '共享数据结构、接口与验收基线',
            dependsOn: [],
          },
          {
            id: 'fireball',
            change: 'skill-fireball',
            title: '火球术',
            description: '在核心之上新增火球术技能与视觉',
            dependsOn: ['core'],
          },
        ],
      },
      null,
      2,
    ),
    '```',
    '',
    '规则：',
    '',
    '- `id` 与 `change` 必须是小写 ASCII kebab-case，唯一，且不要带路径；',
    '- `title` / `description` 使用与最终目标相同的语言；',
    '- `dependsOn` 只能引用本文件中已经出现的任务 id，且不能成环；',
    '- 任务按可交付的子能力拆分，不要按“写代码 / 写测试”机械拆分；',
    '- 有共享基础时，先放一个 core 任务，其余任务依赖它；',
    '- 每个子任务都会由产品 / 设计 / 开发 / 测试四个角色参与，不需要在 JSON 里重复角色字段；',
    '- 只写规划文件，不要写任何代码、proposal、specs、design 或 tasks。',
    '',
    '写完后用一句话说明拆分结果，不要粘贴 JSON 全文。',
  ].join('\n')
}

/**
 * Read and evaluate every program.
 *
 * @param {string} cwd
 * @param {any} workspaceState result of computeWorkspaceState
 * @returns {Promise<{programs: any[], warnings: string[]}>}
 */
export async function readPrograms(cwd, workspaceState) {
  const warnings = []
  const entries = await listDir(cwd, ORCHESTRATION_DIR).catch(() => [])
  const programs = []
  for (const entry of entries) {
    if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
    try {
      const program = await readProgram(cwd, entry.name)
      programs.push(await evaluateProgram(cwd, program, workspaceState))
    } catch (error) {
      warnings.push(`${entry.name}: ${error.message}`)
    }
  }
  programs.sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.title.localeCompare(b.title))
  return { programs, warnings }
}

/**
 * Write a normalized program.
 * @param {string} cwd
 * @param {Program} program
 */
export async function writeProgram(cwd, program) {
  const normalized = normalizeProgram(program)
  await writeText(cwd, joinRel(programRel(normalized.id), 'program.json'), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

/**
 * Create a program and scaffold one native change per child task.
 *
 * The scaffold contains only `.openspec.yaml`; the product role is expected to
 * write proposal / specs / tasks. Existing changes are never overwritten.
 *
 * @param {string} cwd
 * @param {any} input
 * @param {{date?: string}} [options]
 * @returns {Promise<Program>}
 */
export async function createProgram(cwd, input, { date = formatLocalDate() } = {}) {
  if (input === null || typeof input !== 'object') throw new Error('缺少多角色任务定义')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '') throw new Error('任务标题不能为空')
  const id = isValidId(input.id) ? input.id : slugifyId(title)
  if (!isValidId(id)) throw new Error('program id 无效，请填写一个英文 id（例如 skill-system）')
  if (await pathExists(cwd, programRel(id))) throw new Error(`多角色任务已存在：${id}`)
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error('至少需要一个子任务')

  await ensureSkeleton(cwd)
  const projectConfig = await readProjectConfig(cwd)
  const schema = resolveSchemaName({ projectConfig })
  const tasks = input.tasks.map((task, index) => {
    const fallback = `${id}-${index + 1}`
    return {
      ...task,
      id: isValidId(task?.id) ? task.id : fallback,
      change: isValidId(task?.change) ? task.change : (isValidId(task?.id) ? task.id : fallback),
    }
  })
  const program = normalizeProgram({
    id,
    title,
    goal: typeof input.goal === 'string' ? input.goal : '',
    created: date,
    roles: input.roles,
    auto: input.auto !== false,
    tasks,
  })

  for (const task of program.tasks) {
    const changeDir = joinRel('openspec', 'changes', task.change)
    if (await pathExists(cwd, changeDir)) {
      throw new Error(`change 已存在，拒绝覆盖：${task.change}`)
    }
  }
  for (const task of program.tasks) {
    await writeText(
      cwd,
      joinRel('openspec', 'changes', task.change, '.openspec.yaml'),
      serializeChangeMetadata({ schema, created: date, goal: task.title }),
    )
  }
  await writeText(cwd, joinRel(programRel(id), 'program.json'), `${JSON.stringify(program, null, 2)}\n`)
  await writeText(cwd, joinRel(programRel(id), 'handoffs', '.gitkeep'), '')
  return program
}

/**
 * Toggle the automatic coordinator for one program.
 * @param {string} cwd
 * @param {string} programId
 * @param {boolean} auto
 * @returns {Promise<Program>}
 */
export async function updateProgramAuto(cwd, programId, auto) {
  const program = await readProgram(cwd, programId)
  program.auto = auto === true
  return writeProgram(cwd, program)
}

/**
 * Update final acceptance for one task.
 * @param {string} cwd
 * @param {string} programId
 * @param {string} taskId
 * @param {boolean} accepted
 * @returns {Promise<Program>}
 */
export async function acceptTask(cwd, programId, taskId, accepted) {
  const program = await readProgram(cwd, programId)
  const task = program.tasks.find((entry) => entry.id === taskId)
  if (task === undefined) throw new Error(`找不到子任务：${taskId}`)
  task.accepted = accepted === true
  return writeProgram(cwd, program)
}

/**
 * Update role provider/model assignments.
 * @param {string} cwd
 * @param {string} programId
 * @param {Record<string, {provider?: string, model?: string}>} roles
 * @returns {Promise<Program>}
 */
export async function updateProgramRoles(cwd, programId, roles) {
  const program = await readProgram(cwd, programId)
  for (const role of ROLE_IDS) {
    if (roles !== null && typeof roles === 'object' && roles[role] !== undefined) {
      const value = roles[role]
      program.roles[role] = {
        ...program.roles[role],
        provider: typeof value.provider === 'string' ? value.provider.trim() : program.roles[role].provider,
        model: typeof value.model === 'string' ? value.model.trim() : program.roles[role].model,
      }
    }
  }
  return writeProgram(cwd, program)
}

/**
 * Find an artifact status by id.
 * @param {any} change
 * @param {string} id
 * @returns {string|null}
 */
function artifactStatus(change, id) {
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  return artifacts.find((artifact) => artifact?.id === id)?.status ?? null
}

/**
 * Whether the product contract is complete for one change.
 * @param {any} change
 * @returns {boolean}
 */
function productDone(change) {
  if (change === undefined || change === null) return false
  const docs = Array.isArray(change.docs) ? change.docs : []
  const hasDoc = (suffix) => docs.some((doc) => typeof doc.path === 'string' && doc.path.endsWith(suffix))
  const proposal = artifactStatus(change, 'proposal') === 'done' || hasDoc('/proposal.md')
  const specs =
    ['done', 'skipped'].includes(artifactStatus(change, 'specs')) ||
    change.metadata?.skip_specs === true ||
    docs.some((doc) => doc.kind === 'delta')
  const tasks = Number(change.tasks?.total ?? 0) > 0
  return proposal && specs && tasks
}

/**
 * Whether the design contract is complete for one change.
 * @param {any} change
 * @returns {boolean}
 */
function designDone(change) {
  if (change === undefined || change === null) return false
  if (artifactStatus(change, 'design') === 'done') return true
  const docs = Array.isArray(change.docs) ? change.docs : []
  return docs.some((doc) => typeof doc.path === 'string' && doc.path.endsWith('/design.md'))
}

/**
 * Evaluate one program against the current workspace state.
 *
 * This is the coordination contract:
 * - product may start when task dependencies are complete;
 * - design/dev need the product contract;
 * - test needs design + all dev tasks;
 * - user acceptance needs the test report.
 *
 * @param {string} cwd
 * @param {Program} program
 * @param {any} workspaceState
 * @returns {Promise<any>}
 */
export async function evaluateProgram(cwd, program, workspaceState) {
  const changes = new Map((workspaceState?.changes ?? []).map((change) => [change.name, change]))
  const base = new Map()
  for (const task of program.tasks) {
    const change = changes.get(task.change)
    const report = await pathExists(cwd, joinRel('openspec', 'changes', task.change, 'qa', 'report.md'))
    const product = productDone(change)
    const design = product && designDone(change)
    const dev = Number(change?.tasks?.total ?? 0) > 0 && change?.tasks?.done === change?.tasks?.total
    const done = {
      product,
      design,
      dev,
      test: report && design && dev,
      user: task.accepted === true,
    }
    base.set(task.id, { change, report, done })
  }

  const roleState = (task, role) => {
    const info = base.get(task.id)
    const done = info.done[role] === true
    if (done) return { status: 'done', ready: true, done: true, missing: [] }
    const dependencyTasks = task.dependsOn.map((id) => program.tasks.find((entry) => entry.id === id)).filter(Boolean)
    const depMissing = dependencyTasks.filter((dep) => {
      const depBase = base.get(dep.id)
      return !(depBase?.done.product === true && depBase?.done.design === true)
    })
    const depsReady = depMissing.length === 0
    const missing = []
    if (!depsReady) missing.push(`等待依赖：${depMissing.map((dep) => dep.title).join('、')}`)
    if (role === 'product') {
      return { status: depsReady ? 'ready' : 'waiting', ready: depsReady, done: false, missing }
    }
    if (role === 'design') {
      if (!info.done.product) missing.push('等待产品规格（proposal / specs / tasks）')
      const ready = depsReady && info.done.product
      return { status: ready ? 'ready' : 'waiting', ready, done: false, missing }
    }
    if (role === 'dev') {
      if (!info.done.product) missing.push('等待产品规格（proposal / specs / tasks）')
      const ready = depsReady && info.done.product
      const uiWaiting = ready && !info.done.design
      return {
        status: ready ? 'ready' : 'waiting',
        ready,
        done: false,
        missing,
        note: uiWaiting ? '可先做不依赖 UI 的任务；UI 任务等待设计' : '',
      }
    }
    if (role === 'test') {
      if (!info.done.design) missing.push('等待设计完成')
      if (!info.done.dev) missing.push('等待开发完成全部 tasks')
      const ready = depsReady && info.done.design && info.done.dev
      return { status: ready ? 'ready' : 'waiting', ready, done: false, missing }
    }
    // user
    if (!info.done.test) missing.push('等待测试报告 qa/report.md')
    return { status: info.done.test ? 'ready' : 'waiting', ready: info.done.test, done: false, missing }
  }

  const tasks = program.tasks.map((task) => {
    const info = base.get(task.id)
    const roles = {}
    for (const role of task.roles) roles[role] = roleState(task, role)
    const doneCount = task.roles.filter((role) => roles[role]?.done).length
    const anyStarted = task.roles.some((role) => roles[role]?.done)
    return {
      ...task,
      changeExists: info.change !== undefined,
      summary: info.change?.summary?.headline ?? '',
      progress: {
        done: Number(info.change?.tasks?.done ?? 0),
        total: Number(info.change?.tasks?.total ?? 0),
      },
      roles,
      status: task.accepted
        ? 'accepted'
        : doneCount === task.roles.length
          ? 'done'
          : anyStarted || info.done.product || info.done.design || info.done.dev || info.done.test
            ? 'active'
            : 'pending',
    }
  })
  const accepted = tasks.filter((task) => task.accepted).length
  const pmStatus = await readTextOrNull(cwd, joinRel(programRel(program.id), 'pm', 'status.md'))
  return {
    ...program,
    auto: program.auto === true,
    pmStatus: pmStatus === null ? '' : pmStatus.slice(0, 6000),
    tasks,
    progress: {
      accepted,
      total: tasks.length,
      done: tasks.filter((task) => task.status === 'done').length,
    },
  }
}

/** Maximum characters kept from one context document. */
const CONTEXT_CHARS = 3200

/**
 * Read one artifact as a bounded, labelled context block.
 * @param {string} cwd
 * @param {string} rel
 * @param {string} label
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
async function contextBlock(cwd, rel, label, limit = CONTEXT_CHARS) {
  const text = await readTextOrNull(cwd, rel)
  if (text === null || text.trim() === '') return `### ${label}\n（${rel} 尚未生成）\n`
  const body = text.length > limit ? `${text.slice(0, limit)}\n\n…（已截断，完整文件：${rel}）` : text
  return `### ${label}\n\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n`
}

/**
 * Read role handoffs for one task, optionally filtered by role.
 * @param {string} cwd
 * @param {string} programId
 * @param {string} taskId
 * @param {string[]} [roles]
 * @returns {Promise<string>}
 */
async function handoffBlocks(cwd, programId, taskId, roles = ROLE_IDS) {
  const blocks = []
  for (const role of roles) {
    const rel = joinRel(programRel(programId), 'handoffs', `${taskId}-${role}.md`)
    const text = await readTextOrNull(cwd, rel)
    if (text !== null && text.trim() !== '') {
      blocks.push(`### ${ROLE_DEFINITIONS[role].label}交接\n\n${text.trim().slice(0, 1200)}\n`)
    }
  }
  return blocks.length === 0 ? '（暂无交接）\n' : blocks.join('\n')
}

/**
 * Build the role prompt from file artifacts only.
 *
 * The prompt deliberately does not include other agents' conversations. It
 * includes the program goal, the current task, dependency handoffs, and bounded
 * excerpts of the artifacts this role is allowed to consume.
 *
 * @param {string} cwd
 * @param {any} program evaluated program
 * @param {any} task evaluated task
 * @param {string} role one of ROLE_IDS
 * @param {any} workspaceState
 * @returns {Promise<string>}
 */
export async function buildRolePrompt(cwd, program, task, role, workspaceState) {
  if (!ROLE_IDS.includes(role)) throw new Error(`未知角色：${role}`)
  const def = ROLE_DEFINITIONS[role]
  const change = (workspaceState?.changes ?? []).find((entry) => entry.name === task.change)
  const changeDir = joinRel('openspec', 'changes', task.change)
  const handoffRel = joinRel(programRel(program.id), 'handoffs', `${task.id}-${role}.md`)
  const specDocs = Array.isArray(change?.docs)
    ? change.docs.filter((doc) => doc.artifactId === 'specs').slice(0, 4)
    : []

  const context = []
  if (role === 'product') {
    context.push(`### 任务说明\n${task.description || task.title}\n`)
    context.push(await contextBlock(cwd, joinRel(changeDir, 'proposal.md'), '已有 proposal（如存在）'))
    for (const doc of specDocs) context.push(await contextBlock(cwd, doc.path, `已有规格：${doc.label}`, 2400))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'tasks.md'), '已有 tasks.md（如存在）'))
  } else if (role === 'design') {
    context.push(await handoffBlocks(cwd, program.id, task.id, ['product']))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'proposal.md'), '产品 proposal'))
    for (const doc of specDocs) context.push(await contextBlock(cwd, doc.path, `产品规格：${doc.label}`, 2400))
  } else if (role === 'dev') {
    context.push(await handoffBlocks(cwd, program.id, task.id, ['product', 'design']))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'design.md'), '设计文档'))
    for (const doc of specDocs) context.push(await contextBlock(cwd, doc.path, `规格：${doc.label}`, 2400))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'tasks.md'), '任务清单', 5000))
  } else {
    context.push(await handoffBlocks(cwd, program.id, task.id, ['product', 'design', 'dev']))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'proposal.md'), '产品 proposal'))
    for (const doc of specDocs) context.push(await contextBlock(cwd, doc.path, `规格：${doc.label}`, 2400))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'design.md'), '设计文档'))
    context.push(await contextBlock(cwd, joinRel(changeDir, 'tasks.md'), '任务清单', 5000))
  }

  const dependencyNotes = task.dependsOn.length === 0
    ? '无'
    : task.dependsOn.map((id) => {
        const dep = program.tasks.find((entry) => entry.id === id)
        return `${id}（${dep?.title ?? id}）`
      }).join('、')

  // Dependencies are contracts, so every role sees their proposal/spec/design
  // and handoff summary. This is intentionally not the dependency's transcript.
  for (const depId of task.dependsOn.slice(0, 3)) {
    const dep = program.tasks.find((entry) => entry.id === depId)
    if (dep === undefined) continue
    const depDir = joinRel('openspec', 'changes', dep.change)
    context.push(`### 依赖任务：${dep.title}（${dep.id}）\n`)
    context.push(await contextBlock(cwd, joinRel(depDir, 'proposal.md'), `依赖 ${depId} 的 proposal`, 2200))
    const depChange = (workspaceState?.changes ?? []).find((entry) => entry.name === dep.change)
    const depSpecs = Array.isArray(depChange?.docs)
      ? depChange.docs.filter((doc) => doc.artifactId === 'specs').slice(0, 2)
      : []
    for (const doc of depSpecs) context.push(await contextBlock(cwd, doc.path, `依赖 ${depId} 的规格：${doc.label}`, 2200))
    context.push(await contextBlock(cwd, joinRel(depDir, 'design.md'), `依赖 ${depId} 的设计`, 2200))
    context.push(await handoffBlocks(cwd, program.id, dep.id))
  }

  const roleRules = {
    product: [
      `在 \`${changeDir}/proposal.md\` 写清楚 Why / What Changes，在 \`${changeDir}/specs/<capability>/spec.md\` 写 delta 规格与验收场景。`,
      `在 \`${changeDir}/tasks.md\` 写出可执行的任务清单，必须包含功能验收项；需要人工验收的任务以 \`[人工验收]\` 开头。`,
      '不要修改代码，也不要写 design.md、视觉规范或交互实现细节；这些由设计角色负责。',
      '如果需要跳过 specs（例如纯视觉任务），把 `.openspec.yaml` 的 `skip_specs` 设为 true，并在 proposal 里说明原因。',
    ],
    design: [
      `在 \`${changeDir}/design.md\` 写技术/视觉设计：交互、状态、组件、资源、动效、验收要点。`,
      `如需要，补充 \`${changeDir}/design/visual.md\` 或资源清单；不要写业务代码。`,
      '视觉规范必须可执行、可检查；不要只写“好看”“高级”这类主观描述。',
    ],
    dev: [
      `按 \`${changeDir}/tasks.md\` 实现；每完成一项就把复选框改为 \`[x]\`，不要批量假装完成。`,
      '只实现不依赖设计的功能，直到 design.md 存在；依赖视觉的 UI 任务必须等待设计，不要自行发明视觉规范。',
      '不要勾选以 `[人工验收]` 开头的任务，它们必须留给用户最终确认。',
      '完成后在 handoff 里列出未完成任务、阻塞点和测试建议。',
    ],
    test: [
      `在 \`${changeDir}/qa/report.md\` 写测试报告：功能、视觉、复现步骤、命令、结果、未覆盖项。`,
      '不要代替用户做最终验收，也不要把 `[人工验收]` 任务标成通过；你只给证据和建议。',
      '发现 bug 时写到报告并给出最小复现，不要静默修改产品行为。',
    ],
  }

  const lines = [
    `你在 OpenSpec 多角色任务中扮演「${def.label}」。`,
    '',
    '## 协作原则',
    '',
    '- 你只依赖本提示列出的文件工件与 handoff，不读取其他角色的对话历史；',
    '- 只修改本子任务的 change 目录，不修改其他 change；',
    '- 不把大段代码或推理粘进 handoff，只保留结论、路径、阻塞与下一步；',
    '- 产物是事实源；如果某个文件不存在，就明确报告缺失，不要假设它已经完成。',
    '',
    '## 程序目标',
    '',
    `- 程序：${program.title}（${program.id}）`,
    `- 目标：${program.goal || '（未填写，按任务说明执行）'}`,
    `- 当前子任务：${task.title}（${task.id}）`,
    `- change：${task.change}`,
    `- 依赖：${dependencyNotes}`,
    '',
    '## 你的职责',
    '',
    `- ${def.summary}`,
    ...roleRules[role].map((rule) => `- ${rule}`),
    '',
    '## 可用上下文',
    '',
    ...context,
    '',
    '## 交接要求',
    '',
    `完成后把不超过 200 字的摘要写到 \`${handoffRel}\`，包含：已完成、未完成、阻塞、给下一角色的建议。`,
    '最终回复用一个简短段落总结本次产物与下一步；不要重复粘贴文件全文。',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Build the PM oversight prompt. The deterministic scheduler in the panel is
 * the PM's "hands"; this prompt gives the PM a compact status snapshot and asks
 * for a short review/blocker report.
 *
 * @param {string} cwd
 * @param {any} program evaluated program
 * @returns {Promise<string>}
 */
export async function buildPmPrompt(cwd, program) {
  const statusPath = joinRel(programRel(program.id), 'pm', 'status.md')
  const taskLines = []
  for (const task of program.tasks) {
    const roleBits = ROLE_IDS.map((role) => {
      const gate = task.roles?.[role]
      if (gate === undefined) return null
      const missing = Array.isArray(gate.missing) && gate.missing.length > 0 ? `（${gate.missing.join('；')}）` : ''
      return `${ROLE_DEFINITIONS[role].label}:${gate.done === true ? '完成' : gate.ready === true ? '可开始' : '等待'}${missing}`
    }).filter(Boolean)
    taskLines.push(
      `- ${task.title} (${task.id}, ${task.change})：${task.status}，任务 ${task.progress?.done ?? 0}/${task.progress?.total ?? 0}；${roleBits.join(' | ')}`,
    )
  }
  return [
    '你是这个多角色项目的项目经理（PM）。',
    '',
    '## 程序目标',
    '',
    `- 程序：${program.title}（${program.id}）`,
    `- 目标：${program.goal || '（未填写）'}`,
    `- 自动推进：${program.auto === true ? '已开启（Host 会按门禁启动已就绪角色）' : '已暂停'}`,
    `- 进度：${program.progress?.accepted ?? 0}/${program.tasks.length} 已验收，${program.progress?.done ?? 0} 个任务完成`,
    '',
    '## 当前矩阵',
    '',
    ...taskLines,
    '',
    '## 你的职责',
    '',
    '- 检查各任务的产品规格、设计、开发任务与测试报告是否足以进入下一阶段；',
    '- 指出跨任务的冲突、遗漏、依赖风险，以及需要用户决策的事项；',
    '- 不要写业务代码，不要代替用户做最终验收，不要修改 `program.json`；',
    '- 自动推进由 Host 按工件门禁执行；你只负责巡检、发现阻塞和建议下一步。',
    '',
    '## 输出',
    '',
    `把不超过 600 字的巡检报告写到 \`${statusPath}\`，包含：当前阶段、已完成、阻塞/风险、下一步、需要用户决策的事项。`,
    '最终回复只给一段简短结论；不要粘贴大段文件内容。',
  ].join('\n') + '\n'
}
