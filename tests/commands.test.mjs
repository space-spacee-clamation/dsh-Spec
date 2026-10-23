/**
 * Unit tests for the OpenSpec command surface (src/commands.js).
 *
 * Every handler is exercised with fake dependencies (memory fs, fake engine,
 * fake prompt builders) so no test writes a real file or calls the real engine.
 * The harness registers the twelve commands on a fake `ctx.commands` and runs the
 * registered handler with a fake agent that records `followup()` messages.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerCommands, collectWorkflowFacts, selectChange } from '../src/commands.js'

/** Fake absolute workspace root. */
const CWD = 'C:/workspace'

/** All twelve command ids registered by `registerCommands`. */
const COMMAND_IDS = [
  'openspec-init',
  'opsx-apply',
  'opsx-archive',
  'opsx-explore',
  'opsx-plan',
  'opsx-pm',
  'opsx-propose',
  'opsx-role',
  'opsx-status',
  'opsx-sync',
  'opsx-update',
  'opsx-validate',
]

/** One ChangeState fixture (§4), overridable per test. */
function change(overrides = {}) {
  return {
    name: 'add-x',
    schemaName: 'spec-driven',
    schemaSource: 'builtin',
    metadata: {
      found: true,
      schema: 'spec-driven',
      created: '2026-10-20',
      goal: '',
      skip_specs: false,
      retire_capabilities: false,
    },
    artifacts: [
      { id: 'proposal', outputPath: 'proposal.md', status: 'done' },
      { id: 'specs', outputPath: 'specs', status: 'done' },
      { id: 'design', outputPath: 'design.md', status: 'ready' },
      { id: 'tasks', outputPath: 'tasks.md', status: 'done' },
    ],
    applyRequires: ['proposal', 'specs', 'tasks'],
    tracks: 'tasks.md',
    isPlanningComplete: false,
    nextSteps: ['create design (design.md)'],
    listStatus: 'in-progress',
    tasks: { total: 3, done: 1 },
    docs: [],
    delta: { ADDED: 1, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
    validation: { errors: 0, warnings: 0, infos: 0, issues: [] },
    files: ['proposal.md'],
    ...overrides,
  }
}

/** One WorkspaceState fixture (§4), overridable per test. */
function workspace(overrides = {}) {
  return {
    status: 'ready',
    cwd: CWD,
    root: 'openspec',
    archivedCount: 2,
    config: {
      found: true,
      file: 'config.yaml',
      schema: 'spec-driven',
      context: 'project context',
      rules: {},
      operations: {},
      warnings: [],
    },
    schemas: [],
    changes: [change()],
    specs: [
      {
        name: 'cap',
        path: 'openspec/specs/cap/spec.md',
        purpose: 'purpose',
        requirementCount: 1,
        scenarioCount: 1,
        validation: { errors: 0, warnings: 0, infos: 0 },
      },
    ],
    archived: [],
    skills: { native: [], fallbackActive: false },
    warnings: [],
    ...overrides,
  }
}

/** One flat native validation fixture (`{ errors, warnings, infos, issues }`). */
function cleanValidation(overrides = {}) {
  return { errors: 0, warnings: 0, infos: 0, issues: [], ...overrides }
}

/** Build fake dependency map + fake ctx/agent, register commands, return a `run()` helper. */
function createHarness(overrides = {}, options = {}) {
  const calls = {
    order: [],
    writes: [],
    planSync: [],
    applySyncPlan: [],
    executeArchive: [],
    planArchive: [],
    prompt: {},
    validations: [],
    titles: [],
  }

  // Per-session accepted titles, so a repeated command can observe its own title
  // and the idempotency check behaves like the real title service.
  const acceptedTitles = new Map()
  const titles = options.titles === undefined
    ? {
        get(session) {
          const title = acceptedTitles.get(session?.id)
          return title === undefined ? undefined : { title }
        },
        rename(session, title) {
          calls.titles.push({ sessionId: session?.id, title })
          acceptedTitles.set(session?.id, title)
          return { title }
        },
      }
    : options.titles
  const session = options.session ?? { id: 'session-test' }

  const agent = {
    session,
    messages: [],
    followup(message) {
      calls.order.push(['followup'])
      this.messages.push(message)
    },
  }

  const deps = {
    fs: {
      pathExists: async (cwd, rel) => {
        calls.order.push(['pathExists', rel])
        return false
      },
      readText: async (cwd, rel) => {
        calls.order.push(['readText', rel])
        return '# Main Spec\n'
      },
      writeText: async (cwd, rel, content) => {
        calls.order.push(['writeText', rel])
        calls.writes.push([rel, content])
      },
    },
    init: {
      ensureSkeleton: async () => {
        calls.order.push(['ensureSkeleton'])
        return { created: [], configContent: '' }
      },
    },
    metadata: {
      formatLocalDate: () => '2026-10-20',
      readChangeMetadata: async () => ({
        found: true,
        metadata: {
          schema: 'spec-driven',
          created: '2026-10-20',
          goal: '',
          skip_specs: false,
          retire_capabilities: false,
        },
        warnings: [],
        error: null,
      }),
      readProjectConfig: async () => ({
        found: true,
        file: 'config.yaml',
        schema: 'spec-driven',
        context: 'project context',
        rules: {},
        operations: {},
        warnings: [],
      }),
      resolveSchemaName: ({ projectConfig, fallback = 'spec-driven' }) =>
        projectConfig?.schema || fallback,
      serializeChangeMetadata: ({ schema, created }) => `schema: ${schema}\ncreated: ${created}\n`,
    },
    schema: {
      loadProjectSchemas: async () => ({ schemas: [], issues: [] }),
      resolveSchema: ({ name }) => ({
        schema: { name, artifacts: [], apply: {} },
        source: 'builtin',
        sourceVersion: '1.14.3',
        issues: [],
      }),
      loadBundledSchemas: () => new Map(),
    },
    state: {
      computeWorkspaceState: async () => workspace(),
      computeChangeState: async () => change(),
      validateChangeByName: async (cwd, name) => {
        calls.validations.push(name)
        return {
          name,
          validation: cleanValidation(),
          metadata: {},
          schemaName: 'spec-driven',
          deltas: [],
          tasks: { total: 0, done: 0, items: [], issues: [] },
        }
      },
    },
    merge: {
      planSync: (input) => {
        calls.planSync.push(input)
        return {
          ok: true,
          issues: [],
          writes: [{ path: 'openspec/specs/cap/spec.md', action: 'update', summary: 'add one' }],
          summary: { ADDED: 1, MODIFIED: 0, REMOVED: 0, RENAMED: 0 },
        }
      },
      previewSyncPlan: () => ({ text: 'SYNC_PREVIEW', files: ['openspec/specs/cap/spec.md'] }),
      applySyncPlan: async (input) => {
        calls.applySyncPlan.push(input)
        return { written: ['openspec/specs/cap/spec.md'] }
      },
    },
    archive: {
      planArchive: (input) => {
        calls.planArchive.push(input)
        return {
          ok: true,
          issues: [],
          archiveRel: 'openspec/changes/archive/2026-10-20-add-x',
          write: input.syncPlan,
          move: { from: 'openspec/changes/add-x', to: 'openspec/changes/archive/2026-10-20-add-x' },
        }
      },
      previewArchive: () => ({
        text: 'ARCHIVE_PREVIEW',
        target: 'openspec/changes/archive/2026-10-20-add-x',
      }),
      executeArchive: async (input) => {
        calls.executeArchive.push(input)
        return { moved: true, target: 'openspec/changes/archive/2026-10-20-add-x' }
      },
    },
    orchestration: {
      readProgram: async (cwd, id) => {
        calls.role = { program: id }
        return {
          id,
          title: '技能系统',
          goal: '新增技能',
          roles: {},
          tasks: [{ id: 'fireball', change: 'add-fireball', title: '火球术', dependsOn: [] }],
        }
      },
      evaluateProgram: async (cwd, program) => ({
        ...program,
        tasks: program.tasks.map((task) => ({
          ...task,
          roles: {
            product: { done: false, ready: true, missing: [] },
            design: { done: false, ready: false, missing: ['等待产品规格'] },
            dev: { done: false, ready: false, missing: ['等待产品规格'] },
            test: { done: false, ready: false, missing: ['等待开发完成全部 tasks'] },
          },
        })),
      }),
      buildRolePrompt: async (cwd, program, task, role) => {
        calls.role = { ...(calls.role ?? {}), task: task.id, role }
        return 'ROLE_PROMPT'
      },
      readPlanDraft: async (cwd, id) => {
        calls.planDraft = id
        return { id, goal: '技能系统', roles: {}, created: '2026-10-23' }
      },
      buildPlanPrompt: async (cwd, draft) => {
        calls.plan = draft
        return 'PLAN_PROMPT'
      },
      buildPmPrompt: async (cwd, program) => {
        calls.pm = program.id
        return 'PM_PROMPT'
      },
    },
    prompts: {
      slugify: (raw) =>
        String(raw ?? '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
      firstToken: (raw) => {
        const text = String(raw ?? '').trim()
        const index = text.search(/\s/)
        return index === -1 ? text : text.slice(0, index)
      },
      restAfterFirstToken: (raw) => {
        const text = String(raw ?? '').trim()
        const index = text.search(/\s/)
        return index === -1 ? '' : text.slice(index + 1).trim()
      },
      buildExplorePrompt: async (input) => {
        calls.prompt.explore = input
        return 'EXPLORE_PROMPT'
      },
      buildProposePrompt: async (input) => {
        calls.prompt.propose = input
        return 'PROPOSE_PROMPT'
      },
      buildAutoProposePrompt: async (input) => {
        calls.prompt.autoPropose = input
        return 'AUTO_PROPOSE_PROMPT'
      },
      buildApplyPrompt: async (input) => {
        calls.prompt.apply = input
        return 'APPLY_PROMPT'
      },
      buildUpdatePrompt: async (input) => {
        calls.prompt.update = input
        return 'UPDATE_PROMPT'
      },
      buildSyncWorkflowPrompt: async (input) => {
        calls.prompt.syncWorkflow = input
        return 'SYNC_WORKFLOW_PROMPT'
      },
      buildArchiveWorkflowPrompt: async (input) => {
        calls.prompt.archiveWorkflow = input
        return 'ARCHIVE_WORKFLOW_PROMPT'
      },
    },
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      deps[key] = { ...deps[key], ...value }
    } else {
      deps[key] = value
    }
  }

  const registry = new Map()
  const ctx = {
    workingDirectory: { ensure: async () => CWD, get: () => CWD },
    commands: {
      register(spec) {
        registry.set(spec.name, spec)
      },
    },
    get(key) {
      return key === 'sessionTitle' ? titles ?? undefined : undefined
    },
  }
  registerCommands(ctx, deps)

  /** Invoke one registered command handler as the host would. */
  async function run(name, rawInput = '') {
    const spec = registry.get(name)
    assert.ok(spec, `command ${name} must be registered`)
    return spec.handler({ commandId: name, agent, rawInput, attachments: [], signal: undefined })
  }

  return { calls, deps, ctx, registry, agent, run }
}

test('registers the twelve command family with kebab-case mapping in descriptions', () => {
  const { registry } = createHarness()
  assert.deepEqual([...registry.keys()].sort(), COMMAND_IDS)

  for (const name of COMMAND_IDS) {
    const spec = registry.get(name)
    assert.equal(typeof spec.handler, 'function')
    assert.match(spec.description, /OpenSpec/)
    // `opsx-role` / `opsx-plan` / `opsx-pm` are plugin-only orchestration commands.
    if (name.startsWith('opsx-') && name !== 'opsx-role' && name !== 'opsx-plan' && name !== 'opsx-pm') {
      assert.match(spec.description, /不能含冒号/)
    }
  }

  // Every native `/opsx:*` core command maps to a kebab-case DSH name.
  for (const phase of ['explore', 'propose', 'apply', 'update', 'sync', 'archive', 'validate', 'status']) {
    const description = registry.get(`opsx-${phase}`).description
    assert.match(description, new RegExp(`/opsx:${phase}`))
    assert.match(description, new RegExp(`/opsx-${phase}`))
  }
  assert.match(registry.get('openspec-init').description, /openspec init/)
})

test('opsx-role submits a ready role prompt and titles the role session', async () => {
  const h = createHarness()
  const result = await h.run('opsx-role', 'skills fireball product')
  assert.equal(result.kind, 'success')
  assert.equal(h.agent.messages.length, 1)
  assert.equal(h.agent.messages[0].content[0].text, 'ROLE_PROMPT')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[产品] 火球术' }])
})

test('opsx-role refuses a waiting role gate unless --force is given', async () => {
  const h = createHarness()
  const refused = await h.run('opsx-role', 'skills fireball design')
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /尚未就绪/)
  assert.match(refused.text, /等待产品规格/)
  assert.equal(h.agent.messages.length, 0)

  const forced = await h.run('opsx-role', 'skills fireball design --force')
  assert.equal(forced.kind, 'success')
  assert.equal(h.agent.messages.length, 1)
})

test('opsx-plan submits the planner prompt for a saved draft', async () => {
  const h = createHarness()
  const result = await h.run('opsx-plan', 'auto-abc')
  assert.equal(result.kind, 'success')
  assert.equal(h.calls.planDraft, 'auto-abc')
  assert.equal(h.agent.messages.length, 1)
  assert.equal(h.agent.messages[0].content[0].text, 'PLAN_PROMPT')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[规划] 技能系统' }])
})

test('opsx-pm submits a PM oversight prompt', async () => {
  const h = createHarness()
  const result = await h.run('opsx-pm', 'skills')
  assert.equal(result.kind, 'success')
  assert.equal(h.calls.pm, 'skills')
  assert.equal(h.agent.messages.length, 1)
  assert.equal(h.agent.messages[0].content[0].text, 'PM_PROMPT')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[PM] 技能系统' }])
})

test('openspec-init is direct and reports only newly created items', async () => {
  const createdHarness = createHarness({
    init: {
      ensureSkeleton: async () => ({
        created: ['openspec/config.yaml', 'openspec/specs/', 'openspec/changes/archive/'],
        configContent: 'schema: spec-driven\n',
      }),
    },
  })
  const created = await createdHarness.run('openspec-init')
  assert.equal(created.kind, 'success')
  assert.match(created.text, /新建/)
  assert.match(created.text, /openspec\/config\.yaml/)
  assert.equal(createdHarness.agent.messages.length, 0)

  const idempotent = createHarness()
  const again = await idempotent.run('openspec-init')
  assert.equal(again.kind, 'success')
  assert.match(again.text, /已初始化过/)
  assert.equal(idempotent.agent.messages.length, 0)
})

test('opsx-status is a direct native state output', async () => {
  const h = createHarness()
  const result = await h.run('opsx-status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /OpenSpec 工作区状态/)
  assert.match(result.text, /add-x/)
  assert.match(result.text, /artifacts：proposal 已完成/)
  assert.match(result.text, /design 可创建/)
  assert.match(result.text, /任务 1\/3/)
  assert.match(result.text, /已归档：2 个变更/)
  assert.match(result.text, /主 specs：1 个 capability/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-status and opsx-validate handle an uninitialized workspace directly', async () => {
  const h = createHarness({ state: { computeWorkspaceState: async () => ({ status: 'missing' }) } })
  const status = await h.run('opsx-status')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /\/openspec-init/)
  const validate = await h.run('opsx-validate')
  assert.equal(validate.kind, 'success')
  assert.match(validate.text, /没有可校验的内容/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-validate <name> prints native issues and statistics directly', async () => {
  const h = createHarness({
    state: {
      validateChangeByName: async (cwd, name) => ({
        name,
        validation: cleanValidation({
          errors: 1,
          warnings: 1,
          issues: [
            { level: 'WARNING', path: 'proposal.md', line: 7, message: 'Why section is short' },
            { level: 'ERROR', path: 'specs/cap/spec.md', line: 12, message: 'missing scenario' },
          ],
        }),
        metadata: {},
        schemaName: 'spec-driven',
        deltas: [],
        tasks: null,
      }),
    },
  })
  const result = await h.run('opsx-validate', 'add-x')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /1 ERROR \/ 1 WARNING \/ 0 INFO/)
  assert.match(result.text, /\[ERROR\] specs\/cap\/spec\.md:12 — missing scenario/)
  assert.match(result.text, /\[WARNING\] proposal\.md:7 — Why section is short/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-validate aggregates every active change and the main specs', async () => {
  const h = createHarness()
  const result = await h.run('opsx-validate')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /OpenSpec 校验（工作区）/)
  assert.match(result.text, /add-x：0 ERROR \/ 0 WARNING \/ 0 INFO/)
  assert.match(result.text, /主 specs：1 个 capability/)
  assert.match(result.text, /统计：0 ERROR \/ 0 WARNING \/ 0 INFO/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-validate with an unknown change lists active candidates', async () => {
  const h = createHarness()
  const result = await h.run('opsx-validate', 'no-such-change')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /找不到变更 "no-such-change"/)
  assert.match(result.text, /add-x/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-propose rejects an invalid change name before touching disk', async () => {
  const h = createHarness()
  const result = await h.run('opsx-propose', '!!!')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法：\/opsx-propose/)
  assert.equal(h.calls.writes.length, 0)
  assert.equal(h.agent.messages.length, 0)
  assert.equal(h.calls.order.some(([step]) => step === 'ensureSkeleton'), false)
})

test('opsx-propose initializes first, writes native metadata, then submits the plan prompt', async () => {
  const h = createHarness()
  const result = await h.run('opsx-propose', 'add-x 支持深色主题')

  assert.equal(result.kind, 'success')
  assert.equal(h.calls.writes.length, 1)
  const [metadataPath, metadataText] = h.calls.writes[0]
  assert.equal(metadataPath, 'openspec/changes/add-x/.openspec.yaml')
  assert.equal(metadataText, 'schema: spec-driven\ncreated: 2026-10-20\n')
  assert.match(result.text, /已创建 openspec\/changes\/add-x\/\.openspec\.yaml/)
  assert.match(result.text, /schema：spec-driven/)
  assert.match(result.text, /created：2026-10-20/)
  assert.match(result.text, /只写计划不写代码|不会写产品代码/)

  // Init → metadata write → prompt submission; the metadata exists before the model message.
  const steps = h.calls.order.map(([step]) => step)
  const initIndex = steps.indexOf('ensureSkeleton')
  const writeIndex = steps.indexOf('writeText')
  const followupIndex = steps.indexOf('followup')
  assert.ok(initIndex >= 0 && writeIndex > initIndex && followupIndex > writeIndex, steps.join(' > '))

  // Plan-only prompt was composed from the native schema + ChangeState.
  const promptArgs = h.calls.prompt.propose
  assert.equal(promptArgs.changeName, 'add-x')
  assert.equal(promptArgs.intent, '支持深色主题')
  assert.ok(promptArgs.schema?.schema, 'resolved schema wrapper is passed to prompts.js')
  assert.equal(promptArgs.config.schema, 'spec-driven')
  assert.equal(promptArgs.change.name, 'add-x')

  // The submitted message is the ordinary user-message shape.
  assert.equal(h.agent.messages.length, 1)
  const message = h.agent.messages[0]
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'PROPOSE_PROMPT' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('opsx-propose reports the idempotent initialization it performed', async () => {
  const h = createHarness({
    init: {
      ensureSkeleton: async () => ({ created: ['openspec/config.yaml', 'openspec/changes/archive/'], configContent: '' }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x 主题')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已先初始化 openspec\/ 骨架/)
  assert.match(result.text, /openspec\/config\.yaml/)
  assert.equal(h.calls.writes.length, 1)
})

test('opsx-propose resumes an incomplete existing change without rewriting metadata', async () => {
  const h = createHarness({
    fs: { pathExists: async (cwd, rel) => rel === 'openspec/changes/add-x' },
  })
  const result = await h.run('opsx-propose', 'add-x 补充设计')

  assert.equal(result.kind, 'success')
  assert.match(result.text, /已存在，规划未完成/)
  assert.match(result.text, /续做/)
  assert.match(result.text, /已有工件：proposal、specs、tasks/)
  assert.match(result.text, /待补齐：design/)
  assert.equal(h.calls.writes.length, 0, 'an existing .openspec.yaml is never rewritten')
  assert.equal(h.calls.prompt.propose.resume, true)
  assert.equal(h.calls.prompt.propose.intent, '补充设计')

  // The resume prompt is submitted as an ordinary user message and titles the phase.
  assert.equal(h.agent.messages.length, 1)
  assert.deepEqual(h.agent.messages[0].content, [{ type: 'text', text: 'PROPOSE_PROMPT' }])
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[提案] add-x' }])
})

test('opsx-propose resumes a change that only has native metadata', async () => {
  const h = createHarness({
    fs: { pathExists: async () => true },
    state: {
      computeChangeState: async () =>
        change({
          isPlanningComplete: false,
          artifacts: [
            { id: 'proposal', outputPath: 'proposal.md', status: 'ready' },
            { id: 'specs', outputPath: 'specs', status: 'blocked', missingDeps: ['proposal'] },
            { id: 'design', outputPath: 'design.md', status: 'blocked', missingDeps: ['proposal'] },
            { id: 'tasks', outputPath: 'tasks.md', status: 'blocked', missingDeps: ['specs', 'design'] },
          ],
          nextSteps: ['create proposal (proposal.md)'],
        }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x 测试')

  assert.equal(result.kind, 'success')
  assert.equal(h.calls.prompt.propose.resume, true)
  assert.match(result.text, /已有工件：无/)
  assert.match(result.text, /待补齐：proposal（可创建）/)
  assert.equal(h.agent.messages.length, 1)
})

test('opsx-propose returns direct next-step guidance for a complete plan', async () => {
  const h = createHarness({
    fs: { pathExists: async () => true },
    state: {
      computeChangeState: async () =>
        change({ isPlanningComplete: true, listStatus: 'in-progress', tasks: { total: 3, done: 1 } }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x 主题')

  assert.equal(result.kind, 'success')
  assert.match(result.text, /规划工件已全部完成/)
  assert.match(result.text, /\/opsx-apply add-x/)
  assert.match(result.text, /\/opsx-update add-x/)
  assert.equal(h.agent.messages.length, 0, 'a complete plan submits no model message')
  assert.deepEqual(h.calls.titles, [])
  assert.equal(h.calls.writes.length, 0)
})

test('opsx-propose reports validation errors for a complete plan', async () => {
  const h = createHarness({
    fs: { pathExists: async () => true },
    state: {
      computeChangeState: async () =>
        change({
          isPlanningComplete: true,
          listStatus: 'no-tasks',
          validation: {
            errors: 1,
            warnings: 0,
            infos: 0,
            issues: [{ level: 'ERROR', path: 'specs/cap/spec.md', message: 'missing scenario' }],
          },
        }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x')

  assert.equal(result.kind, 'success')
  assert.match(result.text, /1 个 ERROR/)
  assert.match(result.text, /\/opsx-update add-x/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-propose completes a missing .openspec.yaml once and resumes', async () => {
  const h = createHarness({
    fs: { pathExists: async () => true },
    metadata: {
      readChangeMetadata: async () => ({ found: false, metadata: {}, warnings: [], error: null }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x')

  assert.equal(result.kind, 'success')
  assert.equal(h.calls.writes.length, 1)
  assert.equal(h.calls.writes[0][0], 'openspec/changes/add-x/.openspec.yaml')
  assert.match(h.calls.writes[0][1], /schema: spec-driven/)
  assert.match(result.text, /续做/)
  assert.equal(h.agent.messages.length, 1)
})

test('opsx-propose refuses invalid change metadata without overwriting it', async () => {
  const h = createHarness({
    fs: { pathExists: async () => true },
    metadata: {
      readChangeMetadata: async () => ({
        found: true,
        metadata: {},
        warnings: [],
        error: { message: 'invalid YAML: bad indentation', line: 3 },
      }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x')

  assert.equal(result.kind, 'error')
  assert.match(result.text, /元数据/)
  assert.match(result.text, /无法解析/)
  assert.match(result.text, /第 3 行/)
  assert.equal(h.calls.writes.length, 0)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-propose writes the schema configured by the project', async () => {
  const h = createHarness({
    metadata: {
      readProjectConfig: async () => ({
        found: true,
        file: 'config.yaml',
        schema: 'team-schema',
        context: '',
        rules: {},
        operations: {},
        warnings: [],
      }),
      resolveSchemaName: ({ projectConfig, fallback = 'spec-driven' }) =>
        projectConfig?.schema || fallback,
    },
    schema: {
      resolveSchema: ({ name }) => ({
        schema: { name, artifacts: [], apply: {} },
        source: 'project',
        issues: [],
      }),
    },
  })
  const result = await h.run('opsx-propose', 'add-x 主题')
  assert.equal(result.kind, 'success')
  assert.equal(h.calls.writes[0][1], 'schema: team-schema\ncreated: 2026-10-20\n')
  assert.match(result.text, /schema：team-schema/)
})

test('opsx-propose resolves the bundled snapshot when the project schema is unknown', async () => {
  const bundledSchema = { name: 'spec-driven', artifacts: [], apply: {} }
  const h = createHarness({
    schema: {
      resolveSchema: () => ({ schema: null, source: null, issues: [{ level: 'WARNING', message: 'unknown schema' }] }),
      loadBundledSchemas: () => new Map([['spec-driven', { schema: bundledSchema, source: 'builtin' }]]),
    },
  })
  const result = await h.run('opsx-propose', 'add-x 主题')
  assert.equal(result.kind, 'success')
  assert.equal(h.calls.prompt.propose.schema.source, 'builtin')
  assert.equal(h.calls.writes.length, 1)
})

test('opsx-propose --auto submits a model naming prompt without scaffolding a guessed name', async () => {
  const h = createHarness()
  const result = await h.run('opsx-propose', '--auto 支持实时状态和人工验收')
  assert.equal(result.kind, 'success')
  assert.equal(h.calls.writes.length, 0)
  assert.equal(h.agent.messages.length, 1)
  assert.match(result.text, /自动命名提案任务/)
  assert.match(result.text, /kebab-case change 名/)
  const input = h.calls.prompt.autoPropose
  assert.equal(input.description, '支持实时状态和人工验收')
  assert.equal(input.created, '2026-10-20')
  assert.deepEqual(input.existingNames, ['add-x'])
  assert.equal(input.schema.schema.name, 'spec-driven')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[提案] 自动命名：支持实时状态和人工验收' }])
})

test('opsx-propose --auto requires a description', async () => {
  const h = createHarness()
  const result = await h.run('opsx-propose', '--auto')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /--auto <描述>/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-propose refuses before writing when no schema definition resolves', async () => {
  const h = createHarness({
    schema: {
      resolveSchema: () => ({ schema: null, source: null, issues: [] }),
      loadBundledSchemas: () => new Map(),
    },
  })
  const result = await h.run('opsx-propose', 'add-x 主题')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无法解析生效 schema/)
  assert.equal(h.calls.writes.length, 0)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-explore submits the native read-only exploration prompt', async () => {
  const h = createHarness()
  const result = await h.run('opsx-explore', '深入调查缓存层')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /探索任务/)
  assert.match(result.text, /只读/)
  assert.equal(h.calls.prompt.explore.topic, '深入调查缓存层')
  assert.equal(h.calls.prompt.explore.config.schema, 'spec-driven')
  assert.equal(h.agent.messages[0].content[0].text, 'EXPLORE_PROMPT')
})

test('opsx-apply auto-selects the single active change and submits the apply prompt', async () => {
  const h = createHarness()
  const result = await h.run('opsx-apply')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已自动选择唯一进行中的变更 add-x/)
  assert.match(result.text, /任务 1\/3/)
  assert.equal(h.agent.messages[0].content[0].text, 'APPLY_PROMPT')
  assert.equal(h.calls.prompt.apply.changeName, 'add-x')
  assert.equal(h.calls.prompt.apply.artifactPrompt, '')
})

test('opsx-apply does not gate on validation errors', async () => {
  const h = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({
          changes: [
            change({
              validation: {
                errors: 2,
                warnings: 0,
                infos: 0,
                issues: [
                  { level: 'ERROR', path: 'proposal.md', message: 'Why too short' },
                  { level: 'ERROR', path: 'tasks.md', message: 'numbering gap' },
                ],
              },
            }),
          ],
        }),
    },
  })
  const result = await h.run('opsx-apply')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /2 个 ERROR/)
  assert.match(result.text, /不阻断/)
  assert.equal(h.agent.messages.length, 1)
})

test('opsx-apply refuses ambiguous change selection and empty plans', async () => {
  const ambiguous = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({ changes: [change({ name: 'add-x' }), change({ name: 'fix-y' })] }),
    },
  })
  const candidates = await ambiguous.run('opsx-apply')
  assert.equal(candidates.kind, 'error')
  assert.match(candidates.text, /2 个进行中的变更/)
  assert.match(candidates.text, /add-x/)
  assert.match(candidates.text, /fix-y/)
  assert.equal(ambiguous.agent.messages.length, 0)

  const empty = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({
          changes: [
            change({
              artifacts: [
                { id: 'proposal', outputPath: 'proposal.md', status: 'ready' },
                { id: 'specs', outputPath: 'specs', status: 'blocked', missingDeps: ['proposal'] },
              ],
              tasks: null,
              listStatus: 'no-tasks',
            }),
          ],
        }),
    },
  })
  const refused = await empty.run('opsx-apply')
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /还没有任何规划工件/)
  assert.match(refused.text, /\/opsx-propose add-x/)
  assert.equal(empty.agent.messages.length, 0)
})

test('opsx-update submits a planning-only prompt with the revision request', async () => {
  const h = createHarness()
  const result = await h.run('opsx-update', 'add-x 完善 proposal 的 Why 部分')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已发送修订任务：add-x/)
  assert.match(result.text, /不会改产品代码/)
  assert.match(result.text, /\/opsx-apply add-x/)
  assert.equal(h.calls.prompt.update.changeName, 'add-x')
  assert.equal(h.calls.prompt.update.intent, '完善 proposal 的 Why 部分')
  assert.equal(h.agent.messages[0].content[0].text, 'UPDATE_PROMPT')
})

test('opsx-explore titles the session with the exploration topic', async () => {
  const h = createHarness()
  await h.run('opsx-explore', '深入调查缓存层')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[探索] 深入调查缓存层' }])
})

test('opsx-explore without a topic keeps only the phase prefix', async () => {
  const h = createHarness()
  await h.run('opsx-explore')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[探索]' }])
})

test('opsx-propose titles the session with the normalized change name', async () => {
  const h = createHarness()
  await h.run('opsx-propose', 'Add-Dark-Mode 支持深色主题')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[提案] add-dark-mode' }])
})

test('opsx-apply titles the session with the auto-selected change', async () => {
  const h = createHarness()
  await h.run('opsx-apply')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[实施] add-x' }])
})

test('opsx-update titles the session with the change name', async () => {
  const h = createHarness()
  await h.run('opsx-update', 'add-x 完善 proposal 的 Why 部分')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[更新] add-x' }])
})

test('opsx-update refuses a target artifact that does not exist yet', async () => {
  const h = createHarness()
  const result = await h.run('opsx-update', 'add-x 补一下 design 的技术决策')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /design/)
  assert.match(result.text, /尚不存在/)
  assert.match(result.text, /propose/)
  assert.match(result.text, /不会凭空创建/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-update returns candidates when several changes are active and none named', async () => {
  const h = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({ changes: [change({ name: 'add-x' }), change({ name: 'fix-y' })] }),
    },
  })
  const result = await h.run('opsx-update', '改一下 proposal')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /请指定名称/)
  assert.match(result.text, /add-x/)
  assert.match(result.text, /fix-y/)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-sync --dry-run previews without writing and normalizes delta paths', async () => {
  const h = createHarness({
    state: {
      validateChangeByName: async (cwd, name) => ({
        name,
        validation: cleanValidation(),
        metadata: {},
        schemaName: 'spec-driven',
        deltas: [{ path: 'specs/cap/spec.md', text: 'delta text', parsed: { operations: {} } }],
        tasks: null,
      }),
    },
  })
  const result = await h.run('opsx-sync', 'add-x --dry-run')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /同步预览/)
  assert.match(result.text, /SYNC_PREVIEW/)
  assert.match(result.text, /未写入任何文件/)
  assert.match(result.text, /\/opsx-sync add-x --yes/)
  assert.equal(h.calls.applySyncPlan.length, 0)
  assert.equal(h.calls.planSync.length, 1)
  assert.equal(h.agent.messages.length, 0, '--dry-run never submits a model message')

  const planInput = h.calls.planSync[0]
  assert.equal(planInput.changeName, 'add-x')
  assert.equal(planInput.retireCapabilities, false)
  assert.deepEqual(planInput.mainSpecs, [{ path: 'openspec/specs/cap/spec.md', text: '# Main Spec\n' }])
  assert.equal(planInput.deltas[0].path, 'openspec/changes/add-x/specs/cap/spec.md')
})

test('opsx-sync default submits the OPSX AI workflow, plans nothing and writes nothing', async () => {
  const h = createHarness({
    state: {
      validateChangeByName: async (cwd, name) => ({
        name,
        validation: cleanValidation({
          warnings: 1,
          issues: [{ level: 'WARNING', path: 'tasks.md', line: 2, message: 'task numbering gap' }],
        }),
        metadata: {},
        schemaName: 'spec-driven',
        deltas: [
          {
            path: 'specs/cap/spec.md',
            text: 'delta text',
            parsed: { operations: { ADDED: [{}], MODIFIED: [], REMOVED: [], RENAMED: [] } },
          },
        ],
        tasks: { total: 3, done: 1, items: [{ id: '1.1', text: 'first', done: true }, { id: '1.2', text: 'second', done: false }] },
      }),
    },
  })
  const result = await h.run('opsx-sync', 'add-x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已发送 OPSX 同步工作流：add-x/)
  assert.match(result.text, /命令本身没有写入任何文件/)
  assert.match(result.text, /1 个 WARNING/)

  // The workflow prompt was composed from engine facts instead of a merge plan.
  const args = h.calls.prompt.syncWorkflow
  assert.equal(args.changeName, 'add-x')
  assert.ok(args.schema?.schema, 'resolved schema wrapper is passed to the workflow builder')
  assert.equal(args.config.schema, 'spec-driven')
  assert.equal(args.change.name, 'add-x')
  assert.equal(args.facts.validation.warnings, 1)
  assert.deepEqual(args.facts.artifacts[0], { id: 'proposal', status: 'done' })
  assert.deepEqual(args.facts.tasks, { total: 3, done: 1, pending: ['second'] })
  assert.equal(args.facts.deltas.length, 1)
  assert.equal(args.facts.deltas[0].path, 'openspec/changes/add-x/specs/cap/spec.md')
  assert.equal(args.facts.deltas[0].capability, 'cap')
  assert.equal(args.facts.deltas[0].added, 1)
  assert.deepEqual(args.facts.mainSpecs, [
    { path: 'openspec/specs/cap/spec.md', capability: 'cap', exists: true, requirementCount: 1 },
  ])
  assert.equal(args.facts.isPlanningComplete, false)
  assert.equal(args.facts.archiveTarget, null)

  assert.equal(h.calls.planSync.length, 0, 'the AI path composes no deterministic plan')
  assert.equal(h.calls.applySyncPlan.length, 0)
  assert.equal(h.calls.writes.length, 0)

  // The submitted message is the ordinary user-message shape.
  assert.equal(h.agent.messages.length, 1)
  const message = h.agent.messages[0]
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'SYNC_WORKFLOW_PROMPT' }])
})

test('opsx-sync --yes applies the merge and reports written files', async () => {
  const h = createHarness()
  const result = await h.run('opsx-sync', '--yes add-x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已同步变更 add-x 的主 specs/)
  assert.match(result.text, /已写入 1 个主 spec 文件/)
  assert.match(result.text, /openspec\/specs\/cap\/spec\.md/)
  assert.equal(h.calls.applySyncPlan.length, 1)
  assert.equal(h.calls.planSync[0].changeName, 'add-x')
  assert.equal(h.agent.messages.length, 0)
  assert.equal(h.calls.prompt.syncWorkflow, undefined, 'deterministic path produces no AI workflow prompt')
})

test('opsx-sync submits the AI workflow on a validation ERROR and refuses only the deterministic paths', async () => {
  const invalidState = {
    validateChangeByName: async (cwd, name) => ({
      name,
      validation: cleanValidation({
        errors: 1,
        issues: [{ level: 'ERROR', path: 'proposal.md', line: 4, message: 'Why is empty' }],
      }),
      metadata: {},
      schemaName: 'spec-driven',
      deltas: [],
      tasks: null,
    }),
  }

  // AI (default) path: the workflow prompt is submitted together with the
  // ERROR facts, so the model can stop and report. The command itself returns
  // success and writes nothing; the DSH hero page therefore gets a visible
  // model turn instead of a direct result that has no transcript to render in.
  const aiPath = createHarness({ state: invalidState })
  const aiResult = await aiPath.run('opsx-sync', 'add-x')
  assert.equal(aiResult.kind, 'success')
  assert.match(aiResult.text, /已发送 OPSX 同步工作流：add-x/)
  assert.match(aiResult.text, /1 个 ERROR/)
  assert.match(aiResult.text, /AI 会先停止并报告/)
  assert.equal(aiPath.agent.messages.length, 1)
  assert.deepEqual(aiPath.agent.messages[0].content, [{ type: 'text', text: 'SYNC_WORKFLOW_PROMPT' }])
  const args = aiPath.calls.prompt.syncWorkflow
  assert.equal(args.facts.validation.errors, 1, 'the ERROR count reaches the workflow facts')
  assert.equal(args.facts.validation.issues[0].message, 'Why is empty', 'the ERROR issue reaches the workflow facts')
  assert.equal(aiPath.calls.planSync.length, 0, 'the AI path composes no deterministic plan')
  assert.equal(aiPath.calls.applySyncPlan.length, 0)
  assert.equal(aiPath.calls.writes.length, 0)
  assert.deepEqual(aiPath.calls.titles, [{ sessionId: 'session-test', title: '[同步] add-x' }])

  // Deterministic paths: the validation gate still refuses before any work and
  // produces no model message.
  for (const flags of ['--yes', '--dry-run']) {
    const deterministic = createHarness({ state: invalidState })
    const refused = await deterministic.run('opsx-sync', `add-x ${flags}`)
    assert.equal(refused.kind, 'error', `sync ${flags} must still refuse on validation ERROR`)
    assert.match(refused.text, /拒绝同步/)
    assert.match(refused.text, /\[ERROR\] proposal\.md:4 — Why is empty/)
    assert.equal(deterministic.calls.prompt.syncWorkflow, undefined)
    assert.equal(deterministic.calls.planSync.length, 0)
    assert.equal(deterministic.calls.applySyncPlan.length, 0)
    assert.equal(deterministic.agent.messages.length, 0)
    assert.deepEqual(deterministic.calls.titles, [])
  }
})

test('opsx-sync reports validation WARNINGs without blocking the write', async () => {
  const h = createHarness({
    state: {
      validateChangeByName: async (cwd, name) => ({
        name,
        validation: cleanValidation({
          warnings: 1,
          issues: [{ level: 'WARNING', path: 'tasks.md', line: 2, message: 'task numbering gap' }],
        }),
        metadata: {},
        schemaName: 'spec-driven',
        deltas: [],
        tasks: null,
      }),
    },
  })
  const result = await h.run('opsx-sync', 'add-x --yes')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /1 个 WARNING/)
  assert.match(result.text, /\[WARNING\] tasks\.md:2 — task numbering gap/)
  assert.equal(h.calls.applySyncPlan.length, 1)
})

test('opsx-sync refuses an unsafe merge plan', async () => {
  const h = createHarness({
    merge: {
      planSync: () => ({
        ok: false,
        issues: [{ level: 'ERROR', path: 'specs/cap/spec.md', message: 'ADDED requirement already exists' }],
        writes: [],
      }),
    },
  })
  const result = await h.run('opsx-sync', 'add-x --yes')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未写入任何文件/)
  assert.match(result.text, /ADDED requirement already exists/)
  assert.equal(h.calls.applySyncPlan.length, 0)
})

test('opsx-sync reports skip_specs without planning a merge or submitting a prompt', async () => {
  const h = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({
          changes: [change({ metadata: { found: true, schema: 'spec-driven', skip_specs: true } })],
        }),
    },
  })
  const result = await h.run('opsx-sync', 'add-x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /skip_specs/)
  assert.match(result.text, /无需执行 sync/)
  assert.equal(h.calls.planSync.length, 0)
  assert.equal(h.agent.messages.length, 0)
})

/** validateChangeByName fake with pending tasks, shared by the incomplete-task tests. */
function pendingTasksValidation() {
  return async (cwd, name) => ({
    name,
    validation: cleanValidation(),
    metadata: {},
    schemaName: 'spec-driven',
    deltas: [],
    tasks: {
      total: 3,
      done: 1,
      items: [
        { id: '1.1', text: '1.1 create types', done: true, depth: 0 },
        { id: '1.2', text: 'build parser', done: false, depth: 0 },
        { id: '2', text: '2 write tests', done: false, depth: 0 },
      ],
    },
  })
}

test('opsx-archive default submits the OPSX AI workflow with completion facts and moves nothing', async () => {
  const h = createHarness({ state: { validateChangeByName: pendingTasksValidation() } })
  const result = await h.run('opsx-archive', 'add-x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已发送 OPSX 归档工作流：add-x/)
  assert.match(result.text, /归档目标 openspec\/changes\/archive\/2026-10-20-add-x/)
  assert.match(result.text, /2 项任务未完成（1\/3）/)
  assert.match(result.text, /命令本身没有写入或移动任何文件/)

  const args = h.calls.prompt.archiveWorkflow
  assert.equal(args.changeName, 'add-x')
  assert.ok(args.schema?.schema)
  assert.equal(args.change.name, 'add-x')
  assert.equal(args.facts.isPlanningComplete, false)
  assert.equal(args.facts.archiveTarget, 'openspec/changes/archive/2026-10-20-add-x')
  assert.equal(args.facts.archiveTargetExists, false)
  assert.deepEqual(args.facts.tasks, { total: 3, done: 1, pending: ['build parser', '2 write tests'] })
  assert.deepEqual(args.facts.artifacts.map((row) => row.id), ['proposal', 'specs', 'design', 'tasks'])

  assert.equal(h.calls.planSync.length, 0, 'the AI path composes no deterministic merge plan')
  assert.equal(h.calls.planArchive.length, 0)
  assert.equal(h.calls.executeArchive.length, 0)

  assert.equal(h.agent.messages.length, 1)
  assert.equal(h.agent.messages[0].role, 'user')
  assert.deepEqual(h.agent.messages[0].content, [{ type: 'text', text: 'ARCHIVE_WORKFLOW_PROMPT' }])
})

test('opsx-archive --dry-run previews without moving anything and passes the merge plan', async () => {
  const h = createHarness()
  const result = await h.run('opsx-archive', 'add-x --dry-run')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /归档预览/)
  assert.match(result.text, /ARCHIVE_PREVIEW/)
  assert.match(result.text, /未写入或移动任何文件/)
  assert.match(result.text, /\/opsx-archive add-x --yes/)
  assert.equal(h.calls.executeArchive.length, 0)
  assert.equal(h.calls.planSync.length, 1)
  assert.equal(h.agent.messages.length, 0, '--dry-run never submits a model message')

  const planInput = h.calls.planArchive[0]
  assert.equal(planInput.changeName, 'add-x')
  assert.equal(planInput.localDate, '2026-10-20')
  assert.equal(planInput.targetExists, false)
  assert.equal(planInput.metadata.schema, 'spec-driven')
  assert.ok(planInput.syncPlan?.ok)
})

test('opsx-archive --yes warns about incomplete tasks and continues (upstream CLI parity)', async () => {
  const h = createHarness({ state: { validateChangeByName: pendingTasksValidation() } })
  const result = await h.run('opsx-archive', 'add-x --yes')
  assert.equal(result.kind, 'success', 'incomplete tasks no longer block the deterministic archive')
  assert.match(result.text, /警告/)
  assert.match(result.text, /2 项任务未完成（1\/3）/)
  assert.match(result.text, /1\.2 build parser/)
  assert.match(result.text, /2 write tests/)
  assert.equal(result.text.includes('2 2 write tests'), false, 'the parser keeps the id inside the text; do not duplicate it')
  assert.match(result.text, /已归档变更 add-x → openspec\/changes\/archive\/2026-10-20-add-x/)
  assert.equal(h.calls.executeArchive.length, 1)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-archive --dry-run warns about incomplete tasks but still only previews', async () => {
  const h = createHarness({ state: { validateChangeByName: pendingTasksValidation() } })
  const result = await h.run('opsx-archive', '--dry-run add-x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /归档预览/)
  assert.match(result.text, /2 项任务未完成（1\/3）/)
  assert.equal(h.calls.executeArchive.length, 0)
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-archive --yes executes the archive and reports the target', async () => {
  const h = createHarness()
  const result = await h.run('opsx-archive', '--yes add-x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已归档变更 add-x → openspec\/changes\/archive\/2026-10-20-add-x/)
  assert.match(result.text, /已同步主 specs/)
  assert.match(result.text, /\.openspec\.yaml/)
  assert.equal(h.calls.executeArchive.length, 1)
  assert.equal(h.calls.executeArchive[0].cwd, CWD)
  assert.equal(h.calls.executeArchive[0].plan.ok, true)
  assert.equal(h.agent.messages.length, 0, 'the deterministic archive produces no model message')
  assert.equal(h.calls.prompt.archiveWorkflow, undefined)
})

test('opsx-archive --yes --skip-specs only moves the change and writes no main spec', async () => {
  const h = createHarness()
  const result = await h.run('opsx-archive', 'add-x --yes --skip-specs')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已归档变更 add-x/)
  assert.match(result.text, /--skip-specs：未写入主 specs，只移动 change 目录/)
  assert.equal(h.calls.planSync.length, 0, 'skip-specs never plans a merge')
  assert.equal(h.calls.planArchive.length, 1)

  const planInput = h.calls.planArchive[0]
  assert.equal(planInput.syncPlan, null)
  assert.equal(planInput.metadata.skip_specs, true, 'the archive plan sees skip_specs: true metadata')
  assert.equal(planInput.metadata.schema, 'spec-driven', 'the rest of the change metadata is preserved')
  assert.equal(h.calls.executeArchive.length, 1)
  assert.equal(h.calls.executeArchive[0].plan.write, null, 'executeArchive receives a plan with no main-spec write')
  assert.equal(h.agent.messages.length, 0)
})

test('opsx-archive submits the AI workflow on validation ERROR or an existing target and refuses only the deterministic paths', async () => {
  const invalidState = {
    validateChangeByName: async (cwd, name) => ({
      name,
      validation: cleanValidation({
        errors: 1,
        issues: [{ level: 'ERROR', path: 'specs/cap/spec.md', message: 'removed requirement missing reason' }],
      }),
      metadata: {},
      schemaName: 'spec-driven',
      deltas: [],
      tasks: { total: 1, done: 1, items: [] },
    }),
  }

  // AI (default) path with both blockers: the workflow prompt is submitted with
  // the ERROR facts and the archive-target collision fact, so the model can
  // stop and report. The command itself writes/moves nothing.
  const blocked = createHarness({
    state: invalidState,
    fs: { pathExists: async (cwd, rel) => rel.startsWith('openspec/changes/archive/') },
  })
  const aiBlocked = await blocked.run('opsx-archive', 'add-x')
  assert.equal(aiBlocked.kind, 'success')
  assert.match(aiBlocked.text, /已发送 OPSX 归档工作流：add-x/)
  assert.match(aiBlocked.text, /1 个 ERROR/)
  assert.match(aiBlocked.text, /AI 会先停止并报告/)
  assert.match(aiBlocked.text, /已存在/)
  assert.match(aiBlocked.text, /不会合并主 specs/)
  assert.equal(blocked.agent.messages.length, 1)
  assert.deepEqual(blocked.agent.messages[0].content, [{ type: 'text', text: 'ARCHIVE_WORKFLOW_PROMPT' }])
  const args = blocked.calls.prompt.archiveWorkflow
  assert.equal(args.facts.validation.errors, 1, 'the ERROR count reaches the workflow facts')
  assert.equal(args.facts.archiveTargetExists, true, 'the archive-target collision reaches the workflow facts')
  assert.equal(blocked.calls.planSync.length, 0, 'the AI path composes no deterministic merge plan')
  assert.equal(blocked.calls.planArchive.length, 0)
  assert.equal(blocked.calls.executeArchive.length, 0)
  assert.deepEqual(blocked.calls.titles, [{ sessionId: 'session-test', title: '[归档] add-x' }])

  // Deterministic paths: validation ERROR still refuses before any work and
  // produces no model message.
  for (const flags of ['--yes', '--dry-run']) {
    const deterministic = createHarness({ state: invalidState })
    const refused = await deterministic.run('opsx-archive', `add-x ${flags}`)
    assert.equal(refused.kind, 'error', `archive ${flags} must still refuse on validation ERROR`)
    assert.match(refused.text, /拒绝归档/)
    assert.equal(deterministic.calls.prompt.archiveWorkflow, undefined)
    assert.equal(deterministic.calls.planArchive.length, 0)
    assert.equal(deterministic.calls.executeArchive.length, 0)
    assert.equal(deterministic.agent.messages.length, 0)
    assert.deepEqual(deterministic.calls.titles, [])
  }

  // Deterministic paths: an existing archive target still refuses before any work.
  for (const flags of ['--yes', '--dry-run']) {
    const existing = createHarness({
      fs: { pathExists: async (cwd, rel) => rel.startsWith('openspec/changes/archive/') },
    })
    const collision = await existing.run('opsx-archive', `add-x ${flags}`)
    assert.equal(collision.kind, 'error')
    assert.match(collision.text, /归档目标 .* 已存在/)
    assert.equal(existing.calls.planArchive.length, 0)
    assert.equal(existing.calls.executeArchive.length, 0)
    assert.equal(existing.agent.messages.length, 0)
  }
})

test('opsx-archive honors metadata skip_specs by passing a null sync plan', async () => {
  const h = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({
          changes: [change({ metadata: { found: true, schema: 'spec-driven', skip_specs: true } })],
        }),
    },
  })
  const result = await h.run('opsx-archive', 'add-x --yes')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /skip_specs/)
  assert.equal(h.calls.planSync.length, 0)
  assert.equal(h.calls.planArchive[0].syncPlan, null)
  assert.equal(h.calls.planArchive[0].metadata.skip_specs, true)
})

test('opsx-archive forwards retire_capabilities to the merge planner', async () => {
  const h = createHarness({
    state: {
      computeWorkspaceState: async () =>
        workspace({
          changes: [
            change({
              metadata: { found: true, schema: 'spec-driven', retire_capabilities: true },
            }),
          ],
        }),
    },
  })
  const result = await h.run('opsx-archive', '--yes add-x')
  assert.equal(result.kind, 'success')
  assert.equal(h.calls.planSync[0].retireCapabilities, true)
})

test('--dry-run wins over --yes so a preview can never write', async () => {
  const syncHarness = createHarness()
  const syncPreview = await syncHarness.run('opsx-sync', '--yes --dry-run add-x')
  assert.equal(syncPreview.kind, 'success')
  assert.match(syncPreview.text, /同步预览/)
  assert.equal(syncHarness.calls.applySyncPlan.length, 0)
  assert.equal(syncHarness.agent.messages.length, 0)

  const archiveHarness = createHarness()
  const archivePreview = await archiveHarness.run('opsx-archive', '--yes --dry-run add-x')
  assert.equal(archivePreview.kind, 'success')
  assert.match(archivePreview.text, /归档预览/)
  assert.equal(archiveHarness.calls.executeArchive.length, 0)
  assert.equal(archiveHarness.agent.messages.length, 0)
})

test('opsx-sync default and --yes set the sync and completed titles', async () => {
  const ai = createHarness()
  await ai.run('opsx-sync', 'add-x')
  assert.deepEqual(ai.calls.titles, [{ sessionId: 'session-test', title: '[同步] add-x' }])

  const deterministic = createHarness()
  await deterministic.run('opsx-sync', '--yes add-x')
  assert.deepEqual(deterministic.calls.titles, [{ sessionId: 'session-test', title: '[已同步] add-x' }])
})

test('opsx-archive default and --yes set the archive and completed titles', async () => {
  const ai = createHarness()
  await ai.run('opsx-archive', 'add-x')
  assert.deepEqual(ai.calls.titles, [{ sessionId: 'session-test', title: '[归档] add-x' }])

  const deterministic = createHarness()
  await deterministic.run('opsx-archive', '--yes add-x')
  assert.deepEqual(deterministic.calls.titles, [{ sessionId: 'session-test', title: '[已归档] add-x' }])

  const skipSpecs = createHarness()
  await skipSpecs.run('opsx-archive', '--yes --skip-specs add-x')
  assert.deepEqual(skipSpecs.calls.titles, [{ sessionId: 'session-test', title: '[已归档] add-x' }])
})

test('dry-run previews never change the session title', async () => {
  const sync = createHarness()
  await sync.run('opsx-sync', '--dry-run add-x')
  assert.deepEqual(sync.calls.titles, [])

  const archive = createHarness()
  await archive.run('opsx-archive', '--dry-run add-x')
  assert.deepEqual(archive.calls.titles, [])
})

test('failed commands never change the session title', async () => {
  const noChange = createHarness({
    state: { computeWorkspaceState: async () => workspace({ changes: [] }) },
  })
  const applyRefused = await noChange.run('opsx-apply')
  assert.equal(applyRefused.kind, 'error')
  assert.deepEqual(noChange.calls.titles, [])

  // propose now resumes; use a schema failure so the command still returns an error.
  const noSchema = createHarness({
    schema: {
      resolveSchema: () => ({ schema: null, source: null, issues: [] }),
      loadBundledSchemas: () => new Map(),
    },
  })
  const proposeRefused = await noSchema.run('opsx-propose', 'add-y 说明')
  assert.equal(proposeRefused.kind, 'error')
  assert.deepEqual(noSchema.calls.titles, [])

  const invalid = createHarness({
    state: {
      validateChangeByName: async (cwd, name) => ({
        name,
        validation: cleanValidation({
          errors: 1,
          issues: [{ level: 'ERROR', path: 'specs/cap/spec.md', message: 'missing scenario' }],
        }),
        metadata: {},
        schemaName: 'spec-driven',
        deltas: [],
        tasks: { total: 0, done: 0, items: [], issues: [] },
      }),
    },
  })
  // The default sync path now succeeds (AI workflow submitted before the
  // validation gate), so a deterministic refusal is the failing case here.
  const syncRefused = await invalid.run('opsx-sync', 'add-x --yes')
  assert.equal(syncRefused.kind, 'error')
  assert.deepEqual(invalid.calls.titles, [])
})

test('direct commands never change the session title', async () => {
  const h = createHarness()
  assert.equal((await h.run('opsx-status')).kind, 'success')
  assert.equal((await h.run('opsx-validate')).kind, 'success')
  assert.equal((await h.run('openspec-init')).kind, 'success')
  assert.deepEqual(h.calls.titles, [])
})

test('re-running the same phase command writes the title once', async () => {
  const h = createHarness()
  await h.run('opsx-explore', '同一个主题')
  await h.run('opsx-explore', '同一个主题')
  assert.deepEqual(h.calls.titles, [{ sessionId: 'session-test', title: '[探索] 同一个主题' }])
})

test('a phase command replaces a manually chosen title', async () => {
  const renamed = []
  const h = createHarness({}, {
    titles: {
      get: () => ({ title: '手动标题' }),
      rename(session, title) {
        renamed.push({ sessionId: session.id, title })
        return { title }
      },
    },
  })
  await h.run('opsx-apply')
  assert.deepEqual(renamed, [{ sessionId: 'session-test', title: '[实施] add-x' }])
})

test('a missing title service leaves the command result unchanged', async () => {
  const h = createHarness({}, { titles: null })
  const result = await h.run('opsx-explore', '主题')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /探索任务/)
  assert.deepEqual(h.calls.titles, [])
})

test('a rejected title write never fails the command', async () => {
  const h = createHarness({}, {
    titles: {
      get: () => undefined,
      rename() {
        throw new Error('session is not live')
      },
    },
  })
  const result = await h.run('opsx-explore', '主题')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /探索任务/)
  assert.deepEqual(h.calls.titles, [])
})

test('a long exploration topic stays within the title byte budget', async () => {
  const h = createHarness()
  await h.run('opsx-explore', '会'.repeat(60))
  assert.equal(h.calls.titles.length, 1)
  assert.ok(Buffer.byteLength(h.calls.titles[0].title, 'utf8') <= 80)
  assert.ok(h.calls.titles[0].title.endsWith('…'))
})

test('direct commands never submit a model message', async () => {
  const h = createHarness()
  await h.run('openspec-init')
  await h.run('opsx-status')
  await h.run('opsx-validate')
  assert.equal(h.agent.messages.length, 0)
})

test('thrown dependency failures become OpenSpec command errors', async () => {
  const h = createHarness({
    state: { computeWorkspaceState: async () => { throw new Error('engine exploded') } },
  })
  const result = await h.run('opsx-status')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^OpenSpec 命令失败：engine exploded$/)
})

test('collectWorkflowFacts derives the §10.4 facts shape from engine data', () => {
  const facts = collectWorkflowFacts({
    change: change({ isPlanningComplete: true }),
    state: workspace(),
    validated: {
      name: 'add-x',
      validation: cleanValidation({ warnings: 1, issues: [] }),
      deltas: [
        {
          path: 'specs/cap/spec.md',
          text: '',
          parsed: { operations: { ADDED: [{}, {}], MODIFIED: [{}], REMOVED: [], RENAMED: [{}, {}] } },
        },
      ],
      tasks: {
        total: 3,
        done: 1,
        items: [{ id: '1.1', text: '1.1 done', done: true }, { id: '1.2', text: '1.2 pending', done: false }],
      },
    },
    archiveTarget: 'openspec/changes/archive/2026-10-20-add-x',
    archiveTargetExists: true,
  })
  assert.deepEqual(facts.validation, cleanValidation({ warnings: 1, issues: [] }))
  assert.deepEqual(facts.artifacts[0], { id: 'proposal', status: 'done' })
  assert.deepEqual(facts.tasks, { total: 3, done: 1, pending: ['1.2 pending'] })
  assert.deepEqual(facts.deltas, [
    {
      path: 'openspec/changes/add-x/specs/cap/spec.md',
      capability: 'cap',
      added: 2,
      modified: 1,
      removed: 0,
      renamed: 2,
    },
  ])
  assert.deepEqual(facts.mainSpecs, [
    { path: 'openspec/specs/cap/spec.md', capability: 'cap', exists: true, requirementCount: 1 },
  ])
  assert.equal(facts.isPlanningComplete, true)
  assert.equal(facts.archiveTarget, 'openspec/changes/archive/2026-10-20-add-x')
  assert.equal(facts.archiveTargetExists, true)
})

test('collectWorkflowFacts tolerates a change without tasks or deltas', () => {
  const facts = collectWorkflowFacts({
    change: change({ tasks: null, artifacts: [], isPlanningComplete: false }),
    state: workspace({ specs: [] }),
    validated: { name: 'add-x', validation: cleanValidation(), deltas: [], tasks: null },
  })
  assert.deepEqual(facts.artifacts, [])
  assert.equal(facts.tasks, null)
  assert.deepEqual(facts.deltas, [])
  assert.deepEqual(facts.mainSpecs, [])
  assert.equal(facts.archiveTarget, null)
  assert.equal(facts.archiveTargetExists, null)
})

test('selectChange: explicit name wins, unknown name lists the active candidates', () => {
  const state = workspace({
    changes: [
      change({ name: 'add-x', validation: { errors: 0, warnings: 1, infos: 0, issues: [] } }),
      change({
        name: 'fix-y',
        listStatus: 'no-tasks',
        tasks: null,
        validation: { errors: 1, warnings: 0, infos: 0, issues: [] },
      }),
    ],
  })

  const explicit = selectChange(state, 'add-x')
  assert.equal(explicit.ok, true)
  assert.equal(explicit.change.name, 'add-x')
  assert.equal(explicit.auto, false)

  const withYes = selectChange(state, '--yes add-x')
  assert.equal(withYes.ok, true)
  assert.equal(withYes.change.name, 'add-x')

  // Every command flag is stripped before the change-name parse.
  const withFlags = selectChange(state, '--dry-run --skip-specs add-x')
  assert.equal(withFlags.ok, true)
  assert.equal(withFlags.change.name, 'add-x')
  assert.equal(withFlags.auto, false)

  const unknown = selectChange(state, 'nope')
  assert.equal(unknown.ok, false)
  assert.match(unknown.text, /找不到变更 "nope"/)
  assert.match(unknown.text, /add-x/)
  assert.match(unknown.text, /fix-y/)
  assert.match(unknown.text, /1 ERROR/)

  const ambiguous = selectChange(state, '')
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.text, /2 个进行中的变更/)
  assert.match(ambiguous.text, /add-x — schema spec-driven；进行中；任务 1\/3/)
  assert.match(ambiguous.text, /fix-y — schema spec-driven；无任务清单；1 ERROR/)
})

test('selectChange: a single active change auto-selects, none is an error, flags are not names', () => {
  const single = selectChange(workspace(), '')
  assert.equal(single.ok, true)
  assert.equal(single.change.name, 'add-x')
  assert.equal(single.auto, true)

  const none = selectChange(workspace({ changes: [] }), '')
  assert.equal(none.ok, false)
  assert.match(none.text, /没有进行中的变更/)

  const yesOnly = selectChange(workspace(), '--yes')
  assert.equal(yesOnly.ok, true)
  assert.equal(yesOnly.change.name, 'add-x')
  assert.equal(yesOnly.auto, true)

  const dryRunOnly = selectChange(workspace(), '--dry-run')
  assert.equal(dryRunOnly.ok, true)
  assert.equal(dryRunOnly.change.name, 'add-x')
  assert.equal(dryRunOnly.auto, true)
})
