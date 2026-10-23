/**
 * Host-half integration tests: plugin wiring, the `/dsh-spec` route envelope and
 * the read-only native methods. These tests never write files — `init` is only
 * exercised against a fake workspace in the commands tests.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ROUTE, apply, inject, name } from '../src/host.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const slashed = (value) => value.replaceAll('\\', '/')

/** Committed fixture workspace with native OpenSpec content (stable for tests). */
const WORKSPACE = slashed(path.join(repoRoot, 'tests', 'fixtures', 'workspace'))

/** Plugin root: a workspace without native OpenSpec skills or openspec/. */
const PLUGIN_ROOT = slashed(repoRoot)

/** Build a fake Cordis plugin context and the collected registrations. */
function fakeContext({ skills, extraPaths = [] } = {}) {
  const registered = []
  const routes = []
  const effects = []
  const providers = []
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { admit: () => ({ principal: 'test' }) },
    workspaceRegistry: {
      resolveByPath: async (path) => (path === WORKSPACE || path === PLUGIN_ROOT || extraPaths.includes(path) ? { path } : undefined),
    },
    workingDirectory: {},
    get(key) {
      if (key === 'skills') return skills
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, registered, routes, effects, providers }
}

/** Call the registered route with one JSON envelope and return its response. */
async function callRoute(route, { method = 'POST', endpoint, envelope, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify(envelope)
  const req = {
    url: `${ROUTE}/${endpoint}`,
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
  const headers = {}
  let status = 0
  let payload = ''
  const res = {
    writeHead(code, extra) {
      status = code
      Object.assign(headers, extra ?? {})
    },
    end(text) {
      payload = typeof text === 'string' ? text : ''
    },
  }
  await route.handler(req, res)
  return { status, headers, text: payload, json: payload.startsWith('{') ? JSON.parse(payload) : null }
}

/** One client-request envelope for a route method. */
function envelope(endpoint, payload = {}) {
  return { type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload }
}

test('plugin metadata declares the injected services', () => {
  assert.equal(name, 'openSpec')
  assert.equal(ROUTE, '/dsh-spec')
  for (const service of ['commands', 'workingDirectory', 'webServer', 'connection', 'workspaceRegistry']) {
    assert.ok(inject.includes(service), `inject must include ${service}`)
  }
})

test('apply registers the twelve native commands', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx)
  const names = registered.map((definition) => definition.name).sort()
  assert.deepEqual(names, [
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
  ])
  for (const definition of registered) {
    assert.equal(typeof definition.handler, 'function')
    assert.equal(typeof definition.description, 'string')
  }
})

test('apply registers exactly one prefix route at ROUTE', () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, ROUTE)
  assert.equal(typeof routes[0].handler, 'function')
})

test('state method answers with the native workspace snapshot', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd: WORKSPACE }) })
  assert.equal(response.status, 200)
  assert.equal(response.json.type, 'server-response')
  assert.equal(response.json.rpcId, 'rpc-1')
  assert.equal(response.json.result.ok, true)
  const value = response.json.result.value
  assert.equal(value.root, 'openspec')
  assert.equal(value.status, 'ready')
  assert.equal(value.config.schema, 'spec-driven')
  assert.ok(Array.isArray(value.changes))
  assert.ok(Array.isArray(value.specs))
  assert.ok(Array.isArray(value.archived))
  assert.ok(value.skills !== null && typeof value.skills === 'object')
  assert.ok(value.changes.some((change) => change.name === 'align-native-openspec'))
  // The panel payload carries bounded task detail rows (state.js limitTaskItems).
  const change = value.changes.find((entry) => entry.name === 'align-native-openspec')
  assert.ok(Array.isArray(change.tasks.items))
  assert.equal(change.tasks.items.length, Math.min(change.tasks.total, 200))
  assert.equal(change.tasks.items.filter((item) => item.done).length, change.tasks.done)
  assert.deepEqual(Object.keys(change.tasks.items[0]).sort(), ['depth', 'done', 'id', 'line', 'manual', 'text'])
  assert.ok(change.tasks.items[0].line > 0)
  assert.equal(typeof change.tasks.items[0].manual, 'boolean')
  // The panel overview carries the proposal's Why / What Changes summary.
  assert.ok(change.summary !== null && typeof change.summary === 'object')
  assert.match(change.summary.description, /dsh-spec/)
  assert.equal(typeof change.summary.headline, 'string')
  assert.ok(change.summary.headline.length > 0)
  assert.ok(change.summary.headline.length <= 32)
  assert.ok(Array.isArray(change.summary.highlights))
  assert.ok(change.summary.highlights.length > 0)
})

test('state method reports an uninitialized workspace as missing', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd: PLUGIN_ROOT }) })
  assert.equal(response.json.result.ok, true)
  assert.equal(response.json.result.value.status, 'missing')
})

test('unregistered workspace paths are rejected', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], {
    endpoint: 'state',
    envelope: envelope('state', { cwd: 'D:/DSHarness/not-a-workspace' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.result.ok, false)
  assert.match(response.json.result.error.message, /工作区/)
})

test('relative or empty cwd is rejected', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  for (const cwd of ['', 'openspec', '..']) {
    const response = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd }) })
    assert.equal(response.json.result.ok, false)
  }
})

test('bad envelope and wrong method are rejected', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const bad = await callRoute(routes[0], { endpoint: 'state', envelope: { type: 'nope', method: 'state' } })
  assert.equal(bad.status, 400)
  const get = await callRoute(routes[0], { method: 'GET', endpoint: 'state' })
  assert.equal(get.status, 405)
})

test('unknown route methods return a structured error', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'bogus', envelope: envelope('bogus', { cwd: WORKSPACE }) })
  assert.equal(response.json.result.ok, false)
  assert.match(response.json.result.error.message, /未知操作/)
})

test('document method pages workspace-contained files', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const page = await callRoute(routes[0], {
    endpoint: 'document',
    envelope: envelope('document', { cwd: PLUGIN_ROOT, path: 'package.json' }),
  })
  assert.equal(page.json.result.ok, true)
  assert.match(page.json.result.value.text, /"name": "dsh-spec"/)
  assert.equal(page.json.result.value.offset, 1)
  assert.equal(typeof page.json.result.value.totalLines, 'number')

  const second = await callRoute(routes[0], {
    endpoint: 'document',
    envelope: envelope('document', { cwd: PLUGIN_ROOT, path: 'package.json', offset: 2, limit: 2 }),
  })
  assert.equal(second.json.result.value.offset, 2)
  assert.equal(second.json.result.value.lines, 2)
  assert.equal(second.json.result.value.truncated, true)
  assert.equal(second.json.result.value.nextOffset, 4)
})

test('document method rejects traversal and escaping paths', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  for (const path of ['../README.md', '..', '']) {
    const response = await callRoute(routes[0], { endpoint: 'document', envelope: envelope('document', { cwd: PLUGIN_ROOT, path }) })
    assert.equal(response.json.result.ok, false, `path ${JSON.stringify(path)} must be rejected`)
  }
})

test('instructions compose explore and native phase prompts', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const explore = await callRoute(routes[0], {
    endpoint: 'instructions',
    envelope: envelope('instructions', { cwd: WORKSPACE, kind: 'explore', topic: 'cache layer' }),
  })
  assert.equal(explore.json.result.ok, true)
  assert.match(explore.json.result.value.text, /cache layer/)
  assert.match(explore.json.result.value.text, /(do not|Do NOT) (write|modif)/)

  const propose = await callRoute(routes[0], {
    endpoint: 'instructions',
    envelope: envelope('instructions', { cwd: WORKSPACE, kind: 'propose', change: 'align-native-openspec', topic: 'revise scope' }),
  })
  assert.equal(propose.json.result.ok, true)
  assert.match(propose.json.result.value.text, /align-native-openspec/)

  const bad = await callRoute(routes[0], {
    endpoint: 'instructions',
    envelope: envelope('instructions', { cwd: WORKSPACE, kind: 'nope' }),
  })
  assert.equal(bad.json.result.ok, false)
})

test('validate method works per change and workspace-wide without writing', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const perChange = await callRoute(routes[0], {
    endpoint: 'validate',
    envelope: envelope('validate', { cwd: WORKSPACE, change: 'align-native-openspec' }),
  })
  assert.equal(perChange.json.result.ok, true)
  assert.equal(perChange.json.result.value.name, 'align-native-openspec')
  const validation = perChange.json.result.value.validation
  assert.equal(typeof validation.errors, 'number')
  assert.ok(Array.isArray(validation.issues))

  const workspace = await callRoute(routes[0], { endpoint: 'validate', envelope: envelope('validate', { cwd: WORKSPACE }) })
  assert.equal(workspace.json.result.ok, true)
  assert.equal(workspace.json.result.value.workspace, true)
  assert.ok(Array.isArray(workspace.json.result.value.validation.issues))
})

test('instructions compose sync and archive OPSX workflow prompts', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  for (const kind of ['sync', 'archive']) {
    const response = await callRoute(routes[0], {
      endpoint: 'instructions',
      envelope: envelope('instructions', { cwd: WORKSPACE, kind, change: 'align-native-openspec' }),
    })
    assert.equal(response.json.result.ok, true, `${kind} instructions must succeed`)
    const value = response.json.result.value
    assert.equal(value.kind, kind)
    assert.equal(value.change, 'align-native-openspec')
    assert.match(value.text, /## DSH adaptation/, `${kind} prompt must include the adaptation section`)
    assert.match(value.text, /Current facts/, `${kind} prompt must include the engine facts block`)
    assert.match(value.text, /align-native-openspec/)
  }
})

test('sync-preview builds a dry-run plan and renders preview text', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], {
    endpoint: 'sync-preview',
    envelope: envelope('sync-preview', { cwd: WORKSPACE, change: 'align-native-openspec' }),
  })
  assert.equal(response.json.result.ok, true)
  const value = response.json.result.value
  assert.equal(value.change, 'align-native-openspec')
  assert.equal(typeof value.ok, 'boolean')
  assert.ok(value.summary !== null && typeof value.summary === 'object')
  assert.equal(typeof value.text, 'string')
  assert.ok(Array.isArray(value.files))
  assert.ok(Array.isArray(value.writes))
  assert.ok(value.validation !== undefined)
})

test('task-toggle writes only the requested task checkbox on a temp workspace copy', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec-task-'))
  const workspace = slashed(path.join(temp, 'workspace'))
  try {
    fs.cpSync(WORKSPACE, workspace, { recursive: true })
    const { ctx, routes } = fakeContext({ extraPaths: [workspace] })
    apply(ctx)
    const tasksPath = path.join(workspace, 'openspec', 'changes', 'align-native-openspec', 'tasks.md')
    const before = fs.readFileSync(tasksPath, 'utf8').split('\n')
    const sourceLine = before.findIndex((line) => /^- \[x\] 1\.1/.test(line)) + 1
    assert.ok(sourceLine > 0, 'fixture first task must be checked')
    const response = await callRoute(routes[0], {
      endpoint: 'task-toggle',
      envelope: envelope('task-toggle', { cwd: workspace, change: 'align-native-openspec', line: sourceLine, done: false }),
    })
    assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result))
    assert.equal(response.json.result.value.done, false)
    const after = fs.readFileSync(tasksPath, 'utf8').split('\n')
    assert.match(after[sourceLine - 1], /^- \[ \] 1\.1/)
    // Everything outside that one marker is unchanged.
    after[sourceLine - 1] = before[sourceLine - 1]
    assert.deepEqual(after, before)

    // A stale line (now not the same task text? still a task) is accepted only
    // when it is still a checkbox; a prose line is refused.
    const proseLine = before.findIndex((line) => line.startsWith('## ')) + 1
    const refused = await callRoute(routes[0], {
      endpoint: 'task-toggle',
      envelope: envelope('task-toggle', { cwd: workspace, change: 'align-native-openspec', line: proseLine, done: true }),
    })
    assert.equal(refused.json.result.ok, false)
    assert.match(refused.json.result.error.message, /不是任务复选框/)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('initialization on an uninitialized workspace is idempotent for missing dirs only', async () => {
  // The route's init handler writes by design; the sandbox denies child-process writes,
  // so this test only covers the read-only rejection path (a non-registered path).
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'init', envelope: envelope('init', { cwd: 'D:/nope' }) })
  assert.equal(response.json.result.ok, false)
  assert.match(response.json.result.error.message, /工作区/)
})

test('archive-detail returns an archived change with tasks, docs and metadata', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const stateResponse = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd: WORKSPACE }) })
  const archived = stateResponse.json.result.value.archived
  assert.ok(Array.isArray(archived) && archived.length >= 1)
  const row = archived.find((entry) => entry.changeName === 'legacy-fixture')
  assert.ok(row, 'the fixture archived change should be listed')
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/)

  const detail = await callRoute(routes[0], {
    endpoint: 'archive-detail',
    envelope: envelope('archive-detail', { cwd: WORKSPACE, path: row.path }),
  })
  assert.equal(detail.json.result.ok, true)
  const change = detail.json.result.value.change
  assert.equal(change.name, `archive/${row.name}`)
  assert.equal(change.metadata.found, true)
  assert.equal(change.tasks.done, change.tasks.total)
  assert.equal(change.listStatus, 'complete')
  // archive-detail reuses the same ChangeState shape, task rows included.
  assert.ok(Array.isArray(change.tasks.items))
  assert.equal(change.tasks.items.length, change.tasks.total)
  assert.equal(change.tasks.items.filter((item) => item.done).length, change.tasks.done)
  assert.ok(change.docs.some((doc) => doc.path.endsWith('proposal.md')))
  assert.ok(change.docs.some((doc) => doc.kind === 'delta'))
})

test('optional skills service receives a workspace-aware fallback provider', async () => {
  const providers = []
  const skills = {
    registerProvider(factory) {
      providers.push(factory({ signal: new AbortController().signal, invalidate() {} }))
      return () => {}
    },
  }
  const { ctx } = fakeContext({ skills })
  apply(ctx)
  assert.equal(providers.length, 1)
  assert.equal(providers[0].name, 'openspec-native-fallback')
  const candidates = await providers[0].list({ cwd: PLUGIN_ROOT })
  assert.ok(Array.isArray(candidates))
  for (const candidate of candidates) {
    assert.match(candidate.name, /^openspec-/)
    const definition = await providers[0].get(candidate, { cwd: PLUGIN_ROOT })
    assert.equal(typeof definition.content, 'string')
  }
})

test('orchestration routes create a program and expose evaluated state', async () => {
  const cwd = slashed(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec-host-orch-')))
  fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  const { ctx, routes } = fakeContext({ extraPaths: [cwd] })
  apply(ctx)
  const route = routes[0]
  const program = {
    id: 'skills',
    title: '技能系统',
    goal: '新增技能',
    roles: {
      product: { provider: 'openai', model: 'gpt-5' },
      design: { provider: 'moonshot', model: 'kimi-k2' },
      dev: { provider: 'deepseek', model: 'deepseek-v3' },
      test: { provider: 'deepseek', model: 'deepseek-v3' },
    },
    tasks: [
      { id: 'fireball', change: 'skill-fireball', title: '火球术', description: '新增火球术', dependsOn: [], roles: ['product', 'design', 'dev', 'test'] },
    ],
  }
  const created = await callRoute(route, { endpoint: 'orchestration-create', envelope: envelope('orchestration-create', { cwd, program }) })
  assert.equal(created.status, 200)
  assert.equal(created.json.result.ok, true)

  const state = await callRoute(route, { endpoint: 'state', envelope: envelope('state', { cwd }) })
  const value = state.json.result.value
  assert.equal(value.orchestration.length, 1)
  assert.equal(value.orchestration[0].id, 'skills')
  assert.equal(value.orchestration[0].tasks[0].roles.product.status, 'ready')

  const roles = await callRoute(route, {
    endpoint: 'orchestration-roles',
    envelope: envelope('orchestration-roles', {
      cwd,
      program: 'skills',
      roles: { product: { provider: 'openai', model: 'gpt-5-mini' } },
    }),
  })
  assert.equal(roles.json.result.ok, true)

  const autoOff = await callRoute(route, {
    endpoint: 'orchestration-auto',
    envelope: envelope('orchestration-auto', { cwd, program: 'skills', auto: false }),
  })
  assert.equal(autoOff.json.result.ok, true)
  const paused = await callRoute(route, { endpoint: 'state', envelope: envelope('state', { cwd }) })
  assert.equal(paused.json.result.value.orchestration[0].auto, false)

  const early = await callRoute(route, {
    endpoint: 'orchestration-accept',
    envelope: envelope('orchestration-accept', { cwd, program: 'skills', task: 'fireball', accepted: true }),
  })
  assert.equal(early.json.result.ok, false)
  assert.match(early.json.result.error.message, /测试尚未完成/)

  const changeDir = path.join(cwd, 'openspec', 'changes', 'skill-fireball')
  fs.mkdirSync(path.join(changeDir, 'specs', 'skill-fireball'), { recursive: true })
  fs.mkdirSync(path.join(changeDir, 'qa'), { recursive: true })
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## Why\n\nThis change adds a fireball skill to the game.\n\n## What Changes\n\n- add fireball\n')
  fs.writeFileSync(path.join(changeDir, 'specs', 'skill-fireball', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Fireball\n\nThe system SHALL cast a fireball.\n\n#### Scenario: cast\n\n- **WHEN** cast\n- **THEN** it works\n')
  fs.writeFileSync(path.join(changeDir, 'design.md'), '# Design\n\nBlue orb.\n')
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [x] 1.1 implement fireball\n')
  fs.writeFileSync(path.join(changeDir, 'qa', 'report.md'), '# QA\n\nPASS\n')

  const accepted = await callRoute(route, {
    endpoint: 'orchestration-accept',
    envelope: envelope('orchestration-accept', { cwd, program: 'skills', task: 'fireball', accepted: true }),
  })
  assert.equal(accepted.json.result.ok, true)
  const after = await callRoute(route, { endpoint: 'state', envelope: envelope('state', { cwd }) })
  assert.equal(after.json.result.value.orchestration[0].tasks[0].accepted, true)
  assert.equal(after.json.result.value.orchestration[0].roles.product.model, 'gpt-5-mini')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('orchestration draft/plan routes support AI task splitting', async () => {
  const cwd = slashed(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec-host-plan-')))
  fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  const { ctx, routes } = fakeContext({ extraPaths: [cwd] })
  apply(ctx)
  const route = routes[0]
  const roles = {
    product: { provider: 'openai', model: 'gpt-5' },
    design: { provider: 'moonshot', model: 'kimi-k2' },
    dev: { provider: 'deepseek', model: 'deepseek-v3' },
    test: { provider: 'deepseek', model: 'deepseek-v3' },
  }
  const draft = await callRoute(route, {
    endpoint: 'orchestration-draft',
    envelope: envelope('orchestration-draft', { cwd, draft: { id: 'auto-test', goal: '做一套技能系统', roles } }),
  })
  assert.equal(draft.json.result.ok, true)

  const pending = await callRoute(route, {
    endpoint: 'orchestration-plan',
    envelope: envelope('orchestration-plan', { cwd, id: 'auto-test' }),
  })
  assert.equal(pending.json.result.value.plan, null)

  const planRel = path.join(cwd, 'openspec', 'orchestration', '.plans', 'auto-test.json')
  fs.mkdirSync(path.dirname(planRel), { recursive: true })
  fs.writeFileSync(
    planRel,
    JSON.stringify({
      title: '技能系统',
      tasks: [
        { id: 'core', change: 'skill-core', title: '技能核心', description: '共享结构', dependsOn: [] },
        { id: 'fireball', change: 'skill-fireball', title: '火球术', description: '火球技能', dependsOn: ['core'] },
      ],
    }),
  )
  const plan = await callRoute(route, {
    endpoint: 'orchestration-plan',
    envelope: envelope('orchestration-plan', { cwd, id: 'auto-test' }),
  })
  assert.equal(plan.json.result.value.plan.title, '技能系统')
  assert.equal(plan.json.result.value.plan.tasks.length, 2)

  const created = await callRoute(route, {
    endpoint: 'orchestration-create',
    envelope: envelope('orchestration-create', {
      cwd,
      program: { id: 'auto-test', title: '技能系统', goal: '做一套技能系统', roles, tasks: plan.json.result.value.plan.tasks },
    }),
  })
  assert.equal(created.json.result.ok, true)
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('compositions without a skills service still register commands and the route', () => {
  const { ctx, registered, routes } = fakeContext()
  apply(ctx)
  assert.equal(registered.length, 12)
  assert.equal(routes.length, 1)
})

// ---------------------------------------------------------------------------
// Human report actions (`report-prompt` / `report-status`)
// ---------------------------------------------------------------------------

/** Archived fixture change used by the report tests. */
const ARCHIVED_REL = 'openspec/changes/archive/2024-01-01-legacy-fixture'
const ARCHIVED_NAME = 'legacy-fixture'

/** Copy the committed fixture workspace into a writable temp directory. */
function tempWorkspace() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec-report-'))
  const workspace = slashed(path.join(temp, 'workspace'))
  fs.cpSync(WORKSPACE, workspace, { recursive: true })
  return { temp, workspace }
}

/** Recursively snapshot one tree (kind/rel/size/mtime) to prove a read-only call wrote nothing. */
function snapshotTree(root) {
  const out = []
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        out.push(`d:${rel}`)
        walk(absolute, rel)
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute)
        out.push(`f:${rel}:${stat.size}:${stat.mtimeMs}`)
      } else {
        out.push(`o:${rel}`)
      }
    }
  }
  walk(root, '')
  return out
}

/** Write one UTF-8 file under an absolute path, creating parents. */
function writeFile(absolute, content) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content, 'utf8')
}

/** Call one report action against a fresh route registration. */
async function callReport(endpoint, payload) {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  return callRoute(routes[0], { endpoint, envelope: envelope(endpoint, payload) })
}

/** Call one report action against a fresh registration whose workspace is `workspace`. */
async function callReportOn(workspace, endpoint, payload) {
  const { ctx, routes } = fakeContext({ extraPaths: [workspace] })
  apply(ctx)
  return callRoute(routes[0], { endpoint, envelope: envelope(endpoint, payload) })
}

test('report-prompt composes the single-change prompt without writing to the workspace', async () => {
  const before = snapshotTree(WORKSPACE)
  const response = await callReport('report-prompt', { cwd: WORKSPACE, path: ARCHIVED_REL })
  assert.equal(response.status, 200)
  assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result))
  const value = response.json.result.value
  assert.equal(value.scope, 'change')
  assert.equal(typeof value.text, 'string')
  assert.match(value.text, /Human report prompt — single archived change/)
  assert.ok(value.text.includes(ARCHIVED_REL))
  assert.ok(value.text.includes(value.report.absolutePath), 'prompt must contain the resolved output path')
  assert.ok(value.text.includes('report-template/v1'))
  assert.match(value.text, /主线锚定/)
  assert.match(value.text, /证据分级/)
  assert.equal(value.report.path, `人类文档/${ARCHIVED_NAME}/index.html`)
  assert.equal(path.isAbsolute(value.report.absolutePath), true)
  assert.equal(value.report.exists, false)
  assert.equal(value.template.version, 'report-template/v1')
  assert.equal(path.isAbsolute(value.template.path), true)
  assert.ok(!('included' in value), 'single-change prompts carry no range inclusion list')

  const after = snapshotTree(WORKSPACE)
  assert.deepEqual(after, before, 'report-prompt must not create, modify or delete any workspace file')
})

test('report-prompt honors the archive output mode and a custom workspace-relative report root', async () => {
  const inArchive = await callReport('report-prompt', { cwd: WORKSPACE, path: ARCHIVED_REL, inArchive: true })
  assert.equal(inArchive.json.result.ok, true)
  assert.equal(inArchive.json.result.value.report.path, `${ARCHIVED_REL}/report.html`)
  assert.ok(inArchive.json.result.value.text.includes(inArchive.json.result.value.report.absolutePath))

  const custom = await callReport('report-prompt', {
    cwd: WORKSPACE,
    name: '2024-01-01-legacy-fixture',
    reportRoot: '报告/归档',
  })
  assert.equal(custom.json.result.ok, true)
  assert.equal(custom.json.result.value.report.path, `报告/归档/${ARCHIVED_NAME}/index.html`)

  // An absolute report root inside the workspace is accepted and mapped to a relative path.
  const inside = slashed(path.join(WORKSPACE, '人类文档-abs'))
  const absolute = await callReport('report-prompt', { cwd: WORKSPACE, path: ARCHIVED_REL, reportRoot: inside })
  assert.equal(absolute.json.result.ok, true)
  assert.equal(absolute.json.result.value.report.path, `人类文档-abs/${ARCHIVED_NAME}/index.html`)
})

test('report-prompt composes the period prompt with the included change list and period naming', async () => {
  const before = snapshotTree(WORKSPACE)
  const response = await callReport('report-prompt', {
    cwd: WORKSPACE,
    scope: 'range',
    from: '2024-01-01',
    to: '2024-01-01',
    reportRoot: '人类文档',
  })
  assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result))
  const value = response.json.result.value
  assert.equal(value.scope, 'range')
  assert.deepEqual(value.included, [
    { name: ARCHIVED_NAME, changePath: ARCHIVED_REL, date: '2024-01-01' },
  ])
  assert.equal(value.report.path, '人类文档/2024-01-01_2024-01-01/index.html')
  assert.equal(value.report.exists, false)
  assert.match(value.text, /Human report prompt — period report/)
  assert.match(value.text, /From \(inclusive\): 2024-01-01/)
  assert.match(value.text, /To \(inclusive\): 2024-01-01/)
  assert.match(value.text, /Period name \/ output directory: 2024-01-01_2024-01-01/)
  assert.ok(value.text.includes(ARCHIVED_NAME))
  assert.ok(value.text.includes(ARCHIVED_REL))
  assert.match(value.text, /## Sub-agent orchestration \(period scope only\)/)
  assert.match(value.text, /synthesizes ONE report/)

  const after = snapshotTree(WORKSPACE)
  assert.deepEqual(after, before, 'report-prompt must not create, modify or delete any workspace file')
})

test('report-prompt injects the optional project mainline card when present', async () => {
  const { temp, workspace } = tempWorkspace()
  try {
    writeFile(
      path.join(workspace, 'openspec', 'report-context.md'),
      '# 项目主线卡\n\nMAINLINE-CARD: 让归档变更可被人类读者快速理解。\n',
    )
    const response = await callReportOn(workspace, 'report-prompt', { cwd: workspace, path: ARCHIVED_REL })
    assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result))
    const text = response.json.result.value.text
    assert.ok(text.includes('MAINLINE-CARD: 让归档变更可被人类读者快速理解。'))
    assert.match(text, /主线来源：项目主线卡/)
    assert.ok(!text.includes('No project mainline card is available'))
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('report-prompt rejects active changes, outside-workspace roots and invalid period ranges', async () => {
  const active = await callReport('report-prompt', { cwd: WORKSPACE, path: 'openspec/changes/align-native-openspec' })
  assert.equal(active.json.result.ok, false)
  assert.match(active.json.result.error.message, /归档路径无效/)

  const traversal = await callReport('report-prompt', { cwd: WORKSPACE, path: '../../outside-change' })
  assert.equal(traversal.json.result.ok, false)
  assert.match(traversal.json.result.error.message, /归档路径无效/)

  const outsideRoot = slashed(path.join(os.tmpdir(), 'dsh-spec-outside-reports'))
  const outside = await callReport('report-prompt', { cwd: WORKSPACE, path: ARCHIVED_REL, reportRoot: outsideRoot })
  assert.equal(outside.json.result.ok, false)
  assert.match(outside.json.result.error.message, /工作区内/)

  const dotdotRoot = await callReport('report-prompt', { cwd: WORKSPACE, path: ARCHIVED_REL, reportRoot: '人类文档/../../outside' })
  assert.equal(dotdotRoot.json.result.ok, false)
  assert.match(dotdotRoot.json.result.error.message, /不允许包含 \.\./)

  for (const range of [
    { scope: 'range' },
    { scope: 'range', from: '2024-1-1', to: '2024-01-31' },
    { scope: 'range', from: '2024-01-01', to: '2024/01/31' },
    { scope: 'range', from: '2024-02-30', to: '2024-03-01' },
    { scope: 'range', from: '2024-12-01', to: '2024-01-01' },
  ]) {
    const response = await callReport('report-prompt', { cwd: WORKSPACE, ...range })
    assert.equal(response.json.result.ok, false, `range ${JSON.stringify(range)} must be rejected`)
  }
  const missingDate = await callReport('report-prompt', { cwd: WORKSPACE, scope: 'range', from: '2024-01-01' })
  assert.equal(missingDate.json.result.ok, false)
  assert.match(missingDate.json.result.error.message, /结束日期/)
})

test('report-prompt rejects empty and oversized periods', async () => {
  const empty = await callReport('report-prompt', { cwd: WORKSPACE, scope: 'range', from: '2024-02-01', to: '2024-02-28' })
  assert.equal(empty.json.result.ok, false)
  assert.match(empty.json.result.error.message, /没有已归档的变更/)

  const { temp, workspace } = tempWorkspace()
  try {
    const archiveRoot = path.join(workspace, 'openspec', 'changes', 'archive')
    for (let index = 1; index <= 31; index += 1) {
      fs.mkdirSync(path.join(archiveRoot, `2024-03-01-range-${String(index).padStart(2, '0')}`), { recursive: true })
    }
    const { ctx, routes } = fakeContext({ extraPaths: [workspace] })
    apply(ctx)
    const response = await callRoute(routes[0], {
      endpoint: 'report-prompt',
      envelope: envelope('report-prompt', { cwd: workspace, scope: 'range', from: '2024-03-01', to: '2024-03-31' }),
    })
    assert.equal(response.json.result.ok, false)
    assert.match(response.json.result.error.message, /超过上限 30/)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('report-status prefers the pointer, then the naming convention, then the archive file', async () => {
  const { temp, workspace } = tempWorkspace()
  try {
    const { ctx, routes } = fakeContext({ extraPaths: [workspace] })
    apply(ctx)
    const status = async (payload) => {
      const response = await callRoute(routes[0], { endpoint: 'report-status', envelope: envelope('report-status', payload) })
      assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result))
      return response.json.result.value
    }

    // Nothing generated yet.
    const missing = await status({ cwd: workspace, path: ARCHIVED_REL })
    assert.equal(missing.scope, 'change')
    assert.equal(missing.exists, false)
    assert.equal(missing.path, null)

    // Naming convention under the report root.
    const conventionFile = path.join(workspace, '人类文档', ARCHIVED_NAME, 'index.html')
    writeFile(conventionFile, '<html><body>report</body></html>')
    const convention = await status({ cwd: workspace, path: ARCHIVED_REL })
    assert.equal(convention.exists, true)
    assert.equal(convention.source, 'convention')
    assert.equal(convention.path, `人类文档/${ARCHIVED_NAME}/index.html`)
    assert.equal(path.isAbsolute(convention.absolutePath), true)

    // A report.json pointer next to the archived change wins over the convention.
    const generatedAt = '2026-10-22T10:00:00.000Z'
    writeFile(
      path.join(workspace, ARCHIVED_REL, 'report.json'),
      JSON.stringify({ report: `人类文档/${ARCHIVED_NAME}/index.html`, generatedAt, template: 'report-template/v1', change: ARCHIVED_NAME }),
    )
    const pointer = await status({ cwd: workspace, path: ARCHIVED_REL })
    assert.equal(pointer.exists, true)
    assert.equal(pointer.source, 'pointer')
    assert.equal(pointer.generatedAt, generatedAt)
    assert.equal(pointer.path, `人类文档/${ARCHIVED_NAME}/index.html`)

    // A stale pointer whose target disappeared falls through to the archive-file fallback.
    fs.rmSync(conventionFile)
    assert.equal((await status({ cwd: workspace, path: ARCHIVED_REL })).exists, false)
    writeFile(path.join(workspace, ARCHIVED_REL, 'report.html'), '<html><body>archived report</body></html>')
    const archived = await status({ cwd: workspace, path: ARCHIVED_REL })
    assert.equal(archived.exists, true)
    assert.equal(archived.source, 'archive')
    assert.equal(archived.path, `${ARCHIVED_REL}/report.html`)

    // Pointer targets outside the workspace are returned by pointer presence only.
    writeFile(
      path.join(workspace, ARCHIVED_REL, 'report.json'),
      JSON.stringify({ report: 'D:/outside-workspace/人类文档/report.html', generatedAt }),
    )
    const outside = await status({ cwd: workspace, path: ARCHIVED_REL })
    assert.equal(outside.exists, true)
    assert.equal(outside.source, 'pointer')
    assert.equal(outside.path, 'D:/outside-workspace/人类文档/report.html')
    assert.equal(outside.generatedAt, generatedAt)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('report-status reads a generated period report and its range report.json', async () => {
  const { temp, workspace } = tempWorkspace()
  try {
    const directory = path.join(workspace, '人类文档', '2024-01-01_2024-01-01')
    writeFile(path.join(directory, 'index.html'), '<html><body>period report</body></html>')
    const generatedAt = '2026-10-22T11:00:00.000Z'
    writeFile(
      path.join(directory, 'report.json'),
      JSON.stringify({
        scope: 'range',
        from: '2024-01-01',
        to: '2024-01-01',
        generatedAt,
        template: 'report-template/v1',
        included: [{ name: ARCHIVED_NAME, changePath: ARCHIVED_REL, date: '2024-01-01' }],
      }),
    )

    const { ctx, routes } = fakeContext({ extraPaths: [workspace] })
    apply(ctx)
    const response = await callRoute(routes[0], {
      endpoint: 'report-status',
      envelope: envelope('report-status', { cwd: workspace, scope: 'range', from: '2024-01-01', to: '2024-01-01' }),
    })
    assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result))
    const value = response.json.result.value
    assert.equal(value.scope, 'range')
    assert.equal(value.exists, true)
    assert.equal(value.source, 'convention')
    assert.equal(value.path, '人类文档/2024-01-01_2024-01-01/index.html')
    assert.equal(value.generatedAt, generatedAt)
    assert.equal(value.included, 1)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('report-status is read-only for both scopes', async () => {
  const before = snapshotTree(WORKSPACE)
  const change = await callReport('report-status', { cwd: WORKSPACE, path: ARCHIVED_REL })
  assert.equal(change.json.result.ok, true)
  assert.equal(change.json.result.value.exists, false)
  const range = await callReport('report-status', { cwd: WORKSPACE, scope: 'range', from: '2024-01-01', to: '2024-12-31' })
  assert.equal(range.json.result.ok, true)
  assert.equal(range.json.result.value.exists, false)
  assert.equal(range.json.result.value.included, 1)
  const after = snapshotTree(WORKSPACE)
  assert.deepEqual(after, before, 'report-status must not create, modify or delete any workspace file')
})
