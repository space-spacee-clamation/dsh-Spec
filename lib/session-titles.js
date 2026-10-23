/**
 * dsh-spec — deterministic session titles for workflow phase commands.
 *
 * DSH titles are log-only `session/title` events owned by
 * `@deepseek-ai/dsh-session-title`. Its built-in fallback derives a title from
 * the first human prompt's leading words, so a phase command that submits an
 * expanded prompt would label the session with that prompt's opening heading
 * ("## Explore — think before changing anything"). This module gives each
 * successful phase command a deterministic `[<phase>] <subject>` title
 * instead; the title is cosmetic and never changes a command result.
 *
 * @module dsh-spec/session-titles
 */

/** Phase keys used by the command surface, mapped to their visible labels. */
export const PHASE_LABELS = {
  explore: '探索',
  propose: '提案',
  apply: '实施',
  update: '更新',
  sync: '同步',
  archive: '归档',
  synced: '已同步',
  archived: '已归档',
  product: '产品',
  design: '设计',
  dev: '开发',
  test: '测试',
  plan: '规划',
  pm: 'PM',
}

/**
 * Accepted-title byte budget mirroring the shipped `@deepseek-ai/dsh-session-title`
 * config (`maxTitleBytes: 80` in the base bundle). The service normalizes and
 * truncates again, which backstops a deployment with a smaller limit.
 */
const TITLE_MAX_BYTES = 80

/** One-character ellipsis marking a truncated subject (three UTF-8 bytes). */
const ELLIPSIS = '…'

/**
 * Collapse line breaks, control characters and repeated whitespace into one
 * trimmed line.
 * @param {unknown} subject raw topic or change name
 * @returns {string} single-line subject
 */
function normalizeSubject(subject) {
  return String(subject ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Longest leading code-point prefix within a UTF-8 byte budget.
 * @param {string} text normalized text
 * @param {number} maxBytes positive byte budget
 * @returns {string} prefix that never splits a code point
 */
function truncateUtf8(text, maxBytes) {
  let used = 0
  let output = ''
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Compose the deterministic title for one phase command.
 * @param {string} phase key from {@link PHASE_LABELS}
 * @param {string} [subject] exploration topic or change name
 * @returns {string} `[<label>] <subject>`, or `[<label>]` without a subject
 * @throws {Error} when the phase key is unknown (programming error)
 */
export function composePhaseTitle(phase, subject) {
  const label = PHASE_LABELS[phase]
  if (label === undefined) throw new Error(`unknown phase: ${phase}`)
  const prefix = `[${label}]`
  const normalized = normalizeSubject(subject)
  if (normalized.length === 0) return prefix
  const complete = `${prefix} ${normalized}`
  if (Buffer.byteLength(complete, 'utf8') <= TITLE_MAX_BYTES) return complete
  const budget = TITLE_MAX_BYTES - Buffer.byteLength(`${prefix} `, 'utf8') - Buffer.byteLength(ELLIPSIS, 'utf8')
  const head = truncateUtf8(normalized, budget).trimEnd()
  return head.length === 0 ? prefix : `${prefix} ${head}${ELLIPSIS}`
}

/**
 * Apply a phase title to one command's successful result.
 *
 * Only `{ kind: 'success' }` results are titled. The current title is compared
 * first so a repeated command appends no duplicate event, and every failure is
 * swallowed: a title never changes the command outcome.
 *
 * @param {object} ctx Host context; `ctx.get('sessionTitle')` is optional
 * @param {object} agent command invocation agent (may expose `session`)
 * @param {string} phase key from {@link PHASE_LABELS}
 * @param {string} [subject] exploration topic or change name
 * @param {object} result command result returned to DSH unchanged
 * @returns {object} the same result object
 */
export function withPhaseTitle(ctx, agent, phase, subject, result) {
  if (result === null || typeof result !== 'object' || result.kind !== 'success') return result
  try {
    const titles = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined
    const session = agent?.session
    if (titles === undefined || titles === null || typeof titles.rename !== 'function') return result
    if (session === undefined || session === null) return result
    const title = composePhaseTitle(phase, subject)
    if (typeof titles.get === 'function' && titles.get(session)?.title === title) return result
    titles.rename(session, title)
  } catch {
    // Cosmetic only: a rejected title must not fail the command.
  }
  return result
}
