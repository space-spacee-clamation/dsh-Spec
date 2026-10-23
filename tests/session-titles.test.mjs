/**
 * Unit tests for deterministic phase session titles (src/session-titles.js).
 *
 * Pure composition is covered here; the command-level integration lives in
 * tests/commands.test.mjs. No test writes a file or touches a real session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PHASE_LABELS, composePhaseTitle, withPhaseTitle } from '../src/session-titles.js'

/** UTF-8 byte length helper matching the session-title service's budget unit. */
function bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

test('every phase key maps to its visible Chinese label', () => {
  assert.deepEqual(Object.keys(PHASE_LABELS).sort(), [
    'apply',
    'archive',
    'archived',
    'design',
    'dev',
    'explore',
    'plan',
    'pm',
    'product',
    'propose',
    'sync',
    'synced',
    'test',
    'update',
  ])
  assert.equal(PHASE_LABELS.explore, '探索')
  assert.equal(PHASE_LABELS.propose, '提案')
  assert.equal(PHASE_LABELS.apply, '实施')
  assert.equal(PHASE_LABELS.update, '更新')
  assert.equal(PHASE_LABELS.sync, '同步')
  assert.equal(PHASE_LABELS.archive, '归档')
  assert.equal(PHASE_LABELS.synced, '已同步')
  assert.equal(PHASE_LABELS.archived, '已归档')
  assert.equal(PHASE_LABELS.product, '产品')
  assert.equal(PHASE_LABELS.design, '设计')
  assert.equal(PHASE_LABELS.dev, '开发')
  assert.equal(PHASE_LABELS.test, '测试')
  assert.equal(PHASE_LABELS.plan, '规划')
  assert.equal(PHASE_LABELS.pm, 'PM')
})

test('composes a bracket-prefixed title for every phase', () => {
  assert.equal(composePhaseTitle('explore', '缓存层怎么分层'), '[探索] 缓存层怎么分层')
  assert.equal(composePhaseTitle('propose', 'add-dark-mode'), '[提案] add-dark-mode')
  assert.equal(composePhaseTitle('apply', 'add-dark-mode'), '[实施] add-dark-mode')
  assert.equal(composePhaseTitle('update', 'add-dark-mode'), '[更新] add-dark-mode')
  assert.equal(composePhaseTitle('sync', 'add-dark-mode'), '[同步] add-dark-mode')
  assert.equal(composePhaseTitle('archive', 'add-dark-mode'), '[归档] add-dark-mode')
  assert.equal(composePhaseTitle('synced', 'add-dark-mode'), '[已同步] add-dark-mode')
  assert.equal(composePhaseTitle('archived', 'add-dark-mode'), '[已归档] add-dark-mode')
})

test('an empty or whitespace-only subject keeps the phase prefix alone', () => {
  assert.equal(composePhaseTitle('explore'), '[探索]')
  assert.equal(composePhaseTitle('explore', ''), '[探索]')
  assert.equal(composePhaseTitle('explore', '   \n\t '), '[探索]')
})

test('a subject is collapsed into one trimmed line', () => {
  assert.equal(composePhaseTitle('explore', '  深入调查  '), '[探索] 深入调查')
  assert.equal(
    composePhaseTitle('explore', '第一行\n第二行\t带控制\u0007字符'),
    '[探索] 第一行 第二行 带控制 字符',
  )
})

test('an unknown phase key throws a programming error', () => {
  assert.throws(() => composePhaseTitle('nope', 'x'), /unknown phase/)
})

test('short subjects keep the complete text without an ellipsis', () => {
  const title = composePhaseTitle('propose', 'add-dark-mode')
  assert.ok(!title.endsWith('…'))
  assert.ok(bytes(title) <= 80)
})

test('a long CJK subject is truncated on a code-point boundary with an ellipsis', () => {
  const topic = '会'.repeat(60)
  const title = composePhaseTitle('explore', topic)
  assert.ok(title.startsWith('[探索] '))
  assert.ok(title.endsWith('…'))
  assert.ok(bytes(title) <= 80)
  const head = title.slice('[探索] '.length, -1)
  assert.ok(head.length > 0)
  assert.ok([...head].every((character) => character === '会'), 'never splits a multi-byte character')
  assert.ok(bytes(head) <= 68)
})

test('a long emoji subject stays within the byte budget without splitting a surrogate pair', () => {
  const title = composePhaseTitle('explore', '😀'.repeat(40))
  assert.ok(title.endsWith('…'))
  assert.equal(bytes(title), 80)
  const head = title.slice('[探索] '.length, -1)
  assert.equal([...head].length, 17, '68-byte subject budget holds 17 four-byte emoji')
  assert.ok([...head].every((character) => character === '😀'))
})

test('completion prefixes leave less room for the subject but stay within the budget', () => {
  const ok = composePhaseTitle('archived', 'a'.repeat(100))
  assert.ok(ok.startsWith('[已归档] '))
  assert.ok(ok.endsWith('…'))
  assert.ok(bytes(ok) <= 80)
})

test('an exactly fitting subject is not truncated', () => {
  const seventyOne = 'a'.repeat(71)
  const exact = composePhaseTitle('explore', seventyOne)
  assert.equal(exact, `[探索] ${seventyOne}`)
  assert.equal(bytes(exact), 80)
  const overflow = composePhaseTitle('explore', 'a'.repeat(72))
  assert.ok(overflow.endsWith('…'))
  assert.equal(bytes(overflow), 80)
})

test('mixed ASCII and CJK subjects never exceed the title budget', () => {
  const subject = 'session 标题：把 dsh-spec 的阶段命令改成确定性命名，包含很长的说明和 emoji 😀😀😀 结尾'
  const title = composePhaseTitle('explore', subject)
  assert.ok(bytes(title) <= 80)
  assert.ok(title.startsWith('[探索] '))
})

/** Build a fake session-title service that records accepted titles. */
function fakeTitleService(initial = {}) {
  const current = new Map(Object.entries(initial))
  const calls = []
  return {
    calls,
    current,
    service: {
      get(session) {
        return current.has(session.id) ? { title: current.get(session.id) } : undefined
      },
      rename(session, title) {
        calls.push({ sessionId: session.id, title })
        current.set(session.id, title)
        return { title }
      },
    },
  }
}

test('withPhaseTitle titles a successful result and returns it unchanged', () => {
  const { calls, service } = fakeTitleService()
  const session = { id: 'session-1' }
  const result = { kind: 'success', text: 'ok' }
  const returned = withPhaseTitle(
    { get: (key) => (key === 'sessionTitle' ? service : undefined) },
    { session },
    'explore',
    '缓存层怎么分层',
    result,
  )
  assert.equal(returned, result)
  assert.deepEqual(calls, [{ sessionId: 'session-1', title: '[探索] 缓存层怎么分层' }])
})

test('withPhaseTitle ignores every non-success result', () => {
  const { calls, service } = fakeTitleService()
  const ctx = { get: (key) => (key === 'sessionTitle' ? service : undefined) }
  const agent = { session: { id: 'session-1' } }
  const error = { kind: 'error', text: 'nope' }
  assert.equal(withPhaseTitle(ctx, agent, 'apply', 'add-x', error), error)
  assert.equal(withPhaseTitle(ctx, agent, 'apply', 'add-x', null), null)
  assert.deepEqual(calls, [])
})

test('withPhaseTitle skips an identical title (idempotent)', () => {
  const { calls, service } = fakeTitleService({ 'session-1': '[实施] add-x' })
  const ctx = { get: (key) => (key === 'sessionTitle' ? service : undefined) }
  const agent = { session: { id: 'session-1' } }
  const first = withPhaseTitle(ctx, agent, 'apply', 'add-x', { kind: 'success' })
  const second = withPhaseTitle(ctx, agent, 'apply', 'add-x', { kind: 'success' })
  assert.equal(first.kind, 'success')
  assert.equal(second.kind, 'success')
  assert.deepEqual(calls, [])
})

test('withPhaseTitle degrades when the service or session is absent', () => {
  const result = { kind: 'success', text: 'ok' }
  assert.equal(withPhaseTitle({}, { session: { id: 's' } }, 'explore', 'x', result), result)
  assert.equal(withPhaseTitle({ get: () => undefined }, { session: { id: 's' } }, 'explore', 'x', result), result)
  const { calls, service } = fakeTitleService()
  assert.equal(withPhaseTitle({ get: () => service }, {}, 'explore', 'x', result), result)
  assert.equal(
    withPhaseTitle({ get: () => service }, { session: null }, 'explore', 'x', result),
    result,
  )
  assert.deepEqual(calls, [])
})

test('withPhaseTitle swallows a rejected rename', () => {
  const result = { kind: 'success', text: 'ok' }
  const service = {
    get: () => undefined,
    rename() {
      throw new Error('session is not live')
    },
  }
  assert.equal(
    withPhaseTitle({ get: () => service }, { session: { id: 's' } }, 'archive', 'add-x', result),
    result,
  )
})

test('withPhaseTitle still titles a service that exposes no get()', () => {
  const calls = []
  const service = {
    rename(session, title) {
      calls.push(title)
      return { title }
    },
  }
  withPhaseTitle({ get: () => service }, { session: { id: 's' } }, 'propose', 'add-y', { kind: 'success' })
  assert.deepEqual(calls, ['[提案] add-y'])
})

test('withPhaseTitle ignores an unknown phase without failing the command', () => {
  const { calls, service } = fakeTitleService()
  const result = { kind: 'success', text: 'ok' }
  assert.equal(
    withPhaseTitle({ get: () => service }, { session: { id: 's' } }, 'bogus', 'x', result),
    result,
  )
  assert.deepEqual(calls, [])
})
