/**
 * Tests for the multi-role orchestration engine (Host half).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { computeWorkspaceState } from '../src/native/state.js'
import {
  acceptTask,
  buildPlanPrompt,
  buildPmPrompt,
  buildRolePrompt,
  createProgram,
  evaluateProgram,
  normalizeProgram,
  readPlan,
  readPrograms,
  writePlanDraft,
} from '../src/native/orchestration.js'

function makeWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec-orch-'))
  fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  return cwd
}

function write(cwd, rel, text) {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true })
  fs.writeFileSync(path.join(cwd, rel), text)
}

function baseProgram(overrides = {}) {
  return {
    id: 'skills',
    title: '技能系统',
    goal: '为游戏新增技能系统',
    created: '2026-10-23',
    roles: {
      product: { provider: 'openai', model: 'gpt-5' },
      design: { provider: 'moonshot', model: 'kimi-k2' },
      dev: { provider: 'deepseek', model: 'deepseek-v3' },
      test: { provider: 'deepseek', model: 'deepseek-v3' },
    },
    tasks: [
      { id: 'core', change: 'skill-core', title: '技能核心', description: '共享数据结构', dependsOn: [], roles: ['product', 'design', 'dev', 'test'] },
      { id: 'fireball', change: 'skill-fireball', title: '火球术', description: '新增火球术', dependsOn: ['core'], roles: ['product', 'design', 'dev', 'test'] },
    ],
    ...overrides,
  }
}

/** Complete the product contract for one change. */
function completeProduct(cwd, change) {
  write(cwd, `openspec/changes/${change}/proposal.md`, '## Why\n\nneed this change because it is useful.\n\n## What Changes\n\n- add the thing\n')
  write(cwd, `openspec/changes/${change}/specs/${change}/spec.md`, '## ADDED Requirements\n\n### Requirement: Thing\n\nThe system SHALL do the thing.\n\n#### Scenario: works\n\n- **WHEN** called\n- **THEN** it works\n')
  write(cwd, `openspec/changes/${change}/tasks.md`, '- [ ] 1.1 implement the thing\n')
}

test('createProgram scaffolds child changes and evaluates dependency gates', async () => {
  const cwd = makeWorkspace()
  const program = await createProgram(cwd, baseProgram())
  assert.equal(program.id, 'skills')
  assert.equal(program.auto, true)
  assert.equal(program.roles.pm.label, 'PM')
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/changes/skill-core/.openspec.yaml')))
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/changes/skill-fireball/.openspec.yaml')))
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/orchestration/skills/program.json')))

  const initial = await computeWorkspaceState(cwd)
  const first = await readPrograms(cwd, initial)
  assert.equal(first.programs.length, 1)
  const core = first.programs[0].tasks.find((task) => task.id === 'core')
  const fireball = first.programs[0].tasks.find((task) => task.id === 'fireball')
  assert.equal(core.roles.product.status, 'ready')
  assert.equal(core.roles.design.status, 'waiting')
  assert.equal(fireball.roles.product.status, 'waiting')
  assert.match(fireball.roles.product.missing.join('；'), /技能核心/)

  completeProduct(cwd, 'skill-core')
  const afterProduct = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const core2 = afterProduct.programs[0].tasks.find((task) => task.id === 'core')
  const fireball2 = afterProduct.programs[0].tasks.find((task) => task.id === 'fireball')
  assert.equal(core2.roles.product.done, true)
  assert.equal(core2.roles.design.ready, true)
  assert.equal(core2.roles.dev.ready, true)
  assert.match(core2.roles.dev.note, /UI 任务等待设计/)
  assert.equal(core2.roles.test.ready, false)
  // Dependents wait for both the product and design contracts of the parent.
  assert.equal(fireball2.roles.product.status, 'waiting')

  write(cwd, 'openspec/changes/skill-core/design.md', '# Design\n\n## Visual\n\nUse a blue orb.\n')
  const afterDesign = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const fireball3 = afterDesign.programs[0].tasks.find((task) => task.id === 'fireball')
  assert.equal(fireball3.roles.product.ready, true)
  assert.equal(fireball3.roles.design.status, 'waiting')
})

test('role prompt is built from dependency artifacts, not another role transcript', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  completeProduct(cwd, 'skill-core')
  write(cwd, 'openspec/changes/skill-core/design.md', '# Design\n\nBlue orb.\n')
  write(cwd, 'openspec/orchestration/skills/handoffs/core-product.md', '产品交接：规格已就绪。\n')

  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const program = evaluated.programs[0]
  const task = program.tasks.find((entry) => entry.id === 'fireball')
  const prompt = await buildRolePrompt(cwd, program, task, 'product', await computeWorkspaceState(cwd))
  assert.match(prompt, /火球术/)
  assert.match(prompt, /为游戏新增技能系统/)
  assert.match(prompt, /不能读取|不读取其他角色的对话|不读取其他角色/)
  assert.match(prompt, /handoffs\/fireball-product\.md/)
  // Dependencies are contracts: the child product prompt sees the core spec/design.
  assert.match(prompt, /依赖任务：技能核心/)
  assert.match(prompt, /Blue orb/)
})

test('plan draft and planner prompt describe the single JSON contract', async () => {
  const cwd = makeWorkspace()
  const draft = await writePlanDraft(cwd, {
    id: 'auto-test',
    goal: '为游戏新增技能系统',
    roles: baseProgram().roles,
  })
  assert.equal(draft.id, 'auto-test')
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/orchestration/.plans/.gitkeep')))
  assert.equal(await readPlan(cwd, 'auto-test'), null)
  const prompt = await buildPlanPrompt(cwd, draft)
  assert.match(prompt, /openspec\/orchestration\/\.plans\/auto-test\.json/)
  assert.match(prompt, /1–8/)
  assert.match(prompt, /不要创建/)
  assert.match(prompt, /"id": "core"/)
})

test('PM prompt and status report are part of the program state', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  completeProduct(cwd, 'skill-core')
  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const program = evaluated.programs[0]
  const prompt = await buildPmPrompt(cwd, program)
  assert.match(prompt, /项目经理/)
  assert.match(prompt, /pm\/status\.md/)
  assert.match(prompt, /技能核心/)
  write(cwd, 'openspec/orchestration/skills/pm/status.md', '当前阶段：规格评审。\n')
  const withStatus = await readPrograms(cwd, await computeWorkspaceState(cwd))
  assert.match(withStatus.programs[0].pmStatus, /规格评审/)
})

test('acceptTask records the user gate and normalizeProgram rejects cycles', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  const accepted = await acceptTask(cwd, 'skills', 'fireball', true)
  assert.equal(accepted.tasks.find((task) => task.id === 'fireball').accepted, true)

  assert.throws(
    () =>
      normalizeProgram(
        baseProgram({
          tasks: [
            { id: 'a', change: 'a', title: 'A', description: '', dependsOn: ['b'], roles: ['product'] },
            { id: 'b', change: 'b', title: 'B', description: '', dependsOn: ['a'], roles: ['product'] },
          ],
        }),
      ),
    /依赖存在环/,
  )
})
