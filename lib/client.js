/**
 * dsh-spec — browser half (source).
 *
 * This file is NOT a module: tools/build.mjs inlines it into the
 * `window.__ModuleLoader__.load({ id, factory })` closure that the DSH client
 * module system serves, exactly like a shipped `lib/client.js`. It may use
 * only the platform modules the shell seeds — here: `react`.
 *
 * Surfaces registered here:
 *   - `main` (keyed PANEL_ID)         — the openspec monitoring page
 *   - `sidebar.panellist`             — the page's sidebar glyph
 *   - `conversation.composer.dock`    — the quick phase command bar under the composer
 *   - `conversation.hero.options`     — the quick bar at the right end of the hero
 *                                       workspace row while the conversation is still
 *                                       blank, so the spec entry point is visible
 *                                       pre-conversation
 *
 * All workflow state is derived by the Host from the workspace's `openspec/`
 * files and fetched through `ctx.connection.rpc.call('/dsh-spec', method, …)`
 * — the browser half holds no copy of the native model. Session file watches
 * are only a refresh trigger; session-less workspaces poll the same route.
 * The plugin stores nothing of its own; files are the truth.
 *
 * Visual language: the plugin is part of the Harness UI, so it copies the
 * host's management-page patterns (20px page title, 13px secondary text,
 * 960px content column, settings-card surface, 32px primary buttons on
 * `--dsw-alias-button-primary-*`) and Modal conventions (fixed mask, 28px
 * panel radius, Esc/backdrop close, restored focus). Only `--dsw-*` theme
 * tokens are used for color, so light/dark and custom themes follow the host.
 */

function createOpenSpecPlugin(require) {
  const React = require('react')
  const h = React.createElement
  const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React

  // tools/build.mjs inlines src/client-helpers.js here (pure formatting helpers
  // shared with node --test); the marker line must stay in the factory body.
  /**
 * dsh-spec — pure client-side formatting helpers.
 *
 * This module is import-free ESM used twice:
 *  - `node --test` imports it directly (`tests/client-helpers.test.mjs`);
 *  - `tools/build.mjs` inlines it at the helper marker inside the browser
 *    factory (the `export ` keywords are stripped), so the helpers run
 *    as plain functions in the same closure as the panel components.
 *
 * Keep every function pure: locale text is passed in as a translate function
 * `t(key)`, never read from a module-level dictionary, and there is no I/O.
 * That keeps the panel's formatting testable without a DOM and keeps a single
 * implementation for the Markdown/React halves.
 *
 * @module dsh-spec/client-helpers
 */

/** Canonical display order for the well-known artifact ids (custom ids follow). */
const HELPER_ARTIFACT_ORDER = { proposal: 0, specs: 1, design: 2, tasks: 3 }

/** Delta operations in native display order. */
const HELPER_DELTA_OPERATIONS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']

/** Locale keys for each delta operation (`{count}` is replaced). */
const HELPER_DELTA_KEYS = {
  ADDED: 'deltaAdded',
  MODIFIED: 'deltaModified',
  REMOVED: 'deltaRemoved',
  RENAMED: 'deltaRenamed',
}

/** Locale keys for each artifact status chip. */
const HELPER_STATUS_KEYS = {
  done: 'artifactDone',
  skipped: 'artifactSkipped',
  ready: 'artifactReady',
  blocked: 'artifactBlocked',
}

/** Coerce to a non-negative integer, defaulting to 0. */
function helperNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Resolve one locale string and fill `{name}` placeholders.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {string} key - locale key; also the fallback text when `t` is absent.
 * @param {Record<string, unknown>} [vars] - placeholder values.
 * @returns {string} translated text with placeholders filled.
 */
function fillText(t, key, vars) {
  let text = typeof t === 'function' ? t(key) : key
  if (typeof text !== 'string') text = key
  if (vars !== undefined && vars !== null) {
    for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
  }
  return text
}

/**
 * Human label for an artifact id: `specs` -> `Specs`, `research` -> `Research`.
 *
 * @param {string} artifactId - schema artifact id.
 * @returns {string} display label (empty string for empty input).
 */
function artifactLabel(artifactId) {
  const raw = String(artifactId ?? '').trim()
  if (raw === '') return ''
  return raw
    .split(/[-_/]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Display rank of an artifact: canonical ids first, custom ids afterwards.
 *
 * @param {string} artifactId - schema artifact id.
 * @returns {number} lower sorts earlier.
 */
function artifactRank(artifactId) {
  const key = String(artifactId ?? '')
  return Object.prototype.hasOwnProperty.call(HELPER_ARTIFACT_ORDER, key) ? HELPER_ARTIFACT_ORDER[key] : 100
}

/**
 * Stable copy of an artifact list in display order (schema order kept for
 * custom ids, which therefore stay next to each other after the canonical set).
 *
 * @param {Array<{ id?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {Array<{ id?: string }>} ordered copy.
 */
function sortArtifacts(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts.slice() : []
  return list.sort((left, right) => artifactRank(left?.id) - artifactRank(right?.id))
}

/**
 * Tone family for one native artifact status; the client maps it to a
 * `--dsw-*` color token.
 *
 * @param {string} status - `done` | `skipped` | `ready` | `blocked`.
 * @returns {'success'|'muted'|'business'|'warn'} tone key.
 */
function artifactStatusTone(status) {
  if (status === 'done') return 'success'
  if (status === 'skipped') return 'muted'
  if (status === 'ready') return 'business'
  return 'warn'
}

/**
 * Localized artifact status chip text.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {string} status - `done` | `skipped` | `ready` | `blocked`.
 * @returns {string} chip text.
 */
function artifactStatusText(t, status) {
  const key = HELPER_STATUS_KEYS[status] ?? 'artifactUnknown'
  return fillText(t, key)
}

/**
 * Counts per native artifact status.
 *
 * @param {Array<{ status?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {{done: number, skipped: number, ready: number, blocked: number}} counts.
 */
function artifactStatusCounts(artifacts) {
  const counts = { done: 0, skipped: 0, ready: 0, blocked: 0 }
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const status = artifact?.status
    if (status === 'done' || status === 'skipped' || status === 'ready' || status === 'blocked') {
      counts[status] += 1
    }
  }
  return counts
}

/**
 * Planning progress across a change's artifacts: done and skipped both count as
 * satisfied, exactly like the native dependency graph.
 *
 * @param {Array<{ status?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {{done: number, total: number, percent: number}} progress summary.
 */
function artifactProgress(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : []
  const counts = artifactStatusCounts(list)
  const done = counts.done + counts.skipped
  const total = list.length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * Blocked artifacts with their missing dependencies.
 *
 * @param {Array<{ id?: string, status?: string, missingDeps?: string[] }>} artifacts - artifacts.
 * @returns {Array<{ id: string, missingDeps: string[] }>} blocked rows.
 */
function blockedArtifacts(artifacts) {
  const rows = []
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (artifact?.status !== 'blocked') continue
    const id = String(artifact.id ?? '')
    const missingDeps = Array.isArray(artifact.missingDeps) ? artifact.missingDeps.map((dep) => String(dep)) : []
    rows.push({ id, missingDeps })
  }
  return rows
}

/**
 * Counts per delta operation from `ChangeState.delta`.
 *
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number, files?: string[]}} [delta] - delta summary.
 * @returns {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number, total: number}} counts.
 */
function deltaOperationCounts(delta) {
  const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, total: 0 }
  for (const operation of HELPER_DELTA_OPERATIONS) {
    counts[operation] = helperNumber(delta?.[operation])
    counts.total += counts[operation]
  }
  return counts
}

/**
 * Localized one-line delta operation summary, e.g. `+2 新增 · 1 修改`.
 * Returns an empty string when the change has neither delta files nor counts.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number, files?: string[]}} [delta] - delta summary.
 * @returns {string} summary text (`·`-joined parts) or `''`.
 */
function deltaSummaryText(t, delta) {
  const counts = deltaOperationCounts(delta)
  const hasFiles = Array.isArray(delta?.files) && delta.files.length > 0
  if (!hasFiles && counts.total === 0) return ''
  return HELPER_DELTA_OPERATIONS.map((operation) => fillText(t, HELPER_DELTA_KEYS[operation], { count: counts[operation] })).join(' · ')
}

/**
 * Operation counts of one delta file row (`ChangeState.delta.files[]`).
 *
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number}} [file] - per-file delta row.
 * @returns {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number, total: number}} counts.
 */
function deltaFileOperationCounts(file) {
  const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, total: 0 }
  for (const operation of HELPER_DELTA_OPERATIONS) {
    counts[operation] = helperNumber(file?.[operation])
    counts.total += counts[operation]
  }
  return counts
}

/**
 * Localized per-file delta mix, e.g. `+2 新增 · 1 修改`. Zero-count operations
 * are omitted so a file row stays compact.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number}} [file] - per-file delta row.
 * @returns {string} summary text or `''` when the file has no operation counts.
 */
function deltaFileOpsText(t, file) {
  const counts = deltaFileOperationCounts(file)
  if (counts.total === 0) return ''
  return HELPER_DELTA_OPERATIONS.filter((operation) => counts[operation] > 0)
    .map((operation) => fillText(t, HELPER_DELTA_KEYS[operation], { count: counts[operation] }))
    .join(' · ')
}

/**
 * Pick the one-line summary rendered on a collapsed change card.
 *
 * Priority: `.openspec.yaml` `goal` → proposal `## Why` digest → the legacy
 * 0.9.x `description`/`headline` fields (still sent by an old Host) → none (the
 * panel shows a "no proposal yet" placeholder). The host already bounds the
 * digest, so this only trims and reports whether a full-text entry is needed.
 *
 * @param {{goal?: string|null, why?: string|null, description?: string|null, headline?: string|null, whyTruncated?: boolean, changesHidden?: number, changesTruncated?: boolean}|null} [summary] - `ChangeState.summary`.
 * @returns {{text: string, source: 'goal'|'why'|'description'|'headline'|'none', truncated: boolean}} summary candidate.
 */
function changeSummaryInfo(summary) {
  const goal = typeof summary?.goal === 'string' ? summary.goal.trim() : ''
  if (goal !== '') return { text: goal, source: 'goal', truncated: false }
  const why = typeof summary?.why === 'string' ? summary.why.trim() : ''
  if (why !== '') {
    const truncated =
      summary?.whyTruncated === true || summary?.changesTruncated === true || helperNumber(summary?.changesHidden) > 0
    return { text: why, source: 'why', truncated }
  }
  const description = typeof summary?.description === 'string' ? summary.description.trim() : ''
  if (description !== '') return { text: description, source: 'description', truncated: false }
  const headline = typeof summary?.headline === 'string' ? summary.headline.trim() : ''
  if (headline !== '') return { text: headline, source: 'headline', truncated: false }
  return { text: '', source: 'none', truncated: false }
}

/**
 * Localized text helper: first non-empty trimmed string.
 *
 * @param {...unknown} values - candidates in priority order.
 * @returns {string} first non-empty trimmed text, else `''`.
 */
function helperFirstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text !== '') return value
  }
  return ''
}

/**
 * Non-empty string list copy; anything else degrades to `[]`.
 *
 * @param {unknown} value - candidate list.
 * @returns {string[]} only non-blank string entries.
 */
function helperStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : []
}

/**
 * Normalize the bounded proposal digest from the Host.
 *
 * A 0.10.0 Host sends `summary.why` / `summary.changes`; a 0.9.x Host only sends
 * `summary.description` / `summary.highlights`, so those legacy fields fill the
 * same slots here. A pre-0.9 Host has no `summary` at all, in which case every
 * field degrades to an empty value instead of crashing the card (the panel then
 * re-reads `proposal.md` through `proposalSummaryDigest`).
 *
 * @param {object|null|undefined} value - raw `ChangeState.summary`.
 * @returns {{goal: string|null, why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}} normalized digest.
 */
function normalizeChangeSummary(value) {
  const summary = value !== null && typeof value === 'object' ? value : {}
  const why = helperFirstText(summary.why, summary.description)
  const nativeChanges = helperStringList(summary.changes)
  const changes = nativeChanges.length > 0 ? nativeChanges : helperStringList(summary.highlights)
  return {
    goal: typeof summary.goal === 'string' && summary.goal.trim() !== '' ? summary.goal : null,
    why: why === '' ? null : why,
    whyTruncated: summary.whyTruncated === true,
    changes,
    changesHidden: helperNumber(summary.changesHidden),
    changesTruncated: summary.changesTruncated === true,
  }
}

/** Character budget of the `## Why` digest (mirrors the 0.10.0 Host payload). */
const HELPER_SUMMARY_WHY_CHARS = 280
/** Character budget of one `## What Changes` bullet. */
const HELPER_SUMMARY_CHANGE_CHARS = 140
/** Row budget of the `## What Changes` digest. */
const HELPER_SUMMARY_CHANGE_ROWS = 4

/** Level-2 markdown heading (`## Why`). */
const HELPER_H2_HEADING = /^##\s+(.+?)\s*$/
/** Any markdown heading (a level-2 section ends at the next heading of any level). */
const HELPER_ANY_HEADING = /^#{1,6}\s+/
/** A bullet or ordered-list item (any indent, used when skipping prose). */
const HELPER_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/
/** A top-level bullet only; indented nested bullets are not digest rows (same rule as the Host). */
const HELPER_TOP_LEVEL_LIST_ITEM = /^(?:[-*+])\s+(\S.*)$/
/** A fenced code block delimiter. */
const HELPER_FENCE = /^\s*(?:```|~~~)/

/** Preferred headings that introduce the proposal motivation paragraph. */
const HELPER_WHY_HEADINGS = ['why', 'motivation', 'background', 'rationale', '背景', '动机', '为什么']
/** Preferred headings that introduce the proposal change list. */
const HELPER_CHANGE_HEADINGS = [
  'what changes',
  'what changed',
  'changes',
  'change summary',
  'summary of changes',
  '变更内容',
  '改动内容',
  '变更摘要',
]

/** Collapse whitespace runs into single spaces and trim. */
function helperCollapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Cap text at a character budget without splitting surrogate pairs (`…` marks truncation). */
function helperCap(value, maxChars) {
  const text = helperCollapse(value)
  if (text.length <= maxChars) return text
  let output = ''
  let used = 0
  for (const character of text) {
    if (used >= Math.max(1, maxChars - 1)) break
    output += character
    used += character.length
  }
  return `${output.trimEnd()}…`
}

/** Strip the most common inline markdown so the panel shows prose, not syntax. */
function helperStripInlineMarkdown(value) {
  return helperCollapse(
    String(value ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/<[^>]+>/g, ''),
  )
}

/**
 * Split a document into level-2 sections: lower-cased heading text → body lines.
 * Fenced code blocks are inert; any higher/lower heading closes the section.
 *
 * @param {string[]} lines - normalized document lines.
 * @returns {Map<string, string[]>} sections in source order.
 */
function helperSectionMap(lines) {
  /** @type {Map<string, string[]>} */
  const sections = new Map()
  let current
  let inFence = false
  for (const line of lines) {
    if (HELPER_FENCE.test(line)) {
      inFence = !inFence
      if (current !== undefined) current.push(line)
      continue
    }
    if (!inFence) {
      const heading = HELPER_H2_HEADING.exec(line)
      if (heading !== null) {
        current = []
        sections.set(heading[1].trim().toLowerCase(), current)
        continue
      }
      if (HELPER_ANY_HEADING.test(line)) {
        current = undefined
        continue
      }
    }
    if (current !== undefined) current.push(line)
  }
  return sections
}

/**
 * First matching section body from a preferred heading list.
 *
 * @param {Map<string, string[]>} sections - section map.
 * @param {string[]} names - preferred lower-case headings.
 * @returns {string[]|undefined} body lines when the section exists.
 */
function helperPreferredSection(sections, names) {
  for (const name of names) {
    const body = sections.get(name)
    if (body !== undefined) return body
  }
  return undefined
}

/**
 * First non-empty prose paragraph in a body (bullets/headings/fences/quotes skipped).
 *
 * @param {string[]|undefined} body - section lines.
 * @returns {string} plain paragraph text.
 */
function helperFirstParagraph(body) {
  const lines = Array.isArray(body) ? body : []
  const paragraph = []
  let inFence = false
  for (const line of lines) {
    if (HELPER_FENCE.test(line)) {
      inFence = !inFence
      if (paragraph.length > 0) break
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (trimmed === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (HELPER_ANY_HEADING.test(trimmed) || HELPER_LIST_ITEM.test(trimmed) || /^>\s?/.test(trimmed)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed)
  }
  return helperStripInlineMarkdown(paragraph.join(' '))
}

/**
 * Top-level bullet entries of a section body, in source order.
 *
 * Mirrors the Host digest: indented nested bullets and ordered lists are not
 * separate rows, so the panel's `共 N 条` matches the new Host exactly.
 *
 * @param {string[]|undefined} body - section lines.
 * @returns {string[]} plain entries.
 */
function helperListItems(body) {
  const lines = Array.isArray(body) ? body : []
  const items = []
  let inFence = false
  for (const line of lines) {
    if (HELPER_FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = HELPER_TOP_LEVEL_LIST_ITEM.exec(line)
    if (match === null) continue
    const text = helperStripInlineMarkdown(match[1])
    if (text !== '') items.push(text)
  }
  return items
}

/**
 * Derive a bounded change digest from `proposal.md` text.
 *
 * This mirrors the Host's 0.10.0 `summary` digest. The browser half only needs
 * it when the running Host predates that payload (a long-lived DSH process
 * keeps the Host loaded while a page refresh picks up the new client), so the
 * L1 "why / what changes" overview still has content in a mixed-version setup.
 *
 * @param {string|null|undefined} markdown - proposal document text.
 * @returns {{why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}|null} digest, or `null` when the document has neither section.
 */
function proposalSummaryDigest(markdown) {
  const lines = String(markdown ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  if (lines.join('').trim() === '') return null
  const sections = helperSectionMap(lines)
  let whyText = helperFirstParagraph(helperPreferredSection(sections, HELPER_WHY_HEADINGS))
  if (whyText === '') {
    // No `## Why`: use the first prose paragraph anywhere after the title.
    whyText = helperFirstParagraph(lines.slice(1))
  }
  const changeItems = helperListItems(helperPreferredSection(sections, HELPER_CHANGE_HEADINGS))
  const why = whyText === '' ? null : helperCap(whyText, HELPER_SUMMARY_WHY_CHARS)
  const whyTruncated = whyText.length > HELPER_SUMMARY_WHY_CHARS
  const kept = changeItems.slice(0, HELPER_SUMMARY_CHANGE_ROWS)
  const changes = kept.map((item) => helperCap(item, HELPER_SUMMARY_CHANGE_CHARS))
  if (why === null && changes.length === 0) return null
  return {
    why,
    whyTruncated,
    changes,
    changesHidden: Math.max(0, changeItems.length - kept.length),
    changesTruncated: kept.some((item) => item.length > HELPER_SUMMARY_CHANGE_CHARS),
  }
}

/**
 * The `proposal.md` row of a change's document list (null when absent).
 *
 * @param {{docs?: Array<object>}|null|undefined} change - normalized `ChangeState`.
 * @returns {{path: string}|null} document row.
 */
function proposalDocOf(change) {
  const docs = Array.isArray(change?.docs) ? change.docs : []
  const usable = docs.filter(
    (doc) => doc !== null && typeof doc === 'object' && typeof doc.path === 'string' && doc.path !== '' && doc.kind !== 'delta',
  )
  for (const doc of usable) {
    if (String(doc.artifactId ?? '') === 'proposal') return doc
  }
  const fallback = usable.find((doc) => String(doc.path).replace(/\\/g, '/').endsWith('proposal.md'))
  return fallback ?? null
}

/**
 * Whether a normalized summary still lacks the `## Why` paragraph (the panel's
 * L1 overview would show the "no proposal yet" placeholder).
 *
 * @param {{why?: string|null}|null|undefined} summary - normalized `ChangeState.summary`.
 * @returns {boolean} true when a proposal re-read can fill it.
 */
function summaryNeedsProposalFallback(summary) {
  const why = typeof summary?.why === 'string' ? summary.why.trim() : ''
  return why === ''
}

/**
 * Merge a locally derived proposal digest into a summary without overwriting
 * values the Host already supplied. Truncation flags follow whichever source
 * filled the slot, so "查看全文" entries stay honest.
 *
 * @param {object|null|undefined} summary - raw `ChangeState.summary`.
 * @param {{why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}|null} digest - output of {@link proposalSummaryDigest}.
 * @returns {object} merged summary (a new object when `summary` is not one).
 */
function applyProposalDigest(summary, digest) {
  const base = summary !== null && typeof summary === 'object' ? summary : {}
  if (digest === null || typeof digest !== 'object') return base
  const hasWhy = typeof base.why === 'string' && base.why.trim() !== ''
  const baseChanges = helperStringList(base.changes)
  const hasChanges = baseChanges.length > 0
  const digestWhy = typeof digest.why === 'string' && digest.why !== '' ? digest.why : null
  const digestChanges = helperStringList(digest.changes)
  return {
    ...base,
    why: hasWhy ? base.why : digestWhy,
    whyTruncated: base.whyTruncated === true || (!hasWhy && digest.whyTruncated === true),
    changes: hasChanges ? baseChanges : digestChanges,
    changesHidden: hasChanges ? helperNumber(base.changesHidden) : helperNumber(digest.changesHidden),
    changesTruncated: hasChanges ? base.changesTruncated === true : digest.changesTruncated === true,
    source: typeof base.source === 'string' && base.source !== 'none' ? base.source : 'proposal',
  }
}

/**
 * Normalize per-file delta rows. Accepts the native `{path,label,...counts}`
 * rows and the legacy string path list so a mixed Host/client version still
 * renders both.
 *
 * @param {Array<object|string>|null|undefined} files - raw `ChangeState.delta.files`.
 * @returns {Array<{path: string, label: string, ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}>} normalized rows.
 */
function normalizeDeltaFiles(files) {
  const list = Array.isArray(files) ? files : []
  /** @type {Array<{path: string, label: string, ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}>} */
  const rows = []
  for (const file of list) {
    if (typeof file === 'string') {
      if (file === '') continue
      rows.push({ path: file, label: '', ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 })
      continue
    }
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' ? file.path : ''
    if (path === '') continue
    rows.push({
      path,
      label: typeof file.label === 'string' ? file.label : '',
      ADDED: helperNumber(file.ADDED),
      MODIFIED: helperNumber(file.MODIFIED),
      REMOVED: helperNumber(file.REMOVED),
      RENAMED: helperNumber(file.RENAMED),
    })
  }
  return rows
}

/**
 * Totals of the bounded `## What Changes` digest: how many items are shown and
 * how many the host left out (so the panel can render `共 N 条` explicitly).
 *
 * @param {{changes?: string[], changesHidden?: number, changesTruncated?: boolean}|null} [summary] - `ChangeState.summary`.
 * @returns {{shown: number, total: number, truncated: boolean}} digest totals.
 */
function changeDigestTotals(summary) {
  const shown = Array.isArray(summary?.changes) ? summary.changes.filter((item) => typeof item === 'string' && item.trim() !== '').length : 0
  const hidden = helperNumber(summary?.changesHidden)
  return { shown, total: shown + hidden, truncated: summary?.changesTruncated === true || hidden > 0 }
}

/**
 * Group a change's documents by schema artifact for the progressive detail view.
 *
 * Only groups with something to show are returned (plus the `tasks` group, which
 * also hosts the missing-task-list note, and a final `metadata` group). Delta
 * documents are matched against `delta.files` so each row carries its own
 * operation counts, and every document appears in exactly one group.
 *
 * @param {object} change - normalized `ChangeState`.
 * @returns {Array<{id: string, kind: 'artifact'|'delta'|'metadata', title: string, status: string, description: string, docs: Array<object>, deltas: Array<object>}>} groups in schema artifact order, metadata last.
 */
function groupChangeDocuments(change) {
  const docs = Array.isArray(change?.docs)
    ? change.docs.filter((doc) => doc !== null && typeof doc === 'object' && typeof doc.path === 'string' && doc.path !== '')
    : []
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  const deltaFiles = Array.isArray(change?.delta?.files)
    ? change.delta.files
        .map((file) => {
          if (typeof file === 'string') return { path: file, label: '', ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
          if (file !== null && typeof file === 'object' && typeof file.path === 'string') return file
          return null
        })
        .filter((file) => file !== null && file.path !== '')
    : []
  const usedDocs = new Set()
  const deltaFileFor = (doc) => {
    const path = String(doc.path).replace(/\\/g, '/')
    const match = deltaFiles.find((file) => path === file.path || path.endsWith(`/${file.path}`))
    const label = match !== undefined && typeof match.label === 'string' && match.label !== '' ? match.label : typeof doc.label === 'string' ? doc.label : ''
    if (match !== undefined) return { ...match, label }
    return { path, label, ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
  }
  /** @type {Array<object>} */
  const groups = []
  const pushGroup = (id, artifact) => {
    const ownDocs = docs.filter((doc) => String(doc.artifactId ?? '') === id && !usedDocs.has(doc))
    for (const doc of ownDocs) usedDocs.add(doc)
    const plainDocs = ownDocs.filter((doc) => doc.kind !== 'delta')
    const deltas = ownDocs.filter((doc) => doc.kind === 'delta').map(deltaFileFor)
    if (plainDocs.length === 0 && deltas.length === 0 && id !== 'tasks') return
    groups.push({
      id,
      kind: deltas.length > 0 ? 'delta' : 'artifact',
      title: id,
      status: typeof artifact?.status === 'string' ? artifact.status : '',
      description: typeof artifact?.description === 'string' ? artifact.description : '',
      docs: plainDocs,
      deltas,
    })
  }
  const seenIds = new Set()
  for (const artifact of artifacts) {
    const id = artifact !== null && typeof artifact === 'object' && typeof artifact.id === 'string' ? artifact.id : ''
    if (id === '' || seenIds.has(id)) continue
    seenIds.add(id)
    pushGroup(id, artifact)
  }
  // Defensive: documents whose artifact is not part of the derived artifact list.
  /** @type {string[]} */
  const leftoverIds = []
  for (const doc of docs) {
    if (usedDocs.has(doc)) continue
    const id = typeof doc.artifactId === 'string' && doc.artifactId !== '' ? doc.artifactId : 'docs'
    if (!leftoverIds.includes(id)) leftoverIds.push(id)
  }
  for (const id of leftoverIds) pushGroup(id, undefined)
  groups.push({ id: 'metadata', kind: 'metadata', title: 'metadata', status: '', description: '', docs: [], deltas: [] })
  return groups
}

/**
 * One-line overview status: artifact / task progress, capability count, open
 * validation issues (only when non-zero) and the native next step.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {object} change - normalized `ChangeState`.
 * @returns {string} ` · `-joined status text.
 */
function changeOverviewFacts(t, change) {
  /** @type {string[]} */
  const parts = []
  const artifacts = artifactProgress(change?.artifacts)
  if (artifacts.total > 0) parts.push(`${fillText(t, 'artifactsLabel')} ${artifacts.done}/${artifacts.total}`)
  const progress = taskProgressInfo(change?.tasks)
  if (progress.total > 0) parts.push(`${fillText(t, 'taskList')} ${progress.done}/${progress.total}`)
  const deltaFiles = Array.isArray(change?.delta?.files) ? change.delta.files.length : 0
  if (deltaFiles > 0) parts.push(fillText(t, 'overviewCapabilities', { count: deltaFiles }))
  const issues = helperNumber(change?.validation?.errors) + helperNumber(change?.validation?.warnings)
  if (issues > 0) parts.push(validationSummaryText(t, change.validation))
  parts.push(`${fillText(t, 'quickNext')}：${nextActionText(t, deriveNextAction(change))}`)
  return parts.join(' · ')
}

/**
 * Change name of one archive row: `2026-10-20-add-dark-mode` -> `add-dark-mode`.
 *
 * @param {{name?: string, changeName?: string}} [entry] - archive row.
 * @returns {string} display name.
 */
function archiveEntryLabel(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  if (typeof entry.changeName === 'string' && entry.changeName !== '') return entry.changeName
  const name = String(entry.name ?? '')
  const match = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(name)
  return match === null ? name : match[1]
}

/**
 * Local archive date of one row (explicit `date` first, then the name prefix).
 *
 * @param {{name?: string, date?: string}} [entry] - archive row.
 * @returns {string|null} `YYYY-MM-DD` or `null` when unknown.
 */
function archiveEntryDate(entry) {
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return entry.date
  const name = String(entry.name ?? '')
  const match = /^(\d{4}-\d{2}-\d{2})-/.exec(name)
  return match === null ? null : match[1]
}

/**
 * Group archived changes by local archive date: newest date first, entries
 * alphabetically inside a group, unknown dates last.
 *
 * @param {Array<{name?: string, changeName?: string, date?: string}>} archived - `WorkspaceState.archived`.
 * @returns {Array<{date: string|null, entries: Array<object>}>} groups.
 */
function groupArchivedByLocalDate(archived) {
  const groups = new Map()
  for (const entry of Array.isArray(archived) ? archived : []) {
    if (entry === null || typeof entry !== 'object') continue
    const date = archiveEntryDate(entry)
    const key = date === null ? '' : date
    let group = groups.get(key)
    if (group === undefined) {
      group = { date, entries: [] }
      groups.set(key, group)
    }
    group.entries.push(entry)
  }
  const list = [...groups.values()]
  list.sort((left, right) => {
    if (left.date === null && right.date === null) return 0
    if (left.date === null) return 1
    if (right.date === null) return -1
    return right.date.localeCompare(left.date)
  })
  for (const group of list) group.entries.sort((left, right) => archiveEntryLabel(left).localeCompare(archiveEntryLabel(right)))
  return list
}

/**
 * One page of a list, never silently dropping the tail: callers grow the
 * `pageSize` (or advance `offset`) until `hasNext` is false and show
 * {@link moreItemsText} for the rest.
 *
 * @param {Array<unknown>} items - full list.
 * @param {{offset?: number, pageSize?: number}} [options] - slice options.
 * @returns {{items: Array<unknown>, offset: number, pageSize: number, total: number, shown: number, hidden: number, nextOffset: number, hasPrev: boolean, hasNext: boolean}} page info.
 */
function paginate(items, options) {
  const list = Array.isArray(items) ? items : []
  const pageSize = helperNumber(options?.pageSize) > 0 ? helperNumber(options?.pageSize) : 8
  let offset = helperNumber(options?.offset)
  if (offset > list.length) offset = list.length
  const slice = list.slice(offset, offset + pageSize)
  return {
    items: slice,
    offset,
    pageSize,
    total: list.length,
    shown: slice.length,
    hidden: Math.max(0, list.length - offset - slice.length),
    nextOffset: offset + slice.length,
    hasPrev: offset > 0,
    hasNext: offset + slice.length < list.length,
  }
}

/**
 * "There is more" text, used instead of silently truncating a list.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {number} count - hidden item count.
 * @returns {string} localized hint.
 */
function moreItemsText(t, count) {
  return fillText(t, 'moreItems', { count: helperNumber(count) })
}

/**
 * Localized validation summary (`2 错误 · 1 警告`) or the clean-state text.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{errors?: number, warnings?: number}} [validation] - validation summary.
 * @returns {string} summary text.
 */
function validationSummaryText(t, validation) {
  const errors = helperNumber(validation?.errors)
  const warnings = helperNumber(validation?.warnings)
  if (errors === 0 && warnings === 0) return fillText(t, 'validationClean')
  return fillText(t, 'validationSummary', { errors, warnings })
}

/**
 * One-line issue location: `path:line`, `path` or `line`.
 *
 * @param {{path?: string, line?: number}} [issue] - validation issue.
 * @returns {string} location label.
 */
function validationIssueLocation(issue) {
  const path = typeof issue?.path === 'string' ? issue.path : ''
  const line = typeof issue?.line === 'number' && Number.isFinite(issue.line) && issue.line > 0 ? Math.floor(issue.line) : null
  if (path === '') return line === null ? '' : String(line)
  return line === null ? path : `${path}:${line}`
}

/**
 * Tone family for one validation issue level.
 *
 * @param {string} level - `ERROR` | `WARNING` | `INFO`.
 * @returns {'error'|'warn'|'info'} tone key.
 */
function issueLevelTone(level) {
  if (level === 'ERROR') return 'error'
  if (level === 'WARNING') return 'warn'
  return 'info'
}

/**
 * Document-reader truncation notice (`{total} 行文档，仅显示前 {shown} 行`).
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{shown?: number, totalLines?: number|null}} [info] - reader state.
 * @returns {string} notice text.
 */
function documentTruncationText(t, info) {
  const shown = helperNumber(info?.shown)
  const totalLines = typeof info?.totalLines === 'number' && Number.isFinite(info.totalLines) && info.totalLines > 0 ? Math.floor(info.totalLines) : null
  if (totalLines === null) return fillText(t, 'docTruncatedSimple', { shown })
  return fillText(t, 'docTruncated', { shown, total: totalLines })
}

/**
 * Number of lines a truncated reader has displayed so far.
 *
 * @param {string} text - displayed document text.
 * @returns {number} 1-based count of displayed lines (0 for empty text).
 */
function documentShownLines(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  return value.split(/\r?\n/).length
}

/**
 * Task progress from a `{total, done}` pair (`ChangeState.tasks`).
 *
 * @param {{total?: number, done?: number}|null} [tasks] - task counts.
 * @returns {{total: number, done: number, remaining: number, percent: number, complete: boolean}} progress.
 */
function taskProgressInfo(tasks) {
  const total = helperNumber(tasks?.total)
  const done = Math.min(helperNumber(tasks?.done), total)
  return {
    total,
    done,
    remaining: total - done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done >= total,
  }
}

/**
 * Localized task progress text (`3/7`); empty when there is no task list.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{total?: number, done?: number}|null} [tasks] - task counts.
 * @returns {string} progress text.
 */
function taskProgressText(t, tasks) {
  const info = taskProgressInfo(tasks)
  if (info.total === 0) return ''
  return fillText(t, 'taskProgress', { done: info.done, total: info.total })
}

/** Round an integer ratio to a whole percent (0 for an empty denominator). */
function helperPercent(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0
}

/**
 * Workspace overview progress: two independent meters, one per workflow stage.
 *
 * `artifacts` counts planning artifacts (done and skipped are both satisfied,
 * exactly like the native dependency graph); `tasks` counts tracked checkboxes
 * across the changes that have a task list. The two meters never merge — a fully
 * planned workspace can still have an unfinished task meter — which is what the
 * panel's dual rings show side by side.
 *
 * @param {Array<{artifacts?: object[], tasks?: {total?: number, done?: number}|null}>} changes - `WorkspaceState.changes`.
 * @returns {{changes: number, artifacts: {done: number, total: number, percent: number, empty: boolean}, tasks: {done: number, total: number, percent: number, empty: boolean}, hasContent: boolean}} stage meters.
 */
function workspaceProgress(changes) {
  const list = Array.isArray(changes) ? changes : []
  let artifactDone = 0
  let artifactTotal = 0
  let taskDone = 0
  let taskTotal = 0
  for (const change of list) {
    if (change === null || typeof change !== 'object') continue
    const artifacts = artifactProgress(change.artifacts)
    artifactDone += artifacts.done
    artifactTotal += artifacts.total
    const tasks = taskProgressInfo(change.tasks)
    taskDone += tasks.done
    taskTotal += tasks.total
  }
  return {
    changes: list.length,
    artifacts: {
      done: artifactDone,
      total: artifactTotal,
      percent: helperPercent(artifactDone, artifactTotal),
      empty: artifactTotal === 0,
    },
    tasks: {
      done: taskDone,
      total: taskTotal,
      percent: helperPercent(taskDone, taskTotal),
      empty: taskTotal === 0,
    },
    hasContent: artifactTotal > 0 || taskTotal > 0,
  }
}

/**
 * Render view of one change's task checklist (`ChangeState.tasks`).
 *
 * `missing` marks "the Host sent no detail rows at all" (older Host, the panel
 * can only offer the raw `tasks.md`); `limited` marks "more tracked tasks exist
 * than the capped payload carries" (`total - items.length` remain unloaded).
 *
 * @param {{total?: number, done?: number, items?: Array<{id?: unknown, text?: unknown, done?: unknown, depth?: unknown, line?: unknown, manual?: unknown}>}|null} [tasks] - `ChangeState.tasks`.
 * @returns {{total: number, done: number, remaining: number, percent: number, complete: boolean, items: Array<{id: string|null, text: string, done: boolean, depth: number, line: number|null, manual: boolean}>, shown: number, hidden: number, missing: boolean, limited: boolean}} checklist view.
 */
function taskChecklistView(tasks) {
  const info = taskProgressInfo(tasks)
  const raw = Array.isArray(tasks?.items) ? tasks.items : []
  const items = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    items.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : null,
      text: String(item.text ?? ''),
      done: item.done === true,
      depth: Number.isInteger(item.depth) && item.depth >= 0 ? Math.min(item.depth, 3) : 0,
      line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
      manual: item.manual === true,
    })
  }
  const hidden = items.length > 0 ? Math.max(0, info.total - items.length) : 0
  return {
    total: info.total,
    done: info.done,
    remaining: info.remaining,
    percent: info.percent,
    complete: info.complete,
    items,
    shown: items.length,
    hidden,
    missing: info.total > 0 && items.length === 0,
    limited: items.length > 0 && hidden > 0,
  }
}

/**
 * Pending tasks across every active change, split into human-acceptance and
 * other work.
 *
 * The panel's "waiting for acceptance" list is an aggregate view: one row per
 * unchecked task, with the owning change so the row can open its `tasks.md`.
 * Only the capped `tasks.items` payload is available, so changes with more than
 * 200 tasks expose the first 200; the per-change detail already surfaces the
 * remaining count.
 *
 * @param {Array<{name?: unknown, tasks?: {items?: Array<{id?: unknown, text?: unknown, done?: unknown, line?: unknown, manual?: unknown}>}|null}>|undefined} changes
 * @returns {{total: number, manual: Array<{change: string, id: string|null, text: string, line: number|null, manual: boolean}>, automatic: Array<{change: string, id: string|null, text: string, line: number|null, manual: boolean}>}}
 */
function pendingAcceptanceTasks(changes) {
  const manual = []
  const automatic = []
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change === null || typeof change !== 'object') continue
    const changeName = typeof change.name === 'string' ? change.name : ''
    if (changeName === '') continue
    const items = Array.isArray(change.tasks?.items) ? change.tasks.items : []
    for (const item of items) {
      if (item === null || typeof item !== 'object' || item.done === true) continue
      const rawText = String(item.text ?? '')
      const isManual = item.manual === true || /(?:\[|【)\s*人工验收\s*(?:\]|】)/.test(rawText)
      const text = rawText.replace(/(?:\[|【)\s*人工验收\s*(?:\]|】)/g, '').replace(/\s+/g, ' ').trim()
      const row = {
        change: changeName,
        id: typeof item.id === 'string' && item.id !== '' ? item.id : null,
        text: text === '' ? rawText.trim() : text,
        line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
        manual: isManual,
      }
      ;(isManual ? manual : automatic).push(row)
    }
  }
  const byChange = (left, right) => {
    if (left.change !== right.change) return left.change < right.change ? -1 : 1
    const leftLine = left.line ?? Number.MAX_SAFE_INTEGER
    const rightLine = right.line ?? Number.MAX_SAFE_INTEGER
    if (leftLine !== rightLine) return leftLine - rightLine
    return String(left.id ?? '').localeCompare(String(right.id ?? ''))
  }
  manual.sort(byChange)
  automatic.sort(byChange)
  return { total: manual.length + automatic.length, manual, automatic }
}

/**
 * Native task checkbox count from `tasks.md` text (archive-view fallback where
 * the host state only exposes per-change task counts).
 * Parity with `src/native/tasks.js`: `-`/`*`/`+` bullets; `[x]`/`[X]` (either
 * side spacing) is done; any other marker is an unfinished task; a link bullet
 * like `- [docs](url)` is not a task; an empty task still counts.
 *
 * @param {string} text - `tasks.md` content.
 * @returns {{total: number, done: number}} task counts.
 */
function countTaskCheckboxes(text) {
  let total = 0
  let done = 0
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^(\s*)[-*+]\s+\[([^\]]*)\](.*)$/.exec(line)
    if (match === null) continue
    const marker = match[2].trim()
    const rest = match[3]
    if (marker !== '' && /^\s*\(/.test(rest)) continue
    total += 1
    if (marker === 'x' || marker === 'X') done += 1
  }
  return { total, done }
}

/**
 * Localized schema source label (`项目` project-local / `内置` bundled snapshot).
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {string} [source] - `project` | `builtin`.
 * @returns {string} source label.
 */
function schemaSourceText(t, source) {
  if (source === 'project') return fillText(t, 'schemaProject')
  if (source === 'builtin') return fillText(t, 'schemaBuiltin')
  return fillText(t, 'schemaUnknown')
}

/**
 * The native next step for one change, derived only from the host state
 * (never from the legacy four-phase ordering).
 *
 * @param {{name?: string, artifacts?: Array<{id?: string, status?: string}>, isPlanningComplete?: boolean, listStatus?: string}|undefined} change - `ChangeState`.
 * @returns {{kind: 'update'|'apply'|'archive'|'propose', labelKey: string, line: string}} next action.
 */
function deriveNextAction(change) {
  if (change === null || change === undefined) {
    return { kind: 'propose', labelKey: 'nextActionPropose', line: '/opsx-propose ' }
  }
  const name = String(change.name ?? '')
  if (change.isPlanningComplete !== true) {
    // A half-generated plan is completed by re-running propose: it resumes the
    // existing change (keeping `.openspec.yaml` and satisfied artifacts) and
    // creates only the missing artifacts. update only revises existing files,
    // so it can never finish an interrupted plan.
    return { kind: 'propose', labelKey: 'nextActionResume', line: `/opsx-propose ${name}` }
  }
  if (change.listStatus === 'complete') {
    // The panel/quick-bar "Archive" button fills the composer with the default
    // /opsx-archive command, i.e. the OPSX AI archive workflow (completion
    // check, merge confirmation, validation, deterministic move). The
    // deterministic fast path stays available only when the user explicitly
    // adds `--yes` (or asks for a `--dry-run` preview).
    return { kind: 'archive', labelKey: 'nextActionArchive', line: `/opsx-archive ${name}` }
  }
  return { kind: 'apply', labelKey: 'nextActionApply', line: `/opsx-apply ${name}` }
}

/**
 * Localized label for a {@link deriveNextAction} result.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{labelKey?: string}|undefined} action - next action.
 * @returns {string} button label.
 */
function nextActionText(t, action) {
  return fillText(t, action?.labelKey ?? 'nextActionApply')
}

/** The host commands that act on one change and therefore take a change name. */
const CHANGE_PICKER_COMMANDS = Object.freeze([
  'opsx-update',
  'opsx-apply',
  'opsx-sync',
  'opsx-archive',
  'opsx-validate',
])

/**
 * Whether the Web client's change picker should take over a bare change command.
 *
 * Only the ambiguous case needs the picker: two or more changes in motion. A
 * single change keeps the host's auto-selection, and a loading / missing / error
 * workspace keeps the host's own diagnostics, so the picker never hides a more
 * accurate host message.
 *
 * @param {{status?: string, changes?: Array<object>}|undefined} state - `WorkspaceState`.
 * @returns {boolean} true when the picker should intercept the command.
 */
function changePickerAvailable(state) {
  if (state === null || state === undefined || state.status !== 'ready') return false
  const changes = Array.isArray(state.changes) ? state.changes : []
  return changes.length >= 2
}

/**
 * Composer line filled after one picker row is chosen:
 * `/opsx-<command> <change-name> ` — the trailing space lets the user append a
 * revision request or flags before submitting.
 *
 * @param {string} command - command name, with or without its leading slash ({@link CHANGE_PICKER_COMMANDS}).
 * @param {string} changeName - picked change name, preserved verbatim.
 * @returns {string} composer draft line.
 */
function changePickerLine(command, changeName) {
  const name = String(command ?? '').replace(/^\/+/, '')
  const change = String(changeName ?? '').trim()
  return `/${name} ${change} `
}

/** Locale keys for the picker's per-change workflow state. */
const HELPER_PICKER_STATE_KEYS = {
  planning: 'pickerPlanning',
  apply: 'pickerApply',
  complete: 'pickerComplete',
}

/**
 * Compact native status summary for one change row.
 *
 * @param {object} change - `ChangeState`.
 * @param {((key: string) => string) | undefined} t - translate function.
 * @returns {string} ` · `-joined summary text.
 */
function changePickerDetail(change, t) {
  const parts = []
  let stateKey = HELPER_PICKER_STATE_KEYS.planning
  if (change.isPlanningComplete === true) {
    stateKey = change.listStatus === 'complete' ? HELPER_PICKER_STATE_KEYS.complete : HELPER_PICKER_STATE_KEYS.apply
  }
  parts.push(fillText(t, stateKey))
  const progress = taskProgressInfo(change.tasks)
  if (progress.total > 0) parts.push(fillText(t, 'pickerTasks', { done: progress.done, total: progress.total }))
  const errors = helperNumber(change?.validation?.errors)
  if (errors > 0) parts.push(fillText(t, 'pickerErrors', { count: errors }))
  const warnings = helperNumber(change?.validation?.warnings)
  if (warnings > 0) parts.push(fillText(t, 'pickerWarnings', { count: warnings }))
  if (change?.metadata?.skip_specs === true) parts.push(fillText(t, 'skipSpecs'))
  return parts.join(' · ')
}

/**
 * One picker row per change in motion: `label` is the change name (the popup
 * shell renders it) and `detail` is the compact native status summary. Rows
 * without a usable name are filtered instead of rendering an empty option.
 *
 * @param {{status?: string, changes?: Array<object>}|undefined} state - `WorkspaceState`.
 * @param {((key: string) => string) | undefined} t - translate function.
 * @returns {Array<{name: string, label: string, detail: string}>} picker options.
 */
function changePickerOptions(state, t) {
  if (state === null || state === undefined || state.status !== 'ready') return []
  const changes = Array.isArray(state.changes) ? state.changes : []
  return changes
    .filter((change) => change !== null && typeof change === 'object' && typeof change.name === 'string' && change.name !== '')
    .map((change) => ({
      name: change.name,
      label: change.name,
      detail: changePickerDetail(change, t),
    }))
}

/**
 * Flatten capability specs into a nested-path ordered row list:
 * `identity/user-auth` renders as a group row `identity` plus a child row
 * `user-auth`, instead of one flat name containing slashes.
 *
 * @param {Array<{name?: string}>} specs - `WorkspaceState.specs`.
 * @returns {Array<{kind: 'group'|'spec', label: string, fullName: string, depth: number, spec?: object}>} rows.
 */
function groupSpecsByPath(specs) {
  const list = (Array.isArray(specs) ? specs : []).filter((spec) => spec !== null && typeof spec === 'object' && typeof spec.name === 'string' && spec.name !== '')
  const rows = []
  const walk = (items, prefix, depth) => {
    const buckets = new Map()
    for (const spec of items) {
      const rest = prefix === '' ? spec.name : spec.name.slice(prefix.length + 1)
      const slash = rest.indexOf('/')
      const segment = slash === -1 ? rest : rest.slice(0, slash)
      let bucket = buckets.get(segment)
      if (bucket === undefined) {
        bucket = { segment, specs: [] }
        buckets.set(segment, bucket)
      }
      bucket.specs.push(spec)
    }
    const segments = [...buckets.keys()].sort((left, right) => left.localeCompare(right))
    for (const segment of segments) {
      const bucket = buckets.get(segment)
      const fullName = prefix === '' ? segment : `${prefix}/${segment}`
      const direct = bucket.specs.filter((spec) => (prefix === '' ? spec.name : spec.name.slice(prefix.length + 1)) === segment)
      const children = bucket.specs.filter((spec) => !direct.includes(spec))
      if (children.length > 0) {
        rows.push({ kind: 'group', label: segment, fullName, depth, spec: undefined })
      }
      const childDepth = children.length > 0 ? depth + 1 : depth
      for (const spec of direct.slice().sort((left, right) => left.name.localeCompare(right.name))) {
        rows.push({ kind: 'spec', label: segment, fullName, depth: childDepth, spec })
      }
      if (children.length > 0) walk(children, fullName, childDepth)
    }
  }
  walk(list.slice().sort((left, right) => left.name.localeCompare(right.name)), '', 0)
  return rows
}

/* -------------------------------------------------------------------- *
 * Human reports — date ranges, output naming and report preferences.
 *
 * The report dialog is pure browser UI: the Host only composes the prompt
 * (`report-prompt`) and reports whether a report already exists
 * (`report-status`). Range defaulting, the output file name and the tolerant
 * per-workspace `localStorage` shape stay pure so they are testable without a
 * DOM. Local dates are computed with the browser's own calendar (no UTC
 * conversion): an archived change belongs to the calendar day the user saw.
 * -------------------------------------------------------------------- */

/** Default report root, workspace-relative (the Host resolves it). */
const HELPER_REPORT_ROOT = '人类文档'

/** Days covered by the default period report range: today plus six days back. */
const HELPER_REPORT_RANGE_DAYS = 6

/** Coerce a timestamp / Date to finite epoch milliseconds (fallback: now). */
function helperReportTime(nowValue) {
  const raw = nowValue instanceof Date ? nowValue.getTime() : typeof nowValue === 'number' ? nowValue : Number.NaN
  return Number.isFinite(raw) ? raw : Date.now()
}

/**
 * Local calendar date of a moment as `YYYY-MM-DD`.
 *
 * @param {number|Date} [nowValue] - epoch milliseconds (or Date); defaults to now.
 * @returns {string} local `YYYY-MM-DD`.
 */
function reportLocalDate(nowValue = Date.now()) {
  const date = new Date(helperReportTime(nowValue))
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Default period report range: `to` is today, `from` is six days earlier
 * (both inclusive), so the dialog opens on the last seven local days.
 *
 * @param {number|Date} [nowValue] - epoch milliseconds (or Date); defaults to now.
 * @returns {{from: string, to: string}} inclusive local date range.
 */
function reportDefaultRange(nowValue = Date.now()) {
  const time = helperReportTime(nowValue)
  const start = new Date(time)
  start.setDate(start.getDate() - HELPER_REPORT_RANGE_DAYS)
  return { from: reportLocalDate(start.getTime()), to: reportLocalDate(time) }
}

/**
 * Archived changes whose archive date falls inside an inclusive range.
 *
 * Rows without a usable `YYYY-MM-DD` date are excluded (the period prompt has
 * no way to place them). An empty `from` / `to` bound is tolerated as
 * "unbounded" so a partially typed range never crashes the dialog. The result
 * is sorted by date, then display name, matching the report's change list.
 *
 * @param {Array<{name?: string, changeName?: string, date?: string}>} archived - `WorkspaceState.archived`.
 * @param {string} from - inclusive lower bound `YYYY-MM-DD`.
 * @param {string} to - inclusive upper bound `YYYY-MM-DD`.
 * @returns {Array<object>} matching rows in report order.
 */
function reportArchivedInRange(archived, from, to) {
  const start = typeof from === 'string' ? from.trim() : ''
  const end = typeof to === 'string' ? to.trim() : ''
  const rows = []
  for (const entry of Array.isArray(archived) ? archived : []) {
    if (entry === null || typeof entry !== 'object') continue
    const date = archiveEntryDate(entry)
    if (date === null) continue
    if (start !== '' && date < start) continue
    if (end !== '' && date > end) continue
    rows.push(entry)
  }
  rows.sort((left, right) => {
    const leftDate = archiveEntryDate(left) ?? ''
    const rightDate = archiveEntryDate(right) ?? ''
    if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1
    return archiveEntryLabel(left).localeCompare(archiveEntryLabel(right))
  })
  return rows
}

/**
 * Normalize the user-entered report root: trimmed, POSIX separators, no
 * trailing slash, defaulting to `人类文档`. Absolute paths are preserved (the
 * dialog warns that DSH's file policy may reject them).
 *
 * @param {unknown} value - raw input value.
 * @returns {string} normalized report root.
 */
function normalizeReportRoot(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return HELPER_REPORT_ROOT
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === '' ? HELPER_REPORT_ROOT : normalized
}

/** Trim one path segment (change name / range half) to a POSIX-safe piece. */
function helperReportSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/**
 * Workspace-relative output path of a report:
 * `<root>/<change-name>/index.html` for one change, or
 * `<root>/<from>_<to>/index.html` for a period report.
 *
 * The archive-folder mode is intentionally not handled here: it is a single
 * archive path (`openspec/changes/archive/<dir>/report.html`) owned by the Host.
 *
 * @param {{scope?: 'change'|'range', root?: unknown, changeName?: unknown, from?: unknown, to?: unknown}} [options] - report target.
 * @returns {string} workspace-relative POSIX path.
 */
function reportOutputRelPath(options) {
  const root = normalizeReportRoot(options?.root)
  if (options?.scope === 'range') {
    const from = helperReportSegment(options?.from)
    const to = helperReportSegment(options?.to)
    return `${root}/${from}_${to}/index.html`
  }
  const change = helperReportSegment(options?.changeName)
  return change === '' ? `${root}/index.html` : `${root}/${change}/index.html`
}

/**
 * Stable, separator-normalized workspace key of the report settings (same
 * shape as the change bindings' key, so per-workspace preferences line up).
 *
 * @param {string} cwd - absolute workspace root.
 * @returns {string} normalized key.
 */
function reportSettingsCwdKey(cwd) {
  return String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Coerce an arbitrary localStorage value into the report settings shape:
 * `{version: 1, workspaces: {<cwdKey>: {root, mode}}}` where `mode` is
 * `'root'` (report root) or `'archive'` (single-change report inside the
 * archive folder). Unknown keys, malformed workspaces and bad modes degrade to
 * defaults instead of throwing.
 *
 * @param {unknown} value - parsed localStorage value.
 * @returns {{version: 1, workspaces: Record<string, {root: string, mode: 'root'|'archive'}>}} settings.
 */
function normalizeReportSettings(value) {
  const settings = value !== null && typeof value === 'object' ? value : {}
  const rawWorkspaces = settings.workspaces !== null && typeof settings.workspaces === 'object' ? settings.workspaces : {}
  /** @type {Record<string, {root: string, mode: 'root'|'archive'}>} */
  const workspaces = {}
  for (const [rawCwd, rawWorkspace] of Object.entries(rawWorkspaces)) {
    const key = reportSettingsCwdKey(rawCwd)
    if (key === '') continue
    const workspace = rawWorkspace !== null && typeof rawWorkspace === 'object' ? rawWorkspace : {}
    workspaces[key] = {
      root: normalizeReportRoot(workspace.root),
      mode: workspace.mode === 'archive' ? 'archive' : 'root',
    }
  }
  return { version: 1, workspaces }
}

/**
 * Defensive view of one `report-status` result, always with every field the
 * dialog renders (a pre-0.11 Host answers nothing useful, which must read as
 * "not generated", not crash the dialog).
 *
 * @param {unknown} value - raw `report-status` value.
 * @param {'change'|'range'} [scope] - requested scope (wins over the payload).
 * @returns {{scope: 'change'|'range', exists: boolean, path: string|null, absolutePath: string|null, generatedAt: string|null, source: string, included: Array<{name: string, changePath: string, date: string|null}>, includedCount: number}} status.
 */
function normalizeReportStatus(value, scope) {
  const status = value !== null && typeof value === 'object' ? value : {}
  const requested = scope === 'range' || scope === 'change' ? scope : status.scope === 'range' ? 'range' : 'change'
  const path = typeof status.path === 'string' && status.path.trim() !== '' ? status.path : null
  const included = Array.isArray(status.included)
    ? status.included
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name : '',
          changePath: typeof item.changePath === 'string' ? item.changePath : '',
          date: typeof item.date === 'string' && item.date.trim() !== '' ? item.date : null,
        }))
        .filter((item) => item.name !== '' || item.changePath !== '')
    : []
  // `report-status` reports a period's included count as a number (the prompt
  // action returns the full entry list); expose both without guessing.
  const includedCount =
    typeof status.included === 'number' && Number.isFinite(status.included) && status.included > 0
      ? Math.floor(status.included)
      : included.length
  return {
    scope: requested,
    exists: status.exists === true && path !== null,
    path,
    absolutePath: typeof status.absolutePath === 'string' && status.absolutePath.trim() !== '' ? status.absolutePath : null,
    generatedAt: typeof status.generatedAt === 'string' && status.generatedAt.trim() !== '' ? status.generatedAt : null,
    source: typeof status.source === 'string' ? status.source : '',
    included,
    includedCount,
  }
}

  /** Sidebar row id and the `main` dispatch key — the SAME string in both. */
  const PANEL_ID = 'openspec'
  /** The composer-dock entry id. */
  const DOCK_ID = 'openspec-quickbar'
  /** Locale namespace registered in apply(). */
  const NS = 'openSpec'
  /** Host route: read-only native state plus the session-less init write. */
  const ROUTE = '/dsh-spec'
  /** Debounce for watch-driven refreshes. */
  const REFRESH_DEBOUNCE_MS = 400
  /** Session-less workspaces poll the Host route while the panel is open. */
  const POLL_MS = 2000
  /** Poll fallback for a session workspace whose directory watch failed. */
  const FALLBACK_POLL_MS = 5000
  /** Upper bound for one Host route call so a lost RPC cannot hang the UI. */
  const RPC_TIMEOUT_MS = 15000
  /** How long an inline result banner stays visible. */
  const NOTICE_MS = 5000
  /** List paging sizes — no list is silently truncated. */
  const CHANGE_PAGE_SIZE = 6
  const SPEC_PAGE_SIZE = 8
  const ARCHIVE_PAGE_SIZE = 10
  const ISSUE_PAGE_SIZE = 5
  /** Rows per group in the aggregate "waiting for acceptance" list. */
  const PENDING_PAGE_SIZE = 8
  /** Lines fetched per document page (the Host route reports truncation). */
  const DOC_PAGE_LINES = 2000
  /** How long a proposal re-read for the summary fallback stays fresh. */
  const SUMMARY_FALLBACK_TTL_MS = 10000
  /** Line budget of the fallback proposal read (the Host caps one page at 4000). */
  const SUMMARY_FALLBACK_LINES = 4000

  /** All user-visible copy lives here. */
  const T = {
    zh: {
      panel: 'OpenSpec',
      title: 'OpenSpec 工作流',
      subtitle: '进度只存在于 openspec/ 的文件里，这里只是它的实时视图。',
      refresh: '刷新',
      refreshAll: '刷新全部',
      loading: '正在读取 openspec/ …',
      nosession: '这里还没有已知的工作区会话。',
      nosessionHint: '在这个工作区开始对话后，这里会显示对应的 openspec/ 状态。',
      missing: '此工作区还没有 openspec/',
      missingHint: '初始化会生成 config.yaml、specs/ 与 changes/archive/ 骨架；之后 AI 就能用 /opsx-* 命令开始规格流程。',
      init: '初始化 OpenSpec',
      initBusy: '初始化中…',
      retry: '重试',
      error: '读取失败',
      noChanges: '还没有进行中的变更',
      noChangesHint: '用「提案」开始一个变更，或用「探索」先想清楚要做什么。',
      newProposal: '新建提案',
      changeCount: '{count} 个变更',
      archived: '已归档 {count} 个变更',
      watchDown: '目录监听不可用，已改用轮询刷新。',
      pollingHint: '面板每 2 秒向 Host 轮询一次最新状态；变更进行中时会话状态也会即时刷新。',
      workspaceLabel: '工作区',
      specOverview: 'Spec 概览',
      activeChanges: '进行中的变更',
      capabilitySpecs: '已定稿 Spec',
      archivedChanges: '已归档',
      archivedHint: '按归档时间倒序沉底展示',
      noCapabilities: '还没有定稿的 Spec',
      noCapabilitiesHint: '实施并归档变更后，delta specs 会同步到这里。',
      noArchived: '还没有归档的变更。',
      noDocs: '没有可查看的文档',
      docs: '文档',
      taskList: '任务清单',
      tasksDone: '{done}/{total} 已完成',
      progressLabel: '任务进度',
      phaseDistribution: '阶段分布',
      statActive: '进行中',
      statSpecs: '能力 Spec',
      statArchived: '已归档',
      loadingDoc: '正在读取文档…',
      readDocFailed: '读取文档失败',
      docEmpty: '这个文档是空的。',
      viewDoc: '查看文档',
      expand: '展开',
      collapse: '收起',
      archiveDated: '{date} 归档',
      noTasks: '还没有任务清单',
      moreTasks: '还有 {count} 项',
      expandTasks: '展开剩余 {count} 项',
      collapseTasks: '收起',
      taskItemsMissing: '当前 Host 未提供任务明细，重启 DSH 后可用',
      taskItemsHidden: '还有 {count} 项未载入，打开 tasks.md 查看',
      openTasksDoc: '打开 tasks.md',
      alignDoc: '去工作区对齐',
      alignDraft: '对齐这份文档：{path}',
      alignBusy: '正在新建会话…',
      requirementCount: '{count} 项需求',
      switchFailed: '没有可用会话，无法切换到该工作区',
      explore: '探索',
      propose: '提案',
      apply: '实施',
      applyContinue: '继续实施',
      archive: '归档',
      status: '状态',
      openPanel: '打开 OpenSpec 面板',
      phaseDraft: '草稿',
      phaseProposed: '待评审',
      phaseApply: '实施中',
      phaseReady: '待归档',
      files: '工件',
      close: '关闭',
      fillComposer: '填入输入框',
      insertFailed: '没找到输入框。',
      commandFailed: '命令执行失败',
      commandSent: '已发送',
      quickMissing: '未初始化',
      quickNoChange: '无进行中变更',
      switchChange: '切换变更',
      taskProgress: '{done}/{total}',
      enterHint: 'Enter 确认 · Esc 取消',
      artifactDone: '完成',
      artifactSkipped: '跳过',
      artifactReady: '可创建',
      artifactBlocked: '阻塞',
      artifactUnknown: '未知',
      artifactsLabel: '工件',
      artifactProgress: '工件进度',
      artifactStatus: '工件状态',
      artifactSource: '工件 {id}',
      missingDeps: '缺少依赖：{deps}',
      skipSpecs: '跳过 specs',
      retireCaps: '归档后移除能力',
      schemaLabel: 'Schema',
      schemaProject: '项目',
      schemaBuiltin: '内置',
      schemaUnknown: '未知',
      configSection: '项目配置',
      configMissing: '未找到 openspec/config.yaml，使用默认 schema：{schema}',
      effectiveSchema: '生效 Schema',
      contextLabel: 'Context',
      contextEmpty: '未配置项目 context',
      contextShow: '展开完整 context',
      contextHide: '收起 context',
      rulesLabel: 'Rules',
      rulesEmpty: '没有按 artifact 配置的 rules',
      rulesCount: '{count} 条',
      operationsLabel: 'Operations',
      operationApply: 'apply 指导',
      operationArchive: 'archive 指导',
      schemasSection: '可用 Schema',
      schemaArtifacts: '工件：{items}',
      validationLabel: '校验',
      validationClean: '无校验问题',
      validationSummary: '{errors} 错误 · {warnings} 警告',
      issuesList: '校验问题',
      showMoreItems: '显示另外 {count} 个',
      moreItems: '还有 {count} 个',
      allItemsShown: '已显示全部 {count} 个',
      deltaSection: 'Delta 操作',
      deltaAdded: '+{count} 新增',
      deltaModified: '{count} 修改',
      deltaRemoved: '{count} 删除',
      deltaRenamed: '{count} 重命名',
      deltaEmpty: '没有 delta 文件',
      deltaFiles: 'delta 文件',
      nextSteps: '下一步建议',
      noNextSteps: '没有额外建议',
      nextActionPropose: '提案',
      nextActionUpdate: '继续规划',
      nextActionResume: '继续规划',
      nextActionApply: '实施',
      nextActionArchive: '归档',
      metadataLabel: '.openspec.yaml',
      metaSchema: 'Schema',
      metaCreated: '创建',
      metaGoal: '目标',
      metaSkip: '跳过 specs',
      metaRetire: '归档后移除能力',
      metaMissing: '没有 .openspec.yaml（按项目配置推导）',
      metaNone: '—',
      capabilityTitle: '能力 Spec',
      capabilityPurpose: 'Purpose',
      scenarioCount: '{count} 场景',
      specIssues: '{count} 问题',
      archiveUnknownDate: '未知日期',
      archiveSectionTitle: '已归档变更',
      archiveTasks: '任务',
      archiveMetadata: '元数据',
      archiveArtifacts: '工件',
      archiveProbeNote: '归档详情按已知工件名读取；自定义/glob 工件请直接在仓库中查看。',
      archiveLoadFailed: '读取归档详情失败',
      archiveDetailLoading: '正在读取归档详情…',
      quickNext: '下一步',
      nativeSkills: '原生技能',
      nativeSkillsTitle: '检测到原生 OpenSpec skills：{names}',
      fallbackSkills: '内置技能',
      fallbackSkillsTitle: '未检测到原生 skills，使用插件内置的文件语义 fallback。',
      nativeSkillsCount: '{count} 个',
      docTruncated: '{total} 行文档，仅显示前 {shown} 行',
      docTruncatedSimple: '仅显示前 {shown} 行',
      docShowMore: '继续读取（{count} 行）',
      docReadMoreFailed: '读取后续内容失败',
      docAtLine: '已定位到第 {line} 行',
      docFullscreen: '放大阅读',
      docExitFullscreen: '退出放大',
      validateAction: '校验',
      validating: '校验中…',
      validateTitle: '校验结果',
      validateDesc: '由 Host 原生校验引擎只读计算，不写任何文件。',
      validateFailed: '校验失败',
      syncPreviewAction: '同步预览',
      syncPreviewTitle: 'Spec 同步预览',
      syncPreviewDesc: '只读预览；确认后执行 /opsx-sync --yes 走确定性写入，或直接 /opsx-sync 让 AI 按 OPSX 工作流智能合并。',
      syncPreviewFailed: '同步预览失败',
      initCreated: '新建：{items}',
      initAlready: '没有需要新建的文件。',
      blockedCount: '{count} 阻塞',
      changesBlockedHint: '有 artifact 因缺少依赖被阻塞。',
      workspaceWarnings: '工作区警告',
      changeSchema: 'Schema {name}',
      noIssues: '没有校验问题',
      docsFromSchema: '按生效 schema 的 generates 列出',
      summaryPending: '尚未生成提案',
      summaryMore: '查看全文',
      summaryChangesTotal: '共 {count} 条',
      summaryAllChanges: '展开全部 {count} 条',
      overviewWhy: '为什么做',
      overviewChanges: '会改什么',
      overviewImpact: '影响状态',
      overviewCapabilities: '{count} 个 capability',
      docGroups: '文档',
      specChangesGroup: '规格变更',
      metadataGroup: '元数据',
      docGroupCount: '{count} 个文档',
      docGroupFiles: '{count} 个文件',
      artifactProposal: '提案',
      artifactDesign: '设计',
      artifactTasks: '任务',
      plannerComplete: '规划完成',
      planning: '规划中',
      loadingArchive: '正在读取归档…',
      customArtifactsNote: '自定义/glob 工件已按 generates 展开；未列出的内容不会静默丢弃。',
      pickerSearch: '搜索进行中的变更…',
      pickerEmpty: '没有进行中的变更，先用 /opsx-propose 创建一个。',
      pickerNoResults: '没有匹配的变更',
      pickerLoadFailed: '读取变更状态失败',
      pickerPlanning: '规划中',
      pickerApply: '可实施',
      pickerComplete: '已完成',
      pickerTasks: '任务 {done}/{total}',
      pickerErrors: '{count} ERROR',
      pickerWarnings: '{count} WARNING',
      changeSummary: '变更说明',
      changeSummaryEmpty: '暂无变更说明（proposal.md 缺少 Why / What Changes）。',
      changeHighlights: '变更内容',
      highlightMore: '还有 {count} 项',
      pendingAcceptance: '等待验收',
      pendingManual: '人工验收',
      pendingAutomatic: '其他待办',
      pendingBreakdown: '人工 {manual} · 其他 {automatic}',
      pendingEmpty: '没有等待验收的任务。',
      pendingOpenTask: '打开任务清单',
      pendingLimited: '部分变更的任务超过单次载入上限（200 条）；未列出的任务请打开各自 tasks.md 查看。',
      statusPlanning: '规划中',
      statusImplementing: '实施中',
      statusReady: '待实施',
      statusComplete: '已完成',
      statusRunning: '进行中',
      statusWaiting: '等待确认',
      statusArchived: '已归档',
      statusDesc: '由 Host 原生引擎直接计算，不占模型 token。',
      statusRunHint: '该变更绑定的会话正在执行，完成前不能重复发起规划/实施操作。',
      statusWaitHint: '该变更绑定的会话正在等待你确认（权限或问题），请先处理会话里的弹窗。',
      boundSession: '绑定会话',
      openSession: '打开会话',
      boundSessionMissing: '绑定的会话已不存在，下次操作会新建一个。',
      sessionShort: '会话 {id}',
      exploreDialogTitle: '探索',
      exploreDialogDesc: '先想清楚要做什么。探索是只读的，不会改动文件；点「开始探索」会直接发送到会话，不需要再按回车。',
      exploreTopicLabel: '想讨论什么（可留空）',
      exploreTopicPlaceholder: '例如：实时状态轮询应该怎么做？',
      exploreStart: '开始探索',
      proposeDialogTitle: '新建提案',
      proposeDialogDesc: '描述这个变更要做什么。提交后 AI 会先总结描述、自动选择 change 名，再创建变更与规划工件；点「开始提案」直接发送到会话，不需要再按回车。',
      proposeDescriptionLabel: '变更描述',
      proposeDescriptionPlaceholder: '例如：支持 OpenSpec 面板实时显示变更状态，并禁止对进行中的变更重复操作。',
      proposeAutoNameHint: '变更名由 AI 根据描述总结生成，创建完成后会显示在面板里；如需指定名称，可直接输入 /opsx-propose <name> <描述>。',
      proposeStart: '开始提案',
      proposeRequired: '请先填写变更描述。',
      dialogCancel: '取消',
      commandSentTo: '已发送到会话',
      commandSending: '正在发送…',
      commandSendFailed: '发送失败',
      commandDrafted: '命令已填入输入框，请手动发送',
      manualTask: '人工验收',
      manualTaskHint: '该任务需要人工验收，完成后可在这里手动勾选。',
      taskToggleFailed: '更新任务失败',
      taskToggling: '正在更新…',
      orchestration: '多角色任务',
      orchestrationHint: '每个子任务独立会话；角色只读依赖工件与 handoff，不共享对话。',
      orchestrationEmpty: '还没有多角色任务。',
      orchestrationEmptyHint: '创建一个程序，把目标拆成多个子任务，并为产品 / 设计 / 开发 / 测试分配模型。',
      orchestrationNew: '新建多角色任务',
      orchestrationCreateTitle: '新建多角色任务',
      orchestrationCreateDesc: '只需填写最终目标和四个角色模型；AI 会自动拆分子任务、生成程序标题与 change 名，再创建原生 change。',
      orchestrationGoalPlaceholder: '例如：为游戏新增一套技能系统，包含火球术、治疗术、冰盾，并接入现有战斗流程。',
      orchestrationAutoPlanHint: '提交后会打开一个规划会话：AI 只写任务拆分文件，Host 校验后再创建 change；不会直接写业务代码。',
      orchestrationGenerate: '生成任务',
      orchestrationGenerating: 'AI 正在拆分任务…',
      orchestrationPlanningWait: '规划任务已发送；AI 会先把拆分写入 .plans 文件，Host 校验后才创建 change。请稍候。',
      orchestrationGenerated: '任务已自动生成，产品角色已就绪。',
      orchestrationPlanTimeout: 'AI 未在 5 分钟内生成任务拆分；请检查规划会话，或重试。',
      orchestrationPlanFailed: '任务拆分失败',
      orchestrationTitle: '任务标题',
      orchestrationId: '程序 ID（英文）',
      orchestrationGoal: '最终目标',
      orchestrationTasks: '子任务',
      orchestrationTasksHint: '每行：change | 标题 | 描述 | 依赖1,依赖2',
      orchestrationRoles: '角色模型',
      orchestrationModelHint: '留空跟随会话默认；格式 provider/model',
      orchestrationAutoOn: '自动推进中',
      orchestrationAutoOff: '自动推进',
      orchestrationAutoPause: '暂停自动',
      orchestrationAutoHint: 'PM 按门禁自动启动已就绪角色；用户验收仍由你完成。',
      orchestrationPm: 'PM 巡检',
      orchestrationPmRunning: 'PM 巡检中…',
      orchestrationPmSent: 'PM 巡检任务已发送。',
      orchestrationPmStatus: 'PM 巡检报告',
      orchestrationPmNone: 'PM 还没有巡检报告。',
      orchestrationModels: '模型',
      orchestrationSave: '保存',
      orchestrationSaved: '角色模型已保存',
      orchestrationCreate: '创建',
      orchestrationCreating: '创建中…',
      orchestrationRequired: '请先填写最终目标。',
      orchestrationTask: '子任务',
      orchestrationDeps: '依赖',
      orchestrationStart: '开始',
      orchestrationContinue: '继续',
      orchestrationRunning: '运行中',
      orchestrationWaiting: '等待',
      orchestrationDone: '完成',
      orchestrationReady: '可开始',
      orchestrationAccept: '验收',
      orchestrationAccepted: '已验收',
      orchestrationWaitingTest: '等待测试',
      orchestrationProgress: '{done}/{total} 任务',
      orchestrationModel: '模型 {model}',
      orchestrationNoModel: '会话默认模型',
      orchestrationStartFailed: '启动角色失败',
      orchestrationAcceptFailed: '验收失败',
      notifyDoneTitle: 'OpenSpec · {change} 已完成',
      notifyDoneBody: 'AI 会话已结束本轮工作，变更任务已全部完成，可以验收或归档。',
      notifyTurnTitle: 'OpenSpec · {change} 本轮结束',
      notifyTurnBody: 'AI 已结束本轮工作，可以继续下一步操作。',
      notifyPendingTitle: 'OpenSpec · {change} 需要确认',
      notifyPendingBody: '会话正在等待你的权限确认或问题回答，请打开会话处理。',
      notifyPendingGeneric: '有 OpenSpec 会话在等待你的确认。',
      notifyRolePendingTitle: 'OpenSpec · {task} / {role} 需要确认',
      notifyRoleTurnTitle: 'OpenSpec · {task} / {role} 本轮结束',
      notifyHint: '点击打开对应会话',
      notificationsBlocked: '浏览器未授权系统通知，已改为面板内提示。',
      autoProposeTimeoutTitle: 'OpenSpec · 自动命名未完成',
      autoProposeTimeoutBody: 'AI 没有在 10 分钟内创建新的变更目录；请检查会话，或手动执行 /opsx-propose <name>。',
      // 人类报告：单变更 / 时间段入口、报告对话框与沙箱预览。
      reportEntry: '报告',
      reportPeriodEntry: '按时间段生成报告',
      reportDialogTitle: '生成人类报告',
      reportDialogDesc: '报告先定位这项工作在主线上的位置，再展开细节；提交只把报告提示词填入会话输入框，不自动发送。',
      reportScopeChange: '单个变更',
      reportScopeRange: '时间段',
      reportRangeFrom: '起始日期',
      reportRangeTo: '结束日期',
      reportRangeHint: '按归档日期统计，含首尾两天。',
      reportIncludedCount: '区间内 {count} 个已归档变更',
      reportIncludedList: '纳入的变更',
      reportChangeLabel: '变更',
      reportDateLabel: '归档日期',
      reportOutputPath: '输出路径',
      reportRootLabel: '报告目录',
      reportRootHint: '工作区相对目录，默认「人类文档」；绝对路径仅支持工作区内。',
      reportRootPlaceholder: '人类文档',
      reportArchiveMode: '写入归档目录（report.html）',
      reportStatusLabel: '报告状态',
      reportStatusMissing: '未生成',
      reportStatusGenerated: '已生成',
      reportGeneratedAt: '生成时间 {time}',
      reportStatusLoading: '读取中…',
      reportStatusFailed: '读取失败',
      reportGenerate: '生成报告提示词',
      reportRegenerate: '重新生成',
      reportPreview: '预览',
      reportCopyPath: '复制路径',
      reportPromptFilled: '提示词已填入输入框，请手动发送',
      reportPathCopied: '报告路径已复制',
      reportCopyFailed: '复制失败，请手动复制路径',
      reportPreviewTitle: '预览报告',
      reportPreviewNote: '预览在禁用脚本的沙箱中渲染，不执行报告内脚本；显示异常时可复制路径用浏览器打开。',
      reportPreviewTruncated: '报告较大，预览只显示前 {shown} 行。',
      reportPreviewUnavailable: '预览不可用',
      reportWarningAbsolute: '报告目录必须位于当前工作区内；工作区外的绝对路径会被拒绝',
      reportWarningRangeOrder: '起始日期晚于结束日期',
      reportWarningRangeMissing: '请选择起始与结束日期',
      reportWarningRangeEmpty: '区间内没有已归档变更',
      reportComposeMissing: '无法定位目标会话输入框，报告提示词未填入',
    },
    en: {
      panel: 'OpenSpec',
      title: 'OpenSpec workflow',
      subtitle: 'Progress lives only in the openspec/ files — this is its live view.',
      refresh: 'Refresh',
      refreshAll: 'Refresh all',
      loading: 'Reading openspec/ …',
      nosession: 'No known workspace session here yet.',
      nosessionHint: 'Start a conversation in this workspace and its openspec/ state appears here.',
      missing: 'This workspace has no openspec/ yet',
      missingHint: 'Initializing writes config.yaml, specs/ and changes/archive/; the AI can then run the /opsx-* spec loop.',
      init: 'Initialize OpenSpec',
      initBusy: 'Initializing…',
      retry: 'Retry',
      error: 'Read failed',
      noChanges: 'No change in motion',
      noChangesHint: 'Start one with Propose, or think it through with Explore first.',
      newProposal: 'New proposal',
      changeCount: '{count} changes',
      archived: '{count} archived changes',
      watchDown: 'Directory watch unavailable; falling back to polling.',
      pollingHint: 'The panel polls the Host for fresh state every 2s; session status refreshes immediately while a change is running.',
      workspaceLabel: 'Workspace',
      specOverview: 'Spec overview',
      activeChanges: 'Changes in motion',
      capabilitySpecs: 'Capability specs',
      archivedChanges: 'Archived',
      archivedHint: 'Newest first, kept at the bottom',
      noCapabilities: 'No capability spec yet',
      noCapabilitiesHint: 'Archiving a change syncs its delta specs here.',
      noArchived: 'No archived change yet.',
      noDocs: 'No document to view',
      docs: 'Documents',
      taskList: 'Tasks',
      tasksDone: '{done}/{total} done',
      progressLabel: 'Task progress',
      phaseDistribution: 'Phase split',
      statActive: 'Active',
      statSpecs: 'Capabilities',
      statArchived: 'Archived',
      loadingDoc: 'Reading document…',
      readDocFailed: 'Failed to read the document',
      docEmpty: 'This document is empty.',
      viewDoc: 'View document',
      expand: 'Expand',
      collapse: 'Collapse',
      archiveDated: 'archived {date}',
      noTasks: 'No task list yet',
      moreTasks: '{count} more',
      expandTasks: 'Show remaining {count}',
      collapseTasks: 'Collapse',
      taskItemsMissing: 'Task details are not provided by this Host yet — restart DSH',
      taskItemsHidden: '{count} more tasks not loaded — open tasks.md',
      openTasksDoc: 'Open tasks.md',
      alignDoc: 'Align in workspace',
      alignDraft: 'Align on this document: {path}',
      alignBusy: 'Starting a session…',
      requirementCount: '{count} requirements',
      switchFailed: 'No session available to open this workspace.',
      explore: 'Explore',
      propose: 'Propose',
      apply: 'Apply',
      applyContinue: 'Continue',
      archive: 'Archive',
      status: 'Status',
      openPanel: 'Open the OpenSpec panel',
      phaseDraft: 'Draft',
      phaseProposed: 'Review',
      phaseApply: 'Applying',
      phaseReady: 'Ready',
      files: 'Artifacts',
      close: 'Close',
      fillComposer: 'Fill composer',
      insertFailed: 'Composer not found.',
      commandFailed: 'Command failed',
      commandSent: 'Sent',
      quickMissing: 'Not initialized',
      quickNoChange: 'No change in motion',
      switchChange: 'Switch change',
      taskProgress: '{done}/{total}',
      enterHint: 'Enter to confirm · Esc to cancel',
      artifactDone: 'Done',
      artifactSkipped: 'Skipped',
      artifactReady: 'Ready',
      artifactBlocked: 'Blocked',
      artifactUnknown: 'Unknown',
      artifactsLabel: 'Artifacts',
      artifactProgress: 'Artifact progress',
      artifactStatus: 'Artifact status',
      artifactSource: 'artifact {id}',
      missingDeps: 'Missing dependencies: {deps}',
      skipSpecs: 'skip_specs',
      retireCaps: 'retire capabilities after archive',
      schemaLabel: 'Schema',
      schemaProject: 'Project',
      schemaBuiltin: 'Builtin',
      schemaUnknown: 'Unknown',
      configSection: 'Project config',
      configMissing: 'No openspec/config.yaml found; using the default schema: {schema}',
      effectiveSchema: 'Effective schema',
      contextLabel: 'Context',
      contextEmpty: 'No project context configured',
      contextShow: 'Show full context',
      contextHide: 'Collapse context',
      rulesLabel: 'Rules',
      rulesEmpty: 'No per-artifact rules configured',
      rulesCount: '{count} rules',
      operationsLabel: 'Operations',
      operationApply: 'apply guidance',
      operationArchive: 'archive guidance',
      schemasSection: 'Available schemas',
      schemaArtifacts: 'Artifacts: {items}',
      validationLabel: 'Validation',
      validationClean: 'No validation issues',
      validationSummary: '{errors} errors · {warnings} warnings',
      issuesList: 'Validation issues',
      showMoreItems: 'Show {count} more',
      moreItems: '{count} more',
      allItemsShown: 'All {count} shown',
      deltaSection: 'Delta operations',
      deltaAdded: '+{count} added',
      deltaModified: '{count} modified',
      deltaRemoved: '{count} removed',
      deltaRenamed: '{count} renamed',
      deltaEmpty: 'No delta files',
      deltaFiles: 'Delta files',
      nextSteps: 'Suggested next steps',
      noNextSteps: 'No extra suggestion',
      nextActionPropose: 'Propose',
      nextActionUpdate: 'Keep planning',
      nextActionResume: 'Resume planning',
      nextActionApply: 'Apply',
      nextActionArchive: 'Archive',
      metadataLabel: '.openspec.yaml',
      metaSchema: 'Schema',
      metaCreated: 'Created',
      metaGoal: 'Goal',
      metaSkip: 'skip_specs',
      metaRetire: 'retire capabilities',
      metaMissing: 'No .openspec.yaml (derived from project config)',
      metaNone: '—',
      capabilityTitle: 'Capability specs',
      capabilityPurpose: 'Purpose',
      scenarioCount: '{count} scenarios',
      specIssues: '{count} issues',
      archiveUnknownDate: 'Unknown date',
      archiveSectionTitle: 'Archived changes',
      archiveTasks: 'Tasks',
      archiveMetadata: 'Metadata',
      archiveArtifacts: 'Artifacts',
      archiveProbeNote: 'Archive details are probed by known artifact names; custom/glob artifacts are read from the repository.',
      archiveLoadFailed: 'Failed to read the archived change',
      archiveDetailLoading: 'Reading archived change…',
      quickNext: 'Next step',
      nativeSkills: 'Native skills',
      nativeSkillsTitle: 'Detected native OpenSpec skills: {names}',
      fallbackSkills: 'Builtin skills',
      fallbackSkillsTitle: 'No native skills detected; using the plugin file-semantics fallback.',
      nativeSkillsCount: '{count}',
      docTruncated: '{total}-line document — showing the first {shown} lines',
      docTruncatedSimple: 'Showing the first {shown} lines',
      docShowMore: 'Load {count} more lines',
      docReadMoreFailed: 'Failed to read more of the document',
      docAtLine: 'Located at line {line}',
      docFullscreen: 'Expand reader',
      docExitFullscreen: 'Exit expanded reader',
      validateAction: 'Validate',
      validating: 'Validating…',
      validateTitle: 'Validation result',
      validateDesc: 'Computed read-only by the Host native validator; nothing is written.',
      validateFailed: 'Validation failed',
      syncPreviewAction: 'Sync preview',
      syncPreviewTitle: 'Spec sync preview',
      syncPreviewDesc: 'Read-only preview; run /opsx-sync --yes for the deterministic write, or /opsx-sync to let the AI merge through the OPSX workflow.',
      syncPreviewFailed: 'Failed to build the sync preview',
      initCreated: 'Created: {items}',
      initAlready: 'Nothing to create.',
      blockedCount: '{count} blocked',
      changesBlockedHint: 'Some artifacts are blocked by missing dependencies.',
      workspaceWarnings: 'Workspace warnings',
      changeSchema: 'Schema {name}',
      noIssues: 'No validation issues',
      docsFromSchema: 'Listed from the effective schema generates paths',
      summaryPending: 'No proposal yet',
      summaryMore: 'View full text',
      summaryChangesTotal: '{count} items',
      summaryAllChanges: 'Show all {count}',
      overviewWhy: 'Why',
      overviewChanges: 'What changes',
      overviewImpact: 'Impact & status',
      overviewCapabilities: '{count} capabilities',
      docGroups: 'Documents',
      specChangesGroup: 'Spec changes',
      metadataGroup: 'Metadata',
      docGroupCount: '{count} files',
      docGroupFiles: '{count} files',
      artifactProposal: 'Proposal',
      artifactDesign: 'Design',
      artifactTasks: 'Tasks',
      plannerComplete: 'Planning complete',
      planning: 'Planning',
      loadingArchive: 'Reading archive…',
      customArtifactsNote: 'Custom/glob artifacts are expanded from generates; nothing listed here is silently dropped.',
      pickerSearch: 'Filter changes in motion…',
      pickerEmpty: 'No change in motion — start one with /opsx-propose.',
      pickerNoResults: 'No matching change',
      pickerLoadFailed: 'Failed to read the change state',
      pickerPlanning: 'Planning',
      pickerApply: 'Ready to apply',
      pickerComplete: 'Complete',
      pickerTasks: 'Tasks {done}/{total}',
      pickerErrors: '{count} ERROR',
      pickerWarnings: '{count} WARNING',
      changeSummary: 'Change summary',
      changeSummaryEmpty: 'No summary yet (proposal.md has no Why / What Changes).',
      changeHighlights: 'What changes',
      highlightMore: '{count} more',
      pendingAcceptance: 'Waiting for acceptance',
      pendingManual: 'Manual acceptance',
      pendingAutomatic: 'Other pending',
      pendingBreakdown: 'Manual {manual} · Other {automatic}',
      pendingEmpty: 'No tasks waiting for acceptance.',
      pendingOpenTask: 'Open tasks.md',
      pendingLimited: 'Some changes have more tasks than the 200-row payload cap; open their tasks.md for the rest.',
      statusPlanning: 'Planning',
      statusImplementing: 'Applying',
      statusReady: 'Ready to apply',
      statusComplete: 'Complete',
      statusRunning: 'Running',
      statusWaiting: 'Waiting',
      statusArchived: 'Archived',
      statusDesc: 'Computed directly by the Host native engine without spending model tokens.',
      statusRunHint: 'The bound session is running; wait for it to finish before starting another planning/applying action.',
      statusWaitHint: 'The bound session is waiting for your confirmation (permission or question). Answer it first.',
      boundSession: 'Bound session',
      openSession: 'Open session',
      boundSessionMissing: 'The bound session no longer exists; the next action will create one.',
      sessionShort: 'Session {id}',
      exploreDialogTitle: 'Explore',
      exploreDialogDesc: 'Think before changing anything. Explore is read-only and starts in the session immediately — no second Enter.',
      exploreTopicLabel: 'What to explore (optional)',
      exploreTopicPlaceholder: 'For example: how should live status polling work?',
      exploreStart: 'Start exploring',
      proposeDialogTitle: 'New proposal',
      proposeDialogDesc: 'Describe what this change should do. After submitting, the AI summarizes it, chooses the change name, then creates the change and planning artifacts; Start proposal sends it immediately.',
      proposeDescriptionLabel: 'Description',
      proposeDescriptionPlaceholder: 'For example: show live change status in the OpenSpec panel and block duplicate actions while a change is running.',
      proposeAutoNameHint: 'The AI derives the change name from your description; it appears in the panel once created. To choose a name yourself, run /opsx-propose <name> <description>.',
      proposeStart: 'Start proposal',
      proposeRequired: 'Describe the change first.',
      dialogCancel: 'Cancel',
      commandSentTo: 'Sent to session',
      commandSending: 'Sending…',
      commandSendFailed: 'Send failed',
      commandDrafted: 'Command filled into the composer — press Enter to send',
      manualTask: 'Manual check',
      manualTaskHint: 'This task needs manual acceptance; tick it here once verified.',
      taskToggleFailed: 'Failed to update the task',
      taskToggling: 'Updating…',
      orchestration: 'Multi-role tasks',
      orchestrationHint: 'One session per task/role; roles read dependency artifacts and handoffs, never each other’s chats.',
      orchestrationEmpty: 'No multi-role tasks yet.',
      orchestrationEmptyHint: 'Create a program, split the goal into tasks, and assign models to product / design / dev / test.',
      orchestrationNew: 'New multi-role task',
      orchestrationCreateTitle: 'New multi-role task',
      orchestrationCreateDesc: 'Enter only the goal and four role models; AI splits the tasks, generates the title and change names, then creates native changes.',
      orchestrationGoalPlaceholder: 'e.g. Add a skill system to the game with fireball, heal and ice shield, integrated with the existing combat loop.',
      orchestrationAutoPlanHint: 'Submitting opens a planning session. AI writes only the task-split file; the Host validates it before creating changes. It does not write product code.',
      orchestrationGenerate: 'Generate tasks',
      orchestrationGenerating: 'AI is splitting tasks…',
      orchestrationPlanningWait: 'The planning turn was sent. AI writes the split to .plans; the Host validates it before creating changes.',
      orchestrationGenerated: 'Tasks generated; the product role is ready.',
      orchestrationPlanTimeout: 'AI did not produce a task split within 5 minutes. Check the planning session or retry.',
      orchestrationPlanFailed: 'Task splitting failed',
      orchestrationTitle: 'Title',
      orchestrationId: 'Program id (ASCII)',
      orchestrationGoal: 'Goal',
      orchestrationTasks: 'Tasks',
      orchestrationTasksHint: 'One per line: change | title | description | deps',
      orchestrationRoles: 'Role models',
      orchestrationModelHint: 'Empty follows the session default; format provider/model',
      orchestrationAutoOn: 'Auto running',
      orchestrationAutoOff: 'Auto advance',
      orchestrationAutoPause: 'Pause auto',
      orchestrationAutoHint: 'The PM starts ready roles through the gates; final acceptance stays with you.',
      orchestrationPm: 'PM review',
      orchestrationPmRunning: 'PM reviewing…',
      orchestrationPmSent: 'PM review sent.',
      orchestrationPmStatus: 'PM status',
      orchestrationPmNone: 'The PM has not written a status report yet.',
      orchestrationModels: 'Models',
      orchestrationSave: 'Save',
      orchestrationSaved: 'Role models saved',
      orchestrationCreate: 'Create',
      orchestrationCreating: 'Creating…',
      orchestrationRequired: 'Enter a goal first.',
      orchestrationTask: 'Task',
      orchestrationDeps: 'Deps',
      orchestrationStart: 'Start',
      orchestrationContinue: 'Continue',
      orchestrationRunning: 'Running',
      orchestrationWaiting: 'Waiting',
      orchestrationDone: 'Done',
      orchestrationReady: 'Ready',
      orchestrationAccept: 'Accept',
      orchestrationAccepted: 'Accepted',
      orchestrationWaitingTest: 'Waiting for test',
      orchestrationProgress: '{done}/{total} tasks',
      orchestrationModel: 'Model {model}',
      orchestrationNoModel: 'Session default',
      orchestrationStartFailed: 'Failed to start the role',
      orchestrationAcceptFailed: 'Failed to accept',
      notifyDoneTitle: 'OpenSpec · {change} finished',
      notifyDoneBody: 'The AI session finished and every task is complete — ready for acceptance or archive.',
      notifyTurnTitle: 'OpenSpec · {change} turn finished',
      notifyTurnBody: 'The AI finished its turn; continue with the next step.',
      notifyPendingTitle: 'OpenSpec · {change} needs confirmation',
      notifyPendingBody: 'The session is waiting for a permission decision or an answer. Open it to continue.',
      notifyPendingGeneric: 'An OpenSpec session is waiting for your confirmation.',
      notifyRolePendingTitle: 'OpenSpec · {task} / {role} needs confirmation',
      notifyRoleTurnTitle: 'OpenSpec · {task} / {role} turn finished',
      notifyHint: 'Click to open the session',
      notificationsBlocked: 'System notifications are not permitted; showing an in-panel notice instead.',
      autoProposeTimeoutTitle: 'OpenSpec · auto-naming did not finish',
      autoProposeTimeoutBody: 'The AI did not create a new change directory within 10 minutes. Check the session or run /opsx-propose <name> manually.',
      // Human reports: the two entries, the report dialog and the sandboxed preview.
      reportEntry: 'Report',
      reportPeriodEntry: 'Period report',
      reportDialogTitle: 'Generate a human report',
      reportDialogDesc: 'The report anchors this work on the mainline before the details; submitting only fills the composer — nothing is sent automatically.',
      reportScopeChange: 'Single change',
      reportScopeRange: 'Date range',
      reportRangeFrom: 'From',
      reportRangeTo: 'To',
      reportRangeHint: 'Counted by archive date, both bounds inclusive.',
      reportIncludedCount: '{count} archived changes in range',
      reportIncludedList: 'Included changes',
      reportChangeLabel: 'Change',
      reportDateLabel: 'Archived',
      reportOutputPath: 'Output path',
      reportRootLabel: 'Report root',
      reportRootHint: 'Workspace-relative directory, default 人类文档; absolute paths must stay inside the workspace.',
      reportRootPlaceholder: '人类文档',
      reportArchiveMode: 'Write into the archive folder (report.html)',
      reportStatusLabel: 'Report status',
      reportStatusMissing: 'Not generated',
      reportStatusGenerated: 'Generated',
      reportGeneratedAt: 'Generated {time}',
      reportStatusLoading: 'Checking…',
      reportStatusFailed: 'Status check failed',
      reportGenerate: 'Fill report prompt',
      reportRegenerate: 'Regenerate',
      reportPreview: 'Preview',
      reportCopyPath: 'Copy path',
      reportPromptFilled: 'Prompt filled into the composer — press Enter to send',
      reportPathCopied: 'Report path copied',
      reportCopyFailed: 'Copy failed — copy the path manually',
      reportPreviewTitle: 'Report preview',
      reportPreviewNote: 'Preview renders in a script-disabled sandbox; if it looks wrong, copy the path and open the file in a browser.',
      reportPreviewTruncated: 'The report is large — previewing the first {shown} lines.',
      reportPreviewUnavailable: 'Preview unavailable',
      reportWarningAbsolute: 'The report root must be inside the workspace; absolute paths outside it are rejected',
      reportWarningRangeOrder: 'The start date is after the end date',
      reportWarningRangeMissing: 'Pick both a start and an end date',
      reportWarningRangeEmpty: 'No archived change in this range',
      reportComposeMissing: 'Could not reach a target composer; the report prompt was not filled',
    },
  }

  /** Plugin-scoped styles; only --dsw-* theme tokens (plus host radii/elevation). */
  const CSS = `
.dshspec-root{height:100%;min-height:0;overflow-y:auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
.dshspec-page{max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 56px;display:flex;flex-direction:column;gap:20px}
.dshspec-pageHead{display:flex;align-items:flex-start;gap:16px}
.dshspec-pageHeadText{min-width:0;flex:1}
.dshspec-title{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:0}
.dshspec-sub{margin-top:2px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshspec-pageActions{display:flex;align-items:center;gap:8px;flex:none}
.dshspec-space{flex:1}

/* Workspace switcher --------------------------------------------------- */
.dshspec-wsbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshspec-wsbarLabel{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-wstabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshspec-wstab{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;min-width:0;max-width:280px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.dshspec-wstab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-wstab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-wstab[data-active='true']{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.dshspec-wstab .dshspec-icon{color:var(--dsw-alias-label-tertiary)}
.dshspec-wstabName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshspec-wstabCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* Detail toolbar ------------------------------------------------------- */
.dshspec-detail{display:flex;flex-direction:column;gap:16px}
.dshspec-detailBar{display:flex;align-items:center;gap:10px;min-width:0}
.dshspec-detailBarIcon{color:var(--dsw-alias-label-tertiary)}
.dshspec-detailBarPath{flex:1;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-detailActions{flex:none;display:flex;align-items:center;gap:8px}

/* Spec overview -------------------------------------------------------- */
.dshspec-summary{display:flex;align-items:center;gap:clamp(16px,2.2vw,26px);flex-wrap:wrap;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:14px 18px}
.dshspec-meters{display:flex;align-items:flex-start;gap:20px;flex:none}
.dshspec-ringMeter{display:flex;flex-direction:column;align-items:center;gap:7px;min-width:64px}
.dshspec-ringWrap{position:relative;width:64px;height:64px;flex:none}
.dshspec-ringWrap svg{display:block}
.dshspec-ringEmpty .dshspec-ringValue{color:var(--dsw-alias-label-tertiary)}
.dshspec-ringText{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.dshspec-ringValue{font-size:17px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums}
.dshspec-ringCaption{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-align:center}
.dshspec-summaryPhase{flex:1 1 220px;min-width:190px;display:flex;flex-direction:column;gap:8px}
.dshspec-phaseHead{display:flex;align-items:center;gap:8px;min-height:18px;min-width:0}
.dshspec-phaseHeadMeta{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0}
.dshspec-summaryLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshspec-phaseBar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-phaseSeg{height:100%;min-width:3px;transition:flex-grow .24s ease}
.dshspec-phaseLegend{display:flex;flex-wrap:wrap;gap:6px 16px}
.dshspec-legendItem{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshspec-legendItem b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshspec-summaryStats{display:flex;align-items:flex-start;gap:clamp(14px,2vw,22px);flex:none;margin-left:auto}
.dshspec-stat{display:flex;flex-direction:column;gap:2px;min-width:48px}
.dshspec-statValue{font-size:18px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dshspec-statLabel{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}

/* Sections ------------------------------------------------------------- */
.dshspec-section{display:flex;flex-direction:column;gap:8px}
.dshspec-sectionHead{display:flex;align-items:center;gap:8px;min-height:28px}
.dshspec-sectionTitle{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-sectionCount{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}
.dshspec-sectionActions{margin-left:auto;display:flex;align-items:center;gap:6px}
.dshspec-sectionToggle{display:inline-flex;align-items:center;gap:8px;padding:2px 4px 2px 0;margin:0;border:none;border-radius:8px;background:transparent;font:inherit;color:inherit;cursor:pointer}
.dshspec-sectionToggle:hover .dshspec-sectionTitle{color:var(--dsw-alias-label-primary)}
.dshspec-sectionToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-sectionBody{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.dshspec-sectionEmpty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:24px 16px;text-align:center}
.dshspec-sectionEmptyIcon{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-sectionEmptyTitle{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-sectionEmptyHint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);max-width:420px}
.dshspec-sectionEmpty .dshspec-btn{margin-top:4px}
.dshspec-note{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}

/* Rows / collapsible items -------------------------------------------- */
.dshspec-rowItem{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border:none;background:transparent;font:inherit;text-align:left;color:inherit;cursor:pointer;min-width:0;transition:background .12s ease}
.dshspec-rowItem+.dshspec-rowItem{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-rowItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-rowItem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-rowIcon{flex:none;width:30px;height:30px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.dshspec-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshspec-rowName{font-size:13.5px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-rowMeta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-rowEnd{flex:none;display:flex;align-items:center;gap:8px;color:var(--dshspec-label-tertiary,var(--dsw-alias-label-tertiary))}

.dshspec-item{display:flex;flex-direction:column;min-width:0}
.dshspec-item+.dshspec-item{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-itemHead{display:flex;align-items:center;gap:10px;padding:10px 14px;min-width:0;flex-wrap:wrap;cursor:pointer;user-select:none}
.dshspec-itemHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-itemChips{padding:0 14px 10px}
.dshspec-itemHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-itemHeadRow{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.dshspec-itemBody{display:flex;flex-direction:column;gap:12px;padding:12px 14px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dshspec-chevOpen{transform:rotate(90deg)}
.dshspec-changeName{font-size:13.5px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-changeButtons{flex:none;display:flex;align-items:center;gap:6px}
.dshspec-changeProgress{flex:0 1 150px;min-width:96px}
.dshspec-changeHint{padding:0 14px 8px 38px;min-width:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshspec-changeSummary{display:flex;flex-direction:column;gap:5px;min-width:0}
.dshspec-changeDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.dshspec-changeDescFull{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshspec-changeSummaryHead{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.dshspec-summaryLabel{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:5px;padding:0 5px}
.dshspec-highlights{display:flex;flex-wrap:wrap;gap:5px;min-width:0}
.dshspec-highlight{display:inline-flex;align-items:center;min-width:0;max-width:100%;height:20px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshspec-sessionChip{display:inline-flex;align-items:center;gap:5px;height:20px;max-width:160px;padding:0 7px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10.5px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshspec-sessionChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-statusBadge{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 8px;border-radius:999px;font-size:11px;line-height:1;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-statusBadge[data-status='running'],.dshspec-statusBadge[data-status='waiting']{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dshspec-statusBadge[data-status='complete']{color:var(--dsw-alias-state-success-primary)}
.dshspec-statusBadge[data-status='running'] .dshspec-icon{animation:dshspec-rotate .9s linear infinite}
.dshspec-btn[data-dshspec-run-status='running'] .dshspec-icon{animation:dshspec-rotate .9s linear infinite}
.dshspec-inlineSpinner{animation:dshspec-rotate .9s linear infinite}
.dshspec-dateChip{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:1px 6px;font-variant-numeric:tabular-nums}
.dshspec-decoIcon{opacity:.5}

/* Documents & tasks inside an expanded item --------------------------- */
.dshspec-subHead{display:flex;align-items:center;gap:8px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshspec-subHead b{font-weight:400;color:var(--dsw-alias-label-secondary)}
.dshspec-docGrid{display:flex;flex-wrap:wrap;gap:8px}
.dshspec-docBtn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.dshspec-docBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshspec-docBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-docBtn .dshspec-icon{color:var(--dsw-alias-label-tertiary)}
.dshspec-docKind{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshspec-taskBlock{display:flex;flex-direction:column;gap:6px}
.dshspec-taskList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.dshspec-task{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshspec-task .dshspec-icon{margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.dshspec-taskDone{color:var(--dsw-alias-label-tertiary)}
.dshspec-taskDone .dshspec-icon{color:var(--dsw-alias-state-success-primary)}
.dshspec-taskCheck{display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;margin:-2px 0 -2px -4px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshspec-taskCheck:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-taskCheck:disabled{opacity:.45;cursor:default}
.dshspec-taskCheck[data-done='true']{color:var(--dsw-alias-state-success-primary)}
.dshspec-taskText{min-width:0;flex:1;overflow-wrap:anywhere}
.dshspec-taskTags{display:inline-flex;align-items:center;gap:4px;flex:none;margin-left:4px}
.dshspec-manualTag{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));font-size:10px;line-height:1;white-space:nowrap}
/* Aggregate waiting-for-acceptance list */
.dshspec-pendingList{display:flex;flex-direction:column}
.dshspec-pendingGroup{display:flex;flex-direction:column}
.dshspec-pendingGroup+.dshspec-pendingGroup{border-top:1px solid var(--dsw-alias-border-l2)}
.dshspec-pendingGroupHead{display:flex;align-items:center;gap:8px;padding:8px 14px 5px;font-size:11.5px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dshspec-pendingRow{display:flex;align-items:flex-start;gap:8px;padding:6px 14px;font-size:12.5px;line-height:18px;min-width:0}
.dshspec-pendingRow+.dshspec-pendingRow{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-pendingRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-pendingRow .dshspec-taskCheck{margin-top:0}
.dshspec-pendingChange{flex:none;max-width:190px;height:20px;padding:0 7px;border:none;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dshspec-pendingChange:hover{color:var(--dsw-alias-label-primary)}
.dshspec-pendingText{flex:1;min-width:0;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;overflow-wrap:anywhere;cursor:pointer}
.dshspec-pendingText:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.dshspec-pendingRow .dshspec-manualTag{margin-left:auto;flex:none}
.dshspec-taskToggle{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;max-width:100%;padding:3px 8px 3px 5px;margin-left:-3px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;text-align:left;transition:background .12s ease,color .12s ease}
.dshspec-taskToggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-taskToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-taskToggle b{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-taskToggleMeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshspec-taskToggleHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);padding-left:8px;border-left:1px solid var(--dsw-alias-border-l2)}
.dshspec-taskMore{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;margin-top:2px;padding:3px 8px 3px 5px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:17px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshspec-taskMore:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-taskMore:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-inlineLoad{display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}

/* Progressive detail: compact summary + staged overview / document groups -- */
.dshspec-itemSummary{display:flex;align-items:baseline;gap:10px;padding:0 14px 10px;min-width:0;cursor:pointer;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshspec-itemSummary:hover{color:var(--dsw-alias-label-primary)}
.dshspec-itemSummary[data-source='none']{color:var(--dsw-alias-label-tertiary)}
.dshspec-itemSummaryText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-itemSummaryMore{flex:none;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshspec-overview{display:flex;flex-direction:column;gap:7px;min-width:0}
.dshspec-ovRow{display:flex;align-items:flex-start;gap:10px;min-width:0}
.dshspec-ovLabel{flex:none;width:60px;padding-top:1px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshspec-ovValue{flex:1;min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshspec-ovClamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshspec-ovList{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:2px}
.dshspec-ovActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshspec-ovActions .dshspec-taskMore{margin-top:0}
.dshspec-docGroups{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshspec-docGroup+.dshspec-docGroup{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-docGroupHead{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:none;background:transparent;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;min-width:0}
.dshspec-docGroupHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-docGroupHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-docGroupTitle{flex:none;font-size:12.5px;line-height:18px;font-weight:500;white-space:nowrap}
.dshspec-docGroupMeta{flex:1;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-docGroupEnd{margin-left:auto;flex:none;display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshspec-docGroupBody{display:flex;flex-direction:column;gap:2px;padding:2px 10px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-docRow{display:flex;align-items:center;gap:8px;width:100%;padding:6px;border:none;border-radius:8px;background:transparent;font:inherit;text-align:left;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0}
.dshspec-docRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-docRow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-docRowIcon{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshspec-docRowName{flex:none;max-width:52%;font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-docRowMeta{flex:1;min-width:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-docRowEnd{flex:none;margin-left:auto;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dshspec-issueBlock{display:flex;flex-direction:column;gap:6px}
@media (max-width:900px){.dshspec-ovLabel{width:52px}.dshspec-docRowName{max-width:44%}}

/* Badges, progress, chips (shared) ------------------------------------ */
.dshspec-badge{flex:none;display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 8px 0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap;font-weight:400}
.dshspec-badgeDot{width:5px;height:5px;border-radius:50%;flex:none}
.dshspec-progress{display:flex;align-items:center;gap:8px;flex:0 1 170px;min-width:110px;max-width:220px}
.dshspec-progressTrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dshspec-progressFill{height:100%;border-radius:2px;transition:width .24s ease}
.dshspec-progressCount{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-fileChip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap}

/* Buttons -------------------------------------------------------------- */
.dshspec-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;border:none;font:inherit;cursor:pointer;white-space:nowrap;border-radius:12px;transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease;-webkit-app-region:no-drag}
.dshspec-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-btn:disabled{opacity:.4;cursor:default}
.dshspec-btn-md{height:32px;padding:0 13px;font-size:13px}
.dshspec-btn-sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:10px}
.dshspec-btn-lg{height:36px;padding:0 16px;font-size:13.5px;border-radius:12px}
.dshspec-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshspec-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshspec-btn-outline{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dshspec-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshspec-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary)}
.dshspec-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-iconBtn{display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;cursor:pointer;transition:background .12s ease,color .12s ease;-webkit-app-region:no-drag}
.dshspec-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-icon{display:block;flex:none}

/* Composer dock -------------------------------------------------------- */
.dshspec-dock{position:relative;display:flex;align-items:center;gap:10px;flex-wrap:nowrap;max-width:100%;padding:2px 2px 6px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
/* Hero (pre-conversation) variant: the bar sits at the right end of the
   workspace chip row, so it renders as a plain inline cluster — no container
   chrome, tighter type, and a bounded change name. */
.dshspec-dock[data-dshspec-variant=hero]{width:fit-content;max-width:100%;gap:6px;padding:0;font-size:12px}
.dshspec-dock[data-dshspec-variant=hero] .dshspec-dockStatus{gap:6px}
.dshspec-dock[data-dshspec-variant=hero] .dshspec-dockActions{margin-left:0;gap:4px}
.dshspec-dock[data-dshspec-variant=hero] .dshspec-seg{padding:0;background:transparent}
.dshspec-dock[data-dshspec-variant=hero] .dshspec-dockName{max-width:140px}
/* The hero seat lives at the top-right of the window: open the change switcher
   downward and align it to the right so it never leaves the viewport. */
.dshspec-dock[data-dshspec-variant=hero] .dshspec-dockMenu{top:calc(100% + 8px);bottom:auto;right:0;left:auto}
.dshspec-dockStatus{display:flex;align-items:center;gap:7px;min-width:0;flex:1 1 auto;flex-wrap:nowrap}
.dshspec-dockTargetWrap{position:relative;display:flex;align-items:center;min-width:0}
.dshspec-dockTarget{display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;padding:2px 6px 2px 3px;margin-left:-3px;border:none;border-radius:8px;background:transparent;font:inherit;color:inherit;cursor:pointer;text-align:left}
.dshspec-dockTarget:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-dockTarget:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshspec-dockCaret{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshspec-dockMenu{position:absolute;left:0;bottom:calc(100% + 8px);z-index:80;min-width:300px;max-width:min(380px,calc(100vw - 48px));max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:1px;padding:4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-elevation-prominent);animation:dshspec-fade .12s ease-out}
.dshspec-dockMenuHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshspec-dockMenuItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:none;border-radius:8px;background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dshspec-dockMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-dockMenuItem[data-active='true']{background:var(--dsw-alias-interactive-bg-hover-accent)}
.dshspec-dockMenuItem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-dockMenuName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshspec-dockMenuCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-dockName{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);max-width:240px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-dockActions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
/* Narrow windows: the dock shares its row with the shell's context meter, so it
   must stay on ONE line — drop secondary controls first, then truncate the
   change name. (Wrapping used to put the status on its own line and push the
   actions far right.) */
@media (max-width:1440px){.dshspec-dock .dshspec-dockName{max-width:200px}}
@media (max-width:1300px){.dshspec-dockSkills{display:none}}
@media (max-width:1200px){.dshspec-dock .dshspec-dockStatus .dshspec-badge{display:none}}
@media (max-width:1100px){.dshspec-dockStatusBtn{display:none}}
@media (max-width:1000px){.dshspec-dockGhost{display:none}}
@media (max-width:900px){.dshspec-dock .dshspec-dockName{max-width:110px}}
.dshspec-seg{display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-seg .dshspec-btn-sm{height:24px;padding:0 8px;font-size:12px;border-radius:8px}
.dshspec-seg .dshspec-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}
.dshspec-seg .dshspec-btn-primary{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-button-ghost-active-border)}
.dshspec-seg .dshspec-btn-primary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent)}
.dshspec-dot{width:7px;height:7px;border-radius:50%;flex:none}

/* Modal ---------------------------------------------------------------- */
.dshspec-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.24);animation:dshspec-fade .12s ease-out}
.dshspec-modal{width:100%;max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-panel,28px);box-shadow:var(--dsw-elevation-prominent);padding:22px 24px 20px;display:flex;flex-direction:column;gap:16px;animation:dshspec-pop .14s cubic-bezier(.2,.8,.2,1)}
.dshspec-modal:focus,.dshspec-modal:focus-visible{outline:none}
.dshspec-modalHead{display:flex;align-items:flex-start;gap:12px}
.dshspec-modalHeadText{flex:1;min-width:0}
.dshspec-modalHeadActions{flex:none;display:flex;align-items:center;gap:8px}
.dshspec-modalTitle{margin:0;font-size:16px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshspec-modalDesc{margin:6px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-modalBody{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshspec-modalFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshspec-field{display:flex;flex-direction:column;gap:6px}
.dshspec-fieldLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshspec-input{height:40px;width:100%;box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;padding:0 13px;transition:border-color .12s ease,box-shadow .12s ease}
.dshspec-input::placeholder{color:var(--dsw-alias-label-caption)}
.dshspec-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dshspec-textarea{width:100%;min-height:96px;box-sizing:border-box;resize:vertical;border-radius:12px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;line-height:1.6;padding:10px 12px;transition:border-color .12s ease,box-shadow .12s ease}
.dshspec-textarea::placeholder{color:var(--dsw-alias-label-caption)}
.dshspec-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dshspec-nameRow{display:flex;align-items:center;gap:8px;min-width:0}
.dshspec-nameRow .dshspec-input{flex:1;min-width:0;font-size:13px;height:36px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dshspec-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dshspec-errorText{font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary)}

/* Human reports: scope tabs, range inputs, status and sandboxed preview --- */
.dshspec-scopeTabs{display:flex;align-items:center;gap:3px;align-self:flex-start;padding:3px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-scopeTab{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 13px;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshspec-scopeTab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshspec-scopeTab:disabled{opacity:.4;cursor:default}
.dshspec-scopeTab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshspec-scopeTab[data-active='true']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.dshspec-rangeGrid{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;min-width:0}
.dshspec-rangeGrid .dshspec-field{flex:1 1 150px;min-width:130px}
.dshspec-rangeGrid .dshspec-input{font-variant-numeric:tabular-nums}
.dshspec-reportStatus{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshspec-reportStatus b{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-reportStatusMeta{min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.dshspec-reportStatusActions{margin-left:auto;display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap}
.dshspec-reportList{display:flex;flex-direction:column;gap:1px;max-height:180px;overflow:auto;padding:5px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px}
.dshspec-reportListItem{display:flex;align-items:baseline;gap:10px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshspec-reportListItemName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px}
.dshspec-reportListItemDate{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-outputPath{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-toggleRow{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;min-width:0}
.dshspec-toggleRow input{flex:none;margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary)}
.dshspec-reportFrame{display:block;width:100%;height:min(70vh,640px);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:#fff}

/* Document viewer ------------------------------------------------------ */
.dshspec-docViewport{max-height:min(78vh,1040px);overflow:auto;padding:2px 2px 8px;border-top:.5px solid var(--dsw-alias-border-l1);margin-top:2px}
.dshspec-docViewport .dshspec-markdown{max-width:1040px;margin:0 auto}
.dshspec-docPath{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-markdown{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshspec-markdown>*:first-child{margin-top:0}
.dshspec-markdown>*:last-child{margin-bottom:0}
.dshspec-mdH{margin:18px 0 8px;font-weight:600;line-height:1.4}
.dshspec-mdH1{font-size:20px}
.dshspec-mdH2{font-size:17px}
.dshspec-mdH3{font-size:15px}
.dshspec-mdH4{font-size:14px}
.dshspec-mdP{margin:0 0 10px}
.dshspec-mdList{margin:0 0 10px;padding-left:20px}
.dshspec-mdLi{margin:2px 0}
.dshspec-mdCheck{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:10px;line-height:1;vertical-align:-2px;color:transparent}
.dshspec-mdCheckOn{background:var(--dsw-alias-state-success-secondary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dshspec-mdPre{background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-interactive-bg-hover));border-radius:10px;padding:10px 12px;margin:0 0 12px;overflow:auto;font-size:12.5px;line-height:1.6;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dshspec-mdCode{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-interactive-bg-hover));border-radius:4px;padding:1px 5px}
.dshspec-mdQuote{margin:0 0 12px;padding:4px 0 4px 12px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dshspec-mdHr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:16px 0}
.dshspec-markdown a{color:var(--dsw-alias-link);text-decoration:none}
.dshspec-markdown a:hover{text-decoration:underline}

/* State panels --------------------------------------------------------- */
.dshspec-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:18px 20px 16px;display:flex;flex-direction:column;gap:14px}
.dshspec-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:30px 16px 26px}
.dshspec-emptyIcon{flex:none;width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-emptyTitle{font-size:14px;line-height:20px;font-weight:500}
.dshspec-emptyDesc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:440px}
.dshspec-empty .dshspec-btn{margin-top:6px}
.dshspec-missing{display:flex;align-items:flex-start;gap:14px;padding:6px 0 4px}
.dshspec-missingText{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshspec-missingTitle{font-size:14px;line-height:20px;font-weight:500}
.dshspec-missingDesc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:620px}
.dshspec-missing .dshspec-btn{align-self:flex-start;margin-top:8px}
.dshspec-nosession{display:flex;align-items:flex-start;gap:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
.dshspec-orchProgram{display:flex;flex-direction:column;gap:12px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.dshspec-orchHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.dshspec-orchTitle{font-size:14px;line-height:20px;font-weight:600;min-width:0}
.dshspec-orchGoal{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshspec-orchMeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dshspec-orchPill{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dshspec-orchPm{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dshspec-orchPm summary{cursor:pointer;color:var(--dsw-alias-label-tertiary)}
.dshspec-orchPmText{white-space:pre-wrap;font:inherit;margin:5px 0 0;max-height:160px;overflow:auto;color:var(--dsw-alias-label-secondary)}
.dshspec-orchTableWrap{overflow-x:auto;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:10px}
.dshspec-orchTable{width:100%;min-width:640px;border-collapse:collapse;font-size:12px}
.dshspec-orchTable th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:5px 8px;white-space:nowrap}
.dshspec-orchTable td{padding:8px;border-top:.5px solid var(--dsw-alias-border-l1);vertical-align:top}
.dshspec-orchTaskName{font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dshspec-orchChange{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.dshspec-orchDeps{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:3px;white-space:nowrap}
.dshspec-orchRole{display:flex;flex-direction:column;gap:4px;align-items:flex-start;min-width:76px}
.dshspec-orchState{font-size:10.5px;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;gap:3px}
.dshspec-orchState[data-tone='done']{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.dshspec-orchState[data-tone='ready']{color:var(--dsw-alias-state-business-primary)}
.dshspec-orchState[data-tone='running']{color:var(--dsw-alias-state-warn-primary)}
.dshspec-orchRoleBtn{height:26px;padding:0 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.dshspec-orchRoleBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-orchRoleBtn:disabled{opacity:.5;cursor:not-allowed}
.dshspec-orchUser{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.dshspec-orchFormRole{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;align-items:center}
.dshspec-orchFormRoleLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshspec-orchFormRole .dshspec-input{height:32px;font-size:12px}
.dshspec-select{appearance:auto;cursor:pointer;padding-right:8px}

.dshspec-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:12px;font-size:12.5px;line-height:18px}
.dshspec-bannerInfo{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-bannerWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.dshspec-bannerError{background:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.dshspec-bannerText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-bannerTextWrap{min-width:0;overflow-wrap:anywhere}

.dshspec-foot{display:flex;align-items:center;gap:7px;padding-top:2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-loading{display:flex;flex-direction:column;gap:9px;padding:4px 0 6px}
.dshspec-skelLine{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);animation:dshspec-pulse 1.4s ease-in-out infinite}
.dshspec-spin{animation:dshspec-rotate .8s linear infinite}
.dshspec-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:1001;display:flex;align-items:center;gap:8px;max-width:min(520px,calc(100vw - 48px));padding:9px 14px;border-radius:12px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:12.5px;line-height:18px;box-shadow:var(--dsw-elevation-prominent);animation:dshspec-fade .12s ease-out}

/* Native model: artifact chips, metadata, issues, lists ----------------- */
.dshspec-chipRow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.dshspec-artChip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px 0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.dshspec-artChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-artChip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-artChip[data-status='ready']{border-color:var(--dsw-alias-state-business-primary)}
.dshspec-artChip[data-status='blocked']{border-color:var(--dsw-alias-state-warn-primary)}
.dshspec-artChip[data-status='done']{border-color:var(--dsw-alias-state-success-secondary)}
.dshspec-artChipDot{width:6px;height:6px;border-radius:50%;flex:none}
.dshspec-artChipState{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.dshspec-artChip[data-status='ready'] .dshspec-artChipState,.dshspec-artChip[data-status='blocked'] .dshspec-artChipState{color:var(--dsw-alias-label-secondary)}
.dshspec-depsRow{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.dshspec-depsRow b{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-kv{display:flex;align-items:baseline;gap:10px;min-width:0;font-size:12.5px;line-height:18px}
.dshspec-kvLabel{flex:none;min-width:72px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dshspec-kvValue{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshspec-kvValue code,.dshspec-mono{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px}
.dshspec-pre{margin:0;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.dshspec-prePlain{max-height:none;overflow:visible}
.dshspec-issueList{display:flex;flex-direction:column;gap:5px}
.dshspec-issue{display:flex;align-items:flex-start;gap:8px;padding:6px 9px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshspec-issueLevel{flex:none;font-size:10px;line-height:15px;font-weight:600;letter-spacing:.02em;padding:0 5px;border-radius:5px;color:var(--dsw-alias-label-primary)}
.dshspec-issuePath{flex:none;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-issueMsg{min-width:0;overflow-wrap:anywhere}
.dshspec-issue[data-tone='error'] .dshspec-issueLevel{background:var(--dsw-alias-state-error-secondary,var(--dsw-alias-state-error-primary));color:var(--dsw-alias-label-primary-foreground)}
.dshspec-issue[data-tone='warn'] .dshspec-issueLevel{background:var(--dsw-alias-state-warn-secondary,var(--dsw-alias-state-warn-primary));color:var(--dsw-alias-label-primary-foreground)}
.dshspec-issue[data-tone='info'] .dshspec-issueLevel{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dshspec-contextBox{max-height:180px;overflow:auto;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);padding:9px 11px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dshspec-nested{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px 14px;border:none;background:transparent;font:inherit;text-align:left;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .12s ease}
.dshspec-nested:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-nested:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-nested+.dshspec-nested{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-nestedGroup{display:flex;align-items:center;gap:8px;padding:8px 14px 5px;font-size:11.5px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary);min-width:0}
.dshspec-nestedGroup+ .dshspec-nested{border-top:none}
.dshspec-nestedName{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-nestedMeta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-nestedEnd{flex:none;display:flex;align-items:center;gap:6px;margin-left:auto}
.dshspec-treeText{min-width:0;display:flex;flex-direction:column;gap:1px}
.dshspec-pageFoot{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-skillChips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dshspec-inlineTag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1;white-space:nowrap}
.dshspec-summaryLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshspec-strongMeta{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshspec-strongMeta b{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-codeBlock{max-height:min(54vh,520px);overflow:auto}
.dshspec-archGroup{display:flex;flex-direction:column}
.dshspec-archGroup+.dshspec-archGroup{border-top:1px solid var(--dsw-alias-border-l2)}
.dshspec-archHead{display:flex;align-items:center;gap:8px;padding:8px 14px 6px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

@keyframes dshspec-fade{from{opacity:0}to{opacity:1}}
@keyframes dshspec-pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
@keyframes dshspec-rotate{to{transform:rotate(360deg)}}
@keyframes dshspec-pulse{0%,100%{opacity:.65}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dshspec-overlay,.dshspec-modal,.dshspec-toast,.dshspec-spin,.dshspec-skelLine,.dshspec-chev,.dshspec-progressFill{animation:none;transition:none}}
`

  /** Inject the stylesheet once, tagged like shipped plugin CSS. */
  function injectStyle() {
    if (typeof document === 'undefined') return
    const tagId = 'dsh-spec/styles.css'
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-spec'
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /* ------------------------------------------------------------------ *
   * Icons — 16px outline set matching the host's 1.2px stroke icons.
   * ------------------------------------------------------------------ */

  const ICONS = {
    refresh: [
      ['path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.61-3.89' }],
      ['path', { d: 'M13.5 2.5V6H10' }],
    ],
    compass: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M10.6 5.4 9.1 9.1 5.4 10.6l1.5-3.7z' }],
    ],
    filePlus: [
      ['path', { d: 'M9 2H4.6A1.6 1.6 0 0 0 3 3.6v8.8A1.6 1.6 0 0 0 4.6 14h6.8a1.6 1.6 0 0 0 1.6-1.6V6z' }],
      ['path', { d: 'M9 2v4h4' }],
      ['path', { d: 'M8 8.4v3.2M6.4 10h3.2' }],
    ],
    play: [['path', { d: 'M5.6 3.5v9L12.4 8z' }]],
    archive: [
      ['rect', { x: 2, y: 2.5, width: 12, height: 3.2, rx: 1 }],
      ['path', { d: 'M3 5.7v7.1a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2V5.7' }],
      ['path', { d: 'M6.4 8.6h3.2' }],
    ],
    activity: [['path', { d: 'M1.8 8h2.7l1.9-4.6 2.9 9.2L11.4 8h2.8' }]],
    layout: [
      ['rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2 }],
      ['path', { d: 'M6 2.8v10.4' }],
    ],
    close: [['path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }]],
    check: [['path', { d: 'M3.4 8.4l3.1 3.1 6.1-7' }]],
    alert: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 4.8v3.9' }],
      ['circle', { cx: 8, cy: 11.2, r: 0.75, fill: 'currentColor', stroke: 'none' }],
    ],
    info: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 7.2v4' }],
      ['circle', { cx: 8, cy: 4.9, r: 0.75, fill: 'currentColor', stroke: 'none' }],
    ],
    folder: [
      ['path', { d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 2h4.8A1.6 1.6 0 0 1 14 6.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4z' }],
    ],
    folderPlus: [
      ['path', { d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 2h4.8A1.6 1.6 0 0 1 14 6.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4z' }],
      ['path', { d: 'M8 7.2v4.2M5.9 9.3h4.2' }],
    ],
    chevronRight: [['path', { d: 'M6.2 4l4 4-4 4' }]],
    chevronDown: [['path', { d: 'M4 6.2l4 4 4-4' }]],
    sparkle: [
      ['path', { d: 'M7.2 2.4l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1z' }],
      ['path', { d: 'M12.2 9.4l.55 1.55 1.55.55-1.55.55-.55 1.55-.55-1.55-1.55-.55 1.55-.55z', opacity: 0.7 }],
    ],
    send: [
      ['path', { d: 'M8 13V3.2' }],
      ['path', { d: 'M4 7.1 8 3.1l4 4' }],
    ],
    file: [
      ['path', { d: 'M9 2H4.6A1.6 1.6 0 0 0 3 3.6v8.8A1.6 1.6 0 0 0 4.6 14h6.8a1.6 1.6 0 0 0 1.6-1.6V6z' }],
      ['path', { d: 'M9 2v4h4' }],
      ['path', { d: 'M5.4 8.4h5.2M5.4 10.8h3.6' }],
    ],
    layers: [
      ['path', { d: 'M8 2.2 13.4 5 8 7.8 2.6 5z' }],
      ['path', { d: 'M2.8 8 8 10.7 13.2 8' }],
      ['path', { d: 'M2.8 11 8 13.7 13.2 11' }],
    ],
    checkSquare: [
      ['rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2.4 }],
      ['path', { d: 'M5.4 8.2 7.3 10l3.6-4' }],
    ],
    square: [['rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2.4 }]],
    clock: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 4.9V8l2.1 1.3' }],
    ],
    message: [
      ['path', { d: 'M13.2 9.2a1.6 1.6 0 0 1-1.6 1.6H5.4L2.8 13.2V4a1.6 1.6 0 0 1 1.6-1.6h7.2A1.6 1.6 0 0 1 13.2 4z' }],
      ['path', { d: 'M5.2 6.2h5.6M5.2 8.6h3.6' }],
    ],
    users: [
      ['path', { d: 'M5.8 7.2a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2z' }],
      ['path', { d: 'M1.9 13.2c0-2.1 1.7-3.5 3.9-3.5s3.9 1.4 3.9 3.5' }],
      ['path', { d: 'M10.2 7.1a1.8 1.8 0 1 0 0-3.6' }],
      ['path', { d: 'M11.8 9.9c1.4.3 2.3 1.4 2.3 3.1' }],
    ],
    arrowUpRight: [
      ['path', { d: 'M4.4 11.6 11.6 4.4' }],
      ['path', { d: 'M5.6 4.4h6v6' }],
    ],
  }

  function Icon({ name, size = 16, className }) {
    const parts = ICONS[name] ?? ICONS.info
    return h(
      'svg',
      {
        className: 'dshspec-icon' + (className === undefined ? '' : ' ' + className),
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      parts.map(([tag, props], index) => h(tag, { key: index, ...props })),
    )
  }

  /* ------------------------------------------------------------------ *
   * Small presentational primitives (host-matched).
   * ------------------------------------------------------------------ */

  function Button({ variant = 'outline', size = 'md', icon, className, children, ...rest }) {
    const classes = ['dshspec-btn', `dshspec-btn-${variant}`, `dshspec-btn-${size}`]
    if (className !== undefined) classes.push(className)
    return h(
      'button',
      { type: 'button', className: classes.join(' '), ...rest },
      icon === undefined ? null : h(Icon, { name: icon, size: size === 'sm' ? 14 : 16 }),
      children === undefined || children === null || children === false ? null : h('span', null, children),
    )
  }

  function IconButton({ icon, label, size = 28, className, ...rest }) {
    const classes = ['dshspec-iconBtn']
    if (className !== undefined) classes.push(className)
    return h(
      'button',
      {
        type: 'button',
        className: classes.join(' '),
        title: label,
        'aria-label': label,
        style: { width: size, height: size },
        ...rest,
      },
      h(Icon, { name: icon, size: size >= 28 ? 16 : 14 }),
    )
  }

  function Progress({ done, total, color, compact }) {
    if (!(total > 0)) return null
    return h(
      'div',
      {
        className: 'dshspec-progress' + (compact === true ? ' dshspec-progressCompact' : ''),
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': total,
        'aria-valuenow': done,
      },
      h(
        'div',
        { className: 'dshspec-progressTrack' },
        h('div', {
          className: 'dshspec-progressFill',
          style: { width: `${Math.round((done / total) * 100)}%`, background: color },
        }),
      ),
      h('span', { className: 'dshspec-progressCount' }, `${done}/${total}`),
    )
  }

  /** Inline banner: info / warn / error with an icon. */
  function Banner({ tone = 'info', icon, children, wrap }) {
    const toneClass = tone === 'error' ? 'Error' : tone === 'warn' ? 'Warn' : 'Info'
    return h(
      'div',
      { className: `dshspec-banner dshspec-banner${toneClass}`, role: tone === 'error' ? 'alert' : 'status' },
      h(Icon, { name: icon ?? (tone === 'error' ? 'alert' : tone === 'warn' ? 'alert' : 'info'), size: 14 }),
      h('span', { className: wrap === true ? 'dshspec-bannerTextWrap' : 'dshspec-bannerText' }, children),
    )
  }

  /* ------------------------------------------------------------------ *
   * Modal — mirrors the host dialog: fixed mask, 28px panel radius, close
   * button, Esc / backdrop close, autofocus and focus restore.
   * ------------------------------------------------------------------ */

  function Modal({ t, title, description, children, footer, onClose, width = 512, focusCard, headActions }) {
    const cardRef = useRef(null)
    const restoreRef = useRef(null)
    const closeRef = useRef(onClose)
    closeRef.current = onClose

    useEffect(() => {
      restoreRef.current = typeof document === 'undefined' ? null : document.activeElement
      const card = cardRef.current
      const target =
        focusCard === true ? card : card?.querySelector('[data-autofocus]') ?? card?.querySelector('input, textarea, button')
      if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
      }
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('keydown', onKey, true)
        const restore = restoreRef.current
        if (restore !== null && restore !== undefined && typeof restore.focus === 'function') {
          try {
            restore.focus()
          } catch {
            /* the trigger may be gone after a dispatch */
          }
        }
      }
    }, [])

    return h(
      'div',
      {
        className: 'dshspec-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) closeRef.current()
        },
      },
      h(
        'div',
        {
          ref: cardRef,
          className: 'dshspec-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
          style: { maxWidth: width },
        },
        h(
          'div',
          { className: 'dshspec-modalHead' },
          h('div', { className: 'dshspec-modalHeadText' },
            h('h2', { className: 'dshspec-modalTitle' }, title),
            description === undefined ? null : h('p', { className: 'dshspec-modalDesc' }, description),
          ),
          headActions === undefined || headActions === null
            ? null
            : h('div', { className: 'dshspec-modalHeadActions' }, headActions),
          h(IconButton, { icon: 'close', label: t('close'), onClick: onClose }),
        ),
        h('div', { className: 'dshspec-modalBody' }, children),
        footer === undefined || footer === null ? null : h('div', { className: 'dshspec-modalFoot' }, footer),
      ),
    )
  }

  /* ------------------------------------------------------------------ *
   * Propose / explore dialogs.
   *
   * They replace the old "fill the composer and press Enter" flow: the propose
   * dialog collects the description and sends `/opsx-propose --auto …`; the AI
   * summarizes it, chooses the change name, scaffolds the native change and
   * writes the plan. The client never guesses the name locally.
   * ------------------------------------------------------------------ */

  /**
   * Build the two dialog submit handlers once: the panel and the quick bar
   * render the same propose/explore dialogs, and duplicating the closures let
   * one copy get lost in a merge while its JSX kept calling it (0.10.0 threw
   * `submitPropose is not defined` when「开始提案」was clicked from the quick bar).
   *
   * @param {object} deps - the seat's translator, command runner and dialog setters.
   * @returns {{submitPropose: Function, submitExplore: Function}} the submit handlers.
   */
  function createDialogSubmitters({ t, runNow, setDialogBusy, setDialogError, setDialog }) {
    /** Send an auto-named propose command; the description is flattened to one line. */
    const submitPropose = async ({ description }) => {
      setDialogBusy(true)
      setDialogError('')
      const line = `/opsx-propose --auto ${String(description).replace(/\s+/g, ' ').trim()}`.trim()
      const outcome = await runNow(line)
      setDialogBusy(false)
      if (outcome !== undefined && outcome !== null && outcome.ok === false) {
        setDialogError(outcome.text ?? t('commandSendFailed'))
        return
      }
      setDialog(null)
    }

    /** Send an explore command (topic optional) to a fresh/bound exploration session. */
    const submitExplore = async (topic) => {
      setDialogBusy(true)
      setDialogError('')
      const line = topic === '' ? '/opsx-explore' : `/opsx-explore ${String(topic).replace(/\s+/g, ' ').trim()}`
      const outcome = await runNow(line)
      setDialogBusy(false)
      if (outcome !== undefined && outcome !== null && outcome.ok === false) {
        setDialogError(outcome.text ?? t('commandSendFailed'))
        return
      }
      setDialog(null)
    }

    return { submitPropose, submitExplore }
  }

  function ProposeDialog({ t, busy, error: externalError, onClose, onSubmit }) {
    const [description, setDescription] = useState('')
    const [error, setError] = useState('')

    const submit = () => {
      if (busy === true) return
      const text = description.trim()
      if (text === '') {
        setError(t('proposeRequired'))
        return
      }
      setError('')
      onSubmit({ description: text })
    }

    return h(
      Modal,
      {
        t,
        title: t('proposeDialogTitle'),
        description: t('proposeDialogDesc'),
        onClose,
        width: 620,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', size: 'md', onClick: onClose, disabled: busy }, t('dialogCancel')),
          h(
            Button,
            { key: 'start', variant: 'primary', size: 'md', icon: 'send', onClick: submit, disabled: busy === true },
            busy === true ? t('commandSending') : t('proposeStart'),
          ),
        ],
      },
      h(
        'div',
        { className: 'dshspec-field' },
        h('label', { className: 'dshspec-fieldLabel' }, t('proposeDescriptionLabel')),
        h('textarea', {
          className: 'dshspec-textarea',
          rows: 4,
          maxLength: 4000,
          'data-autofocus': true,
          value: description,
          placeholder: t('proposeDescriptionPlaceholder'),
          onChange: (event) => setDescription(event.target.value),
          onKeyDown: (event) => {
            if (event.isComposing === true) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              submit()
            }
          },
        }),
      ),
      h('div', { className: 'dshspec-hint' }, t('proposeAutoNameHint')),
      error === '' ? null : h(Banner, { tone: 'error', wrap: true }, error),
      externalError === undefined || externalError === '' ? null : h(Banner, { tone: 'error', wrap: true }, externalError),
    )
  }

  function ExploreDialog({ t, busy, error: externalError, onClose, onSubmit }) {
    const [topic, setTopic] = useState('')
    return h(
      Modal,
      {
        t,
        title: t('exploreDialogTitle'),
        description: t('exploreDialogDesc'),
        onClose,
        width: 580,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', size: 'md', onClick: onClose, disabled: busy }, t('dialogCancel')),
          h(
            Button,
            { key: 'start', variant: 'primary', size: 'md', icon: 'compass', onClick: () => onSubmit(topic.trim()), disabled: busy === true },
            busy === true ? t('commandSending') : t('exploreStart'),
          ),
        ],
      },
      h(
        'div',
        { className: 'dshspec-field' },
        h('label', { className: 'dshspec-fieldLabel' }, t('exploreTopicLabel')),
        h('textarea', {
          className: 'dshspec-textarea',
          rows: 3,
          maxLength: 4000,
          'data-autofocus': true,
          value: topic,
          placeholder: t('exploreTopicPlaceholder'),
          onChange: (event) => setTopic(event.target.value),
          onKeyDown: (event) => {
            if (event.isComposing === true || busy === true) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              onSubmit(topic.trim())
            }
          },
        }),
      ),
      externalError === undefined || externalError === '' ? null : h(Banner, { tone: 'error', wrap: true }, externalError),
    )
  }

  /* ------------------------------------------------------------------ *
   * Data layer — Host-derived native state.
   *
   * The browser never parses openspec/ files: every shape below comes from
   * `ctx.connection.rpc.call('/dsh-spec', method, payload)` (see
   * docs/native-module-contract.md §4/§5). A session file watch (or a 2s poll
   * for session-less workspaces) only decides when to re-read; workflow state
   * is never stored outside the React external store.
   * ------------------------------------------------------------------ */

  /** Join an absolute workspace root and a workspace-relative POSIX path. */
  function joinPath(root, rel) {
    return `${String(root).replace(/[\\/]+$/, '')}/${rel}`
  }

  /** Workspace-relative POSIX form of a Host-provided path (relative paths pass through). */
  function relPathOf(cwd, path) {
    const raw = String(path ?? '').replace(/\\/g, '/')
    const root = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (root !== '' && (raw === root || raw.startsWith(`${root}/`))) {
      return raw.slice(root.length).replace(/^\/+/, '')
    }
    return raw.replace(/^\.\//, '')
  }

  /** One Host route call → value; throws on the `{ok:false}` envelope. */
  async function callRoute(ctx, method, payload, label) {
    const result = await withTimeout(
      Promise.resolve(ctx.connection.rpc.call(ROUTE, method, payload)),
      RPC_TIMEOUT_MS,
      label ?? method,
    )
    if (result === null || typeof result !== 'object') throw new Error(`${method} 无响应`)
    if (result.ok !== true) {
      const error = result.error
      throw new Error(typeof error?.message === 'string' ? error.message : String(error?.code ?? method))
    }
    return result.value
  }

  /** Normalize the Host WorkspaceState into the panel snapshot (defensive). */
  function normalizeState(value, cwd) {
    if (value === null || typeof value !== 'object') return { status: 'error', cwd, error: '状态为空' }
    const status = value.status === 'missing' || value.status === 'error' ? value.status : 'ready'
    const warnings = Array.isArray(value.warnings) ? value.warnings : []
    if (status === 'error') {
      const error =
        typeof value.error === 'string'
          ? value.error
          : warnings.length > 0
            ? warnings.join('；')
            : '状态读取失败'
      return { ...value, status, cwd: typeof value.cwd === 'string' ? value.cwd : cwd, error, warnings }
    }
    return {
      ...value,
      status,
      cwd: typeof value.cwd === 'string' ? value.cwd : cwd,
      changes: Array.isArray(value.changes) ? value.changes : [],
      specs: Array.isArray(value.specs) ? value.specs : [],
      schemas: Array.isArray(value.schemas) ? value.schemas : [],
      archived: Array.isArray(value.archived) ? value.archived : [],
      skills: value.skills ?? { native: [], fallbackActive: false },
      orchestration: Array.isArray(value.orchestration) ? value.orchestration : [],
      warnings: Array.isArray(value.warnings) ? value.warnings : [],
      archivedCount: typeof value.archivedCount === 'number' ? value.archivedCount : Array.isArray(value.archived) ? value.archived.length : 0,
    }
  }

  /**
   * Accept both the per-file delta rows (`{path,label,...counts}`) and the
   * legacy string path list, so a mixed Host version still renders.
   */
  /** Normalize one ChangeState (live or archived) so render code never crashes on a partial host. */
  function normalizeChangeState(change, fallbackName) {
    const value = change !== null && typeof change === 'object' ? change : {}
    return {
      ...value,
      name: typeof value.name === 'string' && value.name !== '' ? value.name : String(fallbackName ?? ''),
      schemaName: typeof value.schemaName === 'string' ? value.schemaName : '',
      schemaSource: value.schemaSource === 'project' || value.schemaSource === 'builtin' ? value.schemaSource : undefined,
      metadata: value.metadata !== null && typeof value.metadata === 'object' ? value.metadata : { found: false },
      summary: {
        ...normalizeChangeSummary(value.summary),
        headline: typeof value.summary?.headline === 'string' ? value.summary.headline : '',
        description: typeof value.summary?.description === 'string' ? value.summary.description : '',
        highlights: Array.isArray(value.summary?.highlights)
          ? value.summary.highlights.filter((item) => typeof item === 'string' && item !== '')
          : [],
        source: typeof value.summary?.source === 'string' ? value.summary.source : 'none',
      },
      artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
      docs: Array.isArray(value.docs) ? value.docs : [],
      delta:
        value.delta !== null && typeof value.delta === 'object'
          ? { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [], ...value.delta, files: normalizeDeltaFiles(value.delta.files) }
          : { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
      validation:
        value.validation !== null && typeof value.validation === 'object'
          ? { errors: 0, warnings: 0, infos: 0, issues: [], ...value.validation }
          : { errors: 0, warnings: 0, infos: 0, issues: [] },
      tasks: value.tasks !== null && typeof value.tasks === 'object' ? value.tasks : null,
      nextSteps: Array.isArray(value.nextSteps) ? value.nextSteps.filter((step) => typeof step === 'string') : [],
      applyRequires: Array.isArray(value.applyRequires) ? value.applyRequires : [],
      tracks: typeof value.tracks === 'string' ? value.tracks : null,
      isPlanningComplete: value.isPlanningComplete === true,
      listStatus: value.listStatus === 'complete' || value.listStatus === 'in-progress' ? value.listStatus : 'no-tasks',
    }
  }

  /**
   * Workspace source: one Host `state` snapshot plus the on-demand read-only
   * calls (`document`, `validate`, `sync-preview`, `archive-detail`) for one
   * absolute workspace path. Subscriptions drive the watch/poll lifecycle.
   */
  function createWorkspaceSource(ctx, row) {
    const cwd = row.cwd
    let snapshot = { status: 'loading', cwd }
    const listeners = new Set()
    const disposers = []
    /** proposal digest per change, keyed by change name + path (mixed-version fallback). */
    const summaryFallbacks = new Map()
    let epoch = 0
    let watchAlive = false
    let watchFailed = false
    let pollTimer = null
    let debounceTimer = null
    let dirty = false

    const publish = (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    }

    const clearPoll = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    /** Slow re-read while the panel is open (session-less workspace or watch down). */
    const poll = (ms) => {
      clearPoll()
      pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden === true) return
        if (listeners.size > 0) void refresh()
      }, ms)
    }

    /** Follow `<cwd>/openspec` through the session file watch. */
    const startWatch = (sessionId) => {
      if (watchAlive || watchFailed) return
      if (typeof ctx.remote?.$stream !== 'function' || typeof ctx.remote?.workspaceFiles?.changes !== 'function') {
        watchFailed = true
        poll(FALLBACK_POLL_MS)
        return
      }
      const root = joinPath(cwd, 'openspec')
      let stream
      watchAlive = true
      try {
        stream = ctx.remote.$stream({
          name: `openspec ${root}`,
          open: (lifetime) => ctx.remote.workspaceFiles.changes(sessionId, root, lifetime),
          ended: () => new Error(`openspec watch ended: ${root}`),
        })
      } catch {
        watchAlive = false
        watchFailed = true
        poll(FALLBACK_POLL_MS)
        return
      }
      disposers.push(() => {
        watchAlive = false
        void stream.dispose()
      })
      void (async () => {
        try {
          for await (const item of stream) {
            if (typeof item?.accept === 'function') item.accept()
            if (item?.value?.kind === 'change') scheduleRefresh()
          }
        } catch {
          watchAlive = false
          watchFailed = true
          if (listeners.size === 0) return
          if (snapshot.status === 'ready') publish({ ...snapshot, watchDown: true })
          poll(FALLBACK_POLL_MS)
        }
      })()
    }

    /** Pick the freshness strategy: session watch, else 2s polling. */
    const ensureFreshness = () => {
      if (listeners.size === 0) return
      const sessionId = row.sessionId
      if (typeof sessionId === 'string' && sessionId !== '') {
        // A directory move (archive/rename) is not always visible to the file
        // watch, so keep a low-frequency Host poll in addition to the watch.
        // Both paths only publish a new snapshot, so the quick bar's archive
        // button flips to the next native step a few seconds after archiving.
        if (pollTimer === null) poll(POLL_MS)
        if (!watchFailed) startWatch(sessionId)
        return
      }
      // No session: a workspace with no live session polls the Host route.
      if (pollTimer === null) poll(POLL_MS)
    }

    const refresh = async () => {
      const request = ++epoch
      try {
        const value = await callRoute(ctx, 'state', { cwd }, '读取 openspec 状态')
        if (request !== epoch) return
        const state = normalizeState(value, cwd)
        publish(state)
        ensureFreshness()
        // Mixed-version Hosts (pre-0.10.0) carry no summary digest; fill it from
        // proposal.md without blocking the first paint.
        void hydrateProposalSummaries(state, request)
      } catch (error) {
        if (request !== epoch) return
        const message = error instanceof Error ? error.message : String(error)
        if (snapshot.status === 'ready') publish({ ...snapshot, backgroundError: message })
        else publish({ status: 'error', cwd, error: message })
      }
    }

    const scheduleRefresh = () => {
      dirty = true
      if (debounceTimer !== null) return
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (dirty) {
          dirty = false
          void refresh()
        }
      }, REFRESH_DEBOUNCE_MS)
    }

    /**
     * Read one workspace document through the Host route.
     * @returns {{ok: boolean, path: string, text: string, offset: number, limit: number, truncated: boolean, totalLines: number|null, error?: string}}
     */
    const readDocument = async (path, options) => {
      const offset = typeof options?.offset === 'number' && options.offset > 0 ? Math.floor(options.offset) : 1
      const limit = typeof options?.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : DOC_PAGE_LINES
      try {
        const value = await callRoute(ctx, 'document', { cwd, path: relPathOf(cwd, path), offset, limit }, '读取文档')
        return {
          ok: true,
          path,
          text: typeof value?.text === 'string' ? value.text : '',
          offset,
          limit,
          truncated: value?.truncated === true,
          totalLines: typeof value?.totalLines === 'number' && Number.isFinite(value.totalLines) ? value.totalLines : null,
        }
      } catch (error) {
        return { ok: false, path, text: '', offset, limit, truncated: false, totalLines: null, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Fill the L1 "why / what changes" digest when the running Host predates the
     * 0.10.0 `summary.why` / `summary.changes` payload.
     *
     * A long-lived DSH process keeps the Host half loaded while a page refresh
     * picks up the new browser bundle, so a mixed version is the normal case
     * right after an upgrade. `proposal.md` is still reachable through the
     * `document` route the reader already uses, so the browser derives the
     * digest locally instead of showing the "no proposal yet" placeholder.
     * Reads run in parallel and are cached briefly (the workspace poll must
     * never turn into a document-read loop). The hydrated state is published as
     * a NEW snapshot object: the panel's store compares snapshot identities, so
     * mutating the current one in place would not re-render the collapsed
     * summary lines.
     *
     * @param {object} state - just-published `WorkspaceState` (never mutated).
     * @param {number} request - refresh epoch that owns this hydration.
     * @returns {Promise<void>}
     */
    const hydrateProposalSummaries = async (state, request) => {
      const changes = state !== null && typeof state === 'object' && Array.isArray(state.changes) ? state.changes : []
      if (changes.length === 0) return
      const now = Date.now()
      /** @type {Array<{index: number, change: object, path: string, key: string, digest: object|null}>} */
      const targets = []
      for (const [index, change] of changes.entries()) {
        if (request !== epoch) return
        if (change === null || typeof change !== 'object') continue
        if (!summaryNeedsProposalFallback(normalizeChangeSummary(change.summary))) continue
        const doc = proposalDocOf(change)
        if (doc === null) continue
        const path = relPathOf(cwd, doc.path)
        if (path === '') continue
        const key = `${String(change.name ?? '')}\u0000${path}`
        const cached = summaryFallbacks.get(key)
        const digest = cached !== undefined && now - cached.at < SUMMARY_FALLBACK_TTL_MS ? cached.digest : null
        targets.push({ index, change, path, key, digest })
      }
      if (targets.length === 0) return
      await Promise.all(
        targets
          .filter((target) => target.digest === null)
          .map(async (target) => {
            const page = await readDocument(target.path, { offset: 1, limit: SUMMARY_FALLBACK_LINES })
            if (!page.ok) return
            const digest = proposalSummaryDigest(page.text)
            if (digest === null) return
            target.digest = digest
            summaryFallbacks.set(target.key, { at: Date.now(), digest })
          }),
      )
      if (request !== epoch) return
      /** @type {Map<number, object>} */
      const summaries = new Map()
      for (const target of targets) {
        if (target.digest === null) continue
        summaries.set(target.index, applyProposalDigest(target.change.summary, target.digest))
      }
      if (summaries.size === 0) return
      publish({
        ...state,
        changes: changes.map((change, index) =>
          summaries.has(index) ? { ...change, summary: summaries.get(index) } : change,
        ),
      })
    }

    /** Fallback archive detail for hosts without `archive-detail`: probe known artifacts. */
    const probeArchivedChange = async (path, entry) => {
      const candidates = ['.openspec.yaml', 'tasks.md', 'proposal.md', 'design.md']
      const docs = []
      let tasksText = ''
      let metadataText = ''
      for (const rel of candidates) {
        const page = await readDocument(`${path}/${rel}`, { offset: 1, limit: 400 })
        if (!page.ok) continue
        if (rel === 'tasks.md') tasksText = page.text
        else if (rel === '.openspec.yaml') metadataText = page.text
        else docs.push({ path: `${path}/${rel}`, label: rel, artifactId: rel.replace(/\.md$/, ''), kind: 'artifact' })
      }
      if (docs.length === 0 && tasksText === '' && metadataText === '') return null
      const tasks = tasksText === '' ? null : countTaskCheckboxes(tasksText)
      return normalizeChangeState(
        {
          name: entry?.changeName,
          metadata: { found: metadataText !== '', schema: null, created: null, goal: null, skip_specs: null },
          artifacts: [],
          docs,
          tasks,
          delta: { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
          validation: { errors: 0, warnings: 0, infos: 0, issues: [] },
          nextSteps: [],
          isPlanningComplete: false,
          listStatus: 'no-tasks',
          fallback: true,
          metadataText,
        },
        entry?.changeName ?? archiveEntryLabel(entry ?? {}),
      )
    }

    /** Load one archived change on demand (primary: `archive-detail`, fallback: known-file probe). */
    const loadArchive = async (entry) => {
      const path = relPathOf(cwd, entry?.path ?? '')
      if (path === '') return { ok: false, error: '归档路径为空' }
      try {
        const value = await callRoute(ctx, 'archive-detail', { cwd, path }, '读取归档')
        const change = normalizeChangeState(value?.change, entry?.changeName ?? archiveEntryLabel(entry ?? {}))
        return { ok: true, change, fallback: false }
      } catch (error) {
        const probed = await probeArchivedChange(path, entry)
        if (probed !== null) return { ok: true, change: probed, fallback: true }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** On-demand validation for one change (`validate` route method). */
    const validateChange = async (changeName) => {
      try {
        const value = await callRoute(ctx, 'validate', { cwd, change: changeName }, '校验')
        const validation = value?.validation ?? value ?? null
        return { ok: true, validation, name: value?.name ?? changeName }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Read-only merge preview for one change (`sync-preview` route method). */
    const syncPreview = async (changeName) => {
      try {
        const value = await callRoute(ctx, 'sync-preview', { cwd, change: changeName }, '同步预览')
        return { ok: true, text: typeof value?.text === 'string' ? value.text : '', preview: value?.preview ?? null }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Compose the human-report prompt for one archived change or a date range
     * (`report-prompt`, read-only). Returns the raw Host value: `{text, ...}`.
     *
     * @param {object} payload - report payload (`scope`, `path`/`name` or `from`/`to`, `reportRoot`, `inArchive`).
     * @returns {Promise<object>} Host value with the composed prompt.
     */
    const reportPrompt = async (payload) => {
      const value = await callRoute(ctx, 'report-prompt', { cwd, ...payload }, '生成报告提示词')
      return value
    }

    /**
     * Discover an existing report for one archived change or a date range
     * (`report-status`, read-only). Returns the raw Host value; the dialog
     * normalizes it with `normalizeReportStatus`.
     *
     * @param {object} payload - same payload shape as {@link reportPrompt}.
     * @returns {Promise<object>} Host value with `{exists, path, ...}`.
     */
    const reportStatus = async (payload) => {
      const value = await callRoute(ctx, 'report-status', { cwd, ...payload }, '读取报告状态')
      return value
    }

    /** Tick or untick one task checkbox (`task-toggle` route method), then re-read state. */
    const toggleTask = async (changeName, line, done) => {
      try {
        const value = await callRoute(
          ctx,
          'task-toggle',
          { cwd, change: changeName, line, done: done === true },
          '更新任务',
        )
        await refresh()
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const start = () => {
      watchFailed = false
      disposers.push(
        ctx.on('connection/reset', () => {
          watchAlive = false
          watchFailed = false
          clearPoll()
          void refresh()
        }),
      )
      void refresh()
    }

    const stop = () => {
      epoch += 1
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      clearPoll()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* best-effort teardown */
        }
      }
    }

    return {
      cwd,
      sessionId: row.sessionId,
      hooks: {
        state: {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            if (listeners.size === 1) start()
            return () => {
              listeners.delete(listener)
              if (listeners.size === 0) stop()
            }
          },
        },
      },
      refresh,
      readDocument,
      loadArchive,
      validateChange,
      syncPreview,
      reportPrompt,
      reportStatus,
      toggleTask,
    }
  }

  /** Session-less init through the Host route; reports the native scaffold's created items. */
  async function initWorkspace(ctx, cwd) {
    try {
      const value = await callRoute(ctx, 'init', { cwd: typeof cwd === 'string' ? cwd : '' }, '初始化')
      const created = Array.isArray(value?.created) ? value.created.filter((item) => typeof item === 'string') : []
      return {
        ok: true,
        text: typeof value?.text === 'string' ? value.text : '',
        created,
      }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error), created: [] }
    }
  }

  /* ------------------------------------------------------------------ *
   * Change ↔ session bindings.
   *
   * A change gets one conversation. The binding is UI state, not OpenSpec
   * workflow state, so it lives in the browser's localStorage (per origin) and
   * keyed by the canonical workspace path + change name. The Host title watcher
   * and every panel/dock action also refresh it, so a session started by typing
   * a phase command is bound the same way as one started from the panel.
   * ------------------------------------------------------------------ */

  /** localStorage key; bump the suffix when the shape changes. */
  const BINDINGS_KEY = 'dsh-spec.bindings.v1'

  /** Stable, separator-normalized workspace key. */
  function bindingCwdKey(cwd) {
    return String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /** Empty immutable binding snapshot. */
  const EMPTY_BINDINGS = Object.freeze({ version: 1, workspaces: Object.freeze({}) })

  /** Coerce an arbitrary localStorage value into the binding shape. */
  function normalizeBindings(value) {
    if (value === null || typeof value !== 'object' || value.workspaces === null || typeof value.workspaces !== 'object') {
      return EMPTY_BINDINGS
    }
    const workspaces = {}
    for (const [rawCwd, workspace] of Object.entries(value.workspaces)) {
      if (rawCwd === '' || workspace === null || typeof workspace !== 'object') continue
      const changes = {}
      const rawChanges = workspace.changes !== null && typeof workspace.changes === 'object' ? workspace.changes : {}
      for (const [name, binding] of Object.entries(rawChanges)) {
        if (name === '' || binding === null || typeof binding !== 'object') continue
        if (typeof binding.sessionId !== 'string' || binding.sessionId === '') continue
        changes[name] = {
          sessionId: binding.sessionId,
          phase: typeof binding.phase === 'string' ? binding.phase : 'unknown',
          updatedAt: Number.isFinite(binding.updatedAt) ? binding.updatedAt : 0,
        }
      }
      const explore =
        workspace.explore !== null && typeof workspace.explore === 'object' && typeof workspace.explore.sessionId === 'string' && workspace.explore.sessionId !== ''
          ? { sessionId: workspace.explore.sessionId, updatedAt: Number.isFinite(workspace.explore.updatedAt) ? workspace.explore.updatedAt : 0 }
          : null
      workspaces[bindingCwdKey(rawCwd)] = { changes, explore }
    }
    return { version: 1, workspaces }
  }

  /** Read the stored bindings, tolerating unavailable/blocked storage. */
  function loadBindings() {
    try {
      if (typeof localStorage === 'undefined') return EMPTY_BINDINGS
      const raw = localStorage.getItem(BINDINGS_KEY)
      if (raw === null || raw === '') return EMPTY_BINDINGS
      return normalizeBindings(JSON.parse(raw))
    } catch {
      return EMPTY_BINDINGS
    }
  }

  /** Persist one binding snapshot; storage failures are ignored (UI state only). */
  function saveBindings(snapshot) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(BINDINGS_KEY, JSON.stringify(snapshot))
    } catch {
      /* quota/private mode: bindings stay in memory for this page */
    }
  }

  /* ------------------------------------------------------------------ *
   * Report settings.
   *
   * The report root / archive-folder choice is a browser UI preference, not
   * OpenSpec workflow state: it lives in this browser's localStorage, keyed by
   * the canonical workspace path (the same precedent as the change bindings),
   * and is never written into `openspec/`.
   * ------------------------------------------------------------------ */

  /** localStorage key; bump the suffix when the shape changes. */
  const REPORT_SETTINGS_KEY = 'dsh-spec.report.v1'

  /** One workspace's report preference, defaulting to the report root mode. */
  const DEFAULT_REPORT_SETTINGS = Object.freeze({ root: normalizeReportRoot(undefined), mode: 'root' })

  /**
   * Read one workspace's report preference; blocked storage degrades to the
   * default instead of throwing in the dialog.
   *
   * @param {string} cwd - absolute workspace root.
   * @returns {{root: string, mode: 'root'|'archive'}} preference for this workspace.
   */
  function loadReportSettings(cwd) {
    try {
      if (typeof localStorage === 'undefined') return { ...DEFAULT_REPORT_SETTINGS }
      const raw = localStorage.getItem(REPORT_SETTINGS_KEY)
      if (raw === null || raw === '') return { ...DEFAULT_REPORT_SETTINGS }
      const settings = normalizeReportSettings(JSON.parse(raw))
      return settings.workspaces[reportSettingsCwdKey(cwd)] ?? { ...DEFAULT_REPORT_SETTINGS }
    } catch {
      return { ...DEFAULT_REPORT_SETTINGS }
    }
  }

  /**
   * Persist one workspace's report preference; storage failures are ignored
   * (the dialog keeps working with its in-memory value for this page).
   *
   * @param {string} cwd - absolute workspace root.
   * @param {{root?: string, mode?: 'root'|'archive'}} patch - preference fields to update.
   * @returns {void}
   */
  function saveReportSettings(cwd, patch) {
    try {
      if (typeof localStorage === 'undefined') return
      const key = reportSettingsCwdKey(cwd)
      if (key === '') return
      const raw = localStorage.getItem(REPORT_SETTINGS_KEY)
      const settings = normalizeReportSettings(raw === null || raw === '' ? undefined : JSON.parse(raw))
      const current = settings.workspaces[key] ?? { ...DEFAULT_REPORT_SETTINGS }
      settings.workspaces[key] = {
        root: patch?.root === undefined ? current.root : normalizeReportRoot(patch.root),
        mode: patch?.mode === 'archive' ? 'archive' : patch?.mode === 'root' ? 'root' : current.mode,
      }
      localStorage.setItem(REPORT_SETTINGS_KEY, JSON.stringify({ version: 1, workspaces: settings.workspaces }))
    } catch {
      /* quota/private mode: the preference stays in this dialog instance */
    }
  }

  /** Observable binding store shared by the panel, dock and notification watcher. */
  function createBindingStore() {
    let snapshot = loadBindings()
    const listeners = new Set()
    const notify = () => {
      for (const listener of listeners) listener()
    }
    const commit = (next) => {
      snapshot = next
      saveBindings(next)
      notify()
    }
    const updateWorkspace = (cwd, updater) => {
      const key = bindingCwdKey(cwd)
      const current = snapshot.workspaces[key] ?? { changes: {}, explore: null }
      const nextWorkspace = updater(current)
      commit({
        ...snapshot,
        workspaces: { ...snapshot.workspaces, [key]: nextWorkspace },
      })
    }
    return {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => snapshot,
      get(cwd, change) {
        if (typeof change !== 'string' || change === '') return null
        return snapshot.workspaces[bindingCwdKey(cwd)]?.changes?.[change] ?? null
      },
      getExplore(cwd) {
        return snapshot.workspaces[bindingCwdKey(cwd)]?.explore ?? null
      },
      changeForSession(cwd, sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        const changes = snapshot.workspaces[bindingCwdKey(cwd)]?.changes ?? {}
        for (const [name, binding] of Object.entries(changes)) {
          if (binding.sessionId === sessionId) return name
        }
        return null
      },
      findSession(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        for (const [cwd, workspace] of Object.entries(snapshot.workspaces)) {
          for (const [change, binding] of Object.entries(workspace.changes ?? {})) {
            if (binding.sessionId === sessionId) return { cwd, change, phase: binding.phase }
          }
          if (workspace.explore?.sessionId === sessionId) return { cwd, change: null, phase: 'explore' }
        }
        return null
      },
      set(cwd, change, sessionId, phase) {
        if (typeof change !== 'string' || change === '' || typeof sessionId !== 'string' || sessionId === '') return
        const existing = snapshot.workspaces[bindingCwdKey(cwd)]?.changes?.[change]
        if (existing !== undefined && existing.sessionId === sessionId && existing.phase === phase) return
        updateWorkspace(cwd, (workspace) => {
          // One conversation belongs to one change: binding a session to a new
          // change drops any previous change that still pointed at it, so the
          // panel never shows two changes sharing one window.
          const nextChanges = {}
          for (const [name, binding] of Object.entries(workspace.changes)) {
            if (name !== change && binding.sessionId === sessionId) continue
            nextChanges[name] = binding
          }
          nextChanges[change] = { sessionId, phase: typeof phase === 'string' ? phase : 'unknown', updatedAt: Date.now() }
          return { ...workspace, changes: nextChanges }
        })
      },
      setExplore(cwd, sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const existing = snapshot.workspaces[bindingCwdKey(cwd)]?.explore
        if (existing !== null && existing !== undefined && existing.sessionId === sessionId) return
        updateWorkspace(cwd, (workspace) => ({ ...workspace, explore: { sessionId, updatedAt: Date.now() } }))
      },
      remove(cwd, change) {
        const workspace = snapshot.workspaces[bindingCwdKey(cwd)]
        if (workspace === undefined || workspace.changes?.[change] === undefined) return
        const nextChanges = { ...workspace.changes }
        delete nextChanges[change]
        updateWorkspace(cwd, (current) => ({ ...current, changes: nextChanges }))
      },
      sessionIds() {
        const out = []
        for (const workspace of Object.values(snapshot.workspaces)) {
          for (const binding of Object.values(workspace.changes ?? {})) out.push(binding.sessionId)
          if (workspace.explore?.sessionId !== undefined) out.push(workspace.explore.sessionId)
        }
        return [...new Set(out)]
      },
    }
  }

  /* ------------------------------------------------------------------ *
   * Role ↔ session bindings.
   *
   * A role session is scoped to (program, task, role), not to a change: one
   * task may have four independent conversations with four models. The map is
   * browser-local like the change bindings and never written into openspec/.
   * ------------------------------------------------------------------ */

  /** localStorage key for role sessions; bump the suffix when the shape changes. */
  const ROLE_BINDINGS_KEY = 'dsh-spec.roles.v1'

  /** Empty immutable role-binding snapshot. */
  const EMPTY_ROLE_BINDINGS = Object.freeze({ version: 1, workspaces: Object.freeze({}) })

  /** Stable key inside one workspace. */
  function roleBindingKey(program, task, role) {
    return `${program}/${task}/${role}`
  }

  /** Coerce an arbitrary localStorage value into the role-binding shape. */
  function normalizeRoleBindings(value) {
    if (value === null || typeof value !== 'object' || value.workspaces === null || typeof value.workspaces !== 'object') {
      return EMPTY_ROLE_BINDINGS
    }
    const workspaces = {}
    for (const [rawCwd, workspace] of Object.entries(value.workspaces)) {
      if (rawCwd === '' || workspace === null || typeof workspace !== 'object') continue
      const roles = {}
      const rawRoles = workspace.roles !== null && typeof workspace.roles === 'object' ? workspace.roles : {}
      for (const [key, binding] of Object.entries(rawRoles)) {
        if (key === '' || binding === null || typeof binding !== 'object') continue
        if (typeof binding.sessionId !== 'string' || binding.sessionId === '') continue
        roles[key] = {
          sessionId: binding.sessionId,
          updatedAt: Number.isFinite(binding.updatedAt) ? binding.updatedAt : 0,
        }
      }
      workspaces[bindingCwdKey(rawCwd)] = { roles }
    }
    return { version: 1, workspaces }
  }

  /** Read the stored role bindings, tolerating unavailable/blocked storage. */
  function loadRoleBindings() {
    try {
      if (typeof localStorage === 'undefined') return EMPTY_ROLE_BINDINGS
      const raw = localStorage.getItem(ROLE_BINDINGS_KEY)
      if (raw === null || raw === '') return EMPTY_ROLE_BINDINGS
      return normalizeRoleBindings(JSON.parse(raw))
    } catch {
      return EMPTY_ROLE_BINDINGS
    }
  }

  /** Persist one role-binding snapshot; storage failures are ignored. */
  function saveRoleBindings(snapshot) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(ROLE_BINDINGS_KEY, JSON.stringify(snapshot))
    } catch {
      /* quota/private mode: bindings stay in memory for this page */
    }
  }

  /** Observable role-binding store shared by the panel and the notification watcher. */
  function createRoleBindingStore() {
    let snapshot = loadRoleBindings()
    const listeners = new Set()
    const notify = () => {
      for (const listener of listeners) listener()
    }
    const commit = (next) => {
      snapshot = next
      saveRoleBindings(next)
      notify()
    }
    return {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => snapshot,
      get(cwd, program, task, role) {
        const key = roleBindingKey(program, task, role)
        return snapshot.workspaces[bindingCwdKey(cwd)]?.roles?.[key] ?? null
      },
      set(cwd, program, task, role, sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const workspaceKey = bindingCwdKey(cwd)
        const current = snapshot.workspaces[workspaceKey] ?? { roles: {} }
        const key = roleBindingKey(program, task, role)
        if (current.roles?.[key]?.sessionId === sessionId) return
        commit({
          ...snapshot,
          workspaces: {
            ...snapshot.workspaces,
            [workspaceKey]: {
              ...current,
              roles: { ...(current.roles ?? {}), [key]: { sessionId, updatedAt: Date.now() } },
            },
          },
        })
      },
      remove(cwd, program, task, role) {
        const workspaceKey = bindingCwdKey(cwd)
        const current = snapshot.workspaces[workspaceKey]
        const key = roleBindingKey(program, task, role)
        if (current?.roles?.[key] === undefined) return
        const roles = { ...current.roles }
        delete roles[key]
        commit({ ...snapshot, workspaces: { ...snapshot.workspaces, [workspaceKey]: { ...current, roles } } })
      },
      findSession(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        for (const [cwd, workspace] of Object.entries(snapshot.workspaces)) {
          for (const [key, binding] of Object.entries(workspace.roles ?? {})) {
            if (binding.sessionId === sessionId) {
              const [program, task, role] = key.split('/')
              return { cwd, program, task, role }
            }
          }
        }
        return null
      },
      sessionIds() {
        const out = []
        for (const workspace of Object.values(snapshot.workspaces)) {
          for (const binding of Object.values(workspace.roles ?? {})) out.push(binding.sessionId)
        }
        return [...new Set(out)]
      },
    }
  }

  /** Subscribe to the role-binding store snapshot. */
  function useRoleBindings(store) {
    return useSyncExternalStore(
      store !== undefined && typeof store?.subscribe === 'function' ? store.subscribe : () => () => {},
      store !== undefined && typeof store?.getSnapshot === 'function' ? store.getSnapshot : () => EMPTY_ROLE_BINDINGS,
    )
  }

  /** Stable empty snapshot for compositions without `uiSession.sessionStatus`. */
  const EMPTY_SESSION_STATUSES = new Map()

  /** Read the published `uiSession.sessionStatus` source, when this composition has it. */
  function emptySessionStatuses() {
    return EMPTY_SESSION_STATUSES
  }

  /** Subscribe to `uiSession.sessionStatus` (running / pending interaction / unread). */
  function useSessionStatuses(source) {
    return useSyncExternalStore(
      source !== undefined && typeof source?.subscribe === 'function' ? source.subscribe : () => () => {},
      source !== undefined && typeof source?.getSnapshot === 'function' ? source.getSnapshot : emptySessionStatuses,
    )
  }

  /** Stable empty model-catalog snapshot. */
  const EMPTY_MODEL_CATALOG = Object.freeze({ value: null, status: 'idle', error: null })

  /** Read the shared provider/model catalog for the role model picker. */
  function useModelCatalog(modelDirectories) {
    const catalog = modelDirectories !== null && typeof modelDirectories === 'object' ? modelDirectories.catalog : undefined
    useEffect(() => {
      if (catalog !== undefined && typeof catalog.load === 'function') catalog.load().catch(() => {})
    }, [catalog])
    const store = catalog?.store
    return useSyncExternalStore(
      store !== undefined && typeof store.subscribe === 'function' ? (listener) => store.subscribe(listener) : () => () => {},
      store !== undefined && typeof store.getSnapshot === 'function' ? () => store.getSnapshot() : () => EMPTY_MODEL_CATALOG,
    )
  }

  /** Subscribe to the binding store snapshot. */
  function useBindings(store) {
    return useSyncExternalStore(
      store !== undefined && typeof store?.subscribe === 'function' ? store.subscribe : () => () => {},
      store !== undefined && typeof store?.getSnapshot === 'function' ? store.getSnapshot : () => EMPTY_BINDINGS,
    )
  }

  /** Listen for the in-app fallback emitted when OS notifications are blocked. */
  function useSystemNotice(handler) {
    const ref = useRef(handler)
    ref.current = handler
    useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
      const onNotice = (event) => {
        const detail = event?.detail
        if (detail === null || detail === undefined) return
        const title = typeof detail.title === 'string' && detail.title !== '' ? detail.title : ''
        const text = typeof detail.text === 'string' && detail.text !== '' ? detail.text : title
        const notice = title !== '' && text !== title ? `${title} · ${text}` : text
        if (typeof notice === 'string' && notice !== '') ref.current(notice, detail)
      }
      window.addEventListener('dsh-spec:notice', onNotice)
      return () => window.removeEventListener('dsh-spec:notice', onNotice)
    }, [])
  }

  /** Map one change + its bound-session status to the panel's live state badge. */
  function changeStatusInfo(change, binding, statuses, t) {
    const status = binding !== null && binding !== undefined && statuses instanceof Map ? statuses.get(binding.sessionId) : undefined
    const waiting = status?.pendingInteraction !== undefined && status?.pendingInteraction !== null
    const running = status?.running === true
    const complete = change?.isPlanningComplete === true && change?.listStatus === 'complete'
    let kind
    if (waiting) kind = 'waiting'
    else if (running) kind = 'running'
    else if (complete) kind = 'complete'
    else if (change?.isPlanningComplete !== true) kind = 'planning'
    else if (change?.listStatus === 'in-progress') kind = 'implementing'
    else kind = 'ready'
    const labelKey = {
      waiting: 'statusWaiting',
      running: 'statusRunning',
      complete: 'statusComplete',
      planning: 'statusPlanning',
      implementing: 'statusImplementing',
      ready: 'statusReady',
    }[kind]
    const tone = {
      waiting: 'warn',
      running: 'business',
      complete: 'success',
      planning: 'business',
      implementing: 'business',
      ready: 'muted',
    }[kind]
    return {
      kind,
      label: typeof t === 'function' ? t(labelKey) : labelKey,
      tone,
      busy: running || waiting,
      status,
      sessionId: binding?.sessionId ?? null,
    }
  }

  /** The session row's cwd from the sessions store snapshot (shape-defensive). */
  function cwdOf(ctx, sessionId) {
    try {
      const snap = ctx.sessions.list.getSnapshot()
      if (!snap) return undefined
      const rows = Array.isArray(snap)
        ? snap
        : snap.byId !== undefined && snap.byId !== null
          ? Object.values(snap.byId)
          : Array.isArray(snap.sessions)
            ? snap.sessions
            : []
      for (const row of rows) {
        if (row !== null && typeof row === 'object' && (row.id === sessionId || row.sessionId === sessionId)) {
          return row.cwd
        }
      }
    } catch {
      /* store unavailable: no cwd */
    }
    return undefined
  }

  /**
   * Workspace rows for the panel: the workspaces store is authoritative
   * (workspaceId + canonical path + its accounted sessions), with the sessions
   * store as a fallback when the workspaces face is unavailable. `sessionId`
   * is the dispatch/read target — `undefined` means "no session yet".
   */
  function workspaceRows(ctx) {
    const joined = []
    try {
      const snap = ctx.workspaces.list.getSnapshot()
      if (snap) {
        const views = Array.isArray(snap)
          ? snap
          : snap.byId !== undefined && snap.byId !== null
            ? Object.values(snap.byId)
            : Array.isArray(snap.items)
              ? snap.items
              : Array.isArray(snap.workspaces)
                ? snap.workspaces
                : []
        for (const view of views) {
          if (view === null || typeof view !== 'object') continue
          const workspaceId = view.workspaceId ?? view.id
          const cwd = view.path ?? view.cwd
          if (typeof workspaceId !== 'string' || typeof cwd !== 'string' || cwd === '') continue
          const sessionIds = Array.isArray(view.sessionIds)
            ? view.sessionIds.filter((id) => typeof id === 'string')
            : []
          joined.push({
            workspaceId,
            cwd,
            sessionId: sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : undefined,
            sessionIds,
            title: typeof view.title === 'string' ? view.title : undefined,
          })
        }
      }
    } catch {
      /* workspaces store unavailable: fall back below */
    }
    if (joined.length > 0) return joined
    try {
      const snap = ctx.sessions.list.getSnapshot()
      if (!snap) return []
      const rows = Array.isArray(snap)
        ? snap
        : snap.byId !== undefined && snap.byId !== null
          ? Object.values(snap.byId)
          : Array.isArray(snap.sessions)
            ? snap.sessions
            : []
      const seen = new Map()
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const id = row.id ?? row.sessionId
        const cwd = row.cwd
        if (typeof id !== 'string' || typeof cwd !== 'string' || cwd === '') continue
        if (!seen.has(cwd)) seen.set(cwd, { workspaceId: undefined, sessionId: id, cwd })
      }
      return [...seen.values()]
    } catch {
      return []
    }
  }

  /** Reject after `ms` so a lost RPC cannot hang the UI silently. */
  function withTimeout(promise, ms, label) {
    let timer
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  /**
   * Tone → `--dsw-*` color token. Tones come from the pure helpers
   * (`artifactStatusTone`, `issueLevelTone`); the mapping to theme tokens is
   * presentation and lives here.
   */
  const TONE_COLOR = {
    success: 'var(--dsw-alias-state-success-primary)',
    muted: 'var(--dsw-alias-label-tertiary)',
    business: 'var(--dsw-alias-state-business-primary)',
    warn: 'var(--dsw-alias-state-warn-primary)',
    error: 'var(--dsw-alias-state-error-primary)',
    info: 'var(--dsw-alias-label-secondary)',
  }

  /** Resolve one helper tone to a theme color token. */
  function toneColor(tone) {
    return TONE_COLOR[tone] ?? TONE_COLOR.muted
  }

  /** The change the quick bar targets: the first change still being planned, else the first active one. */
  function primaryChange(state) {
    if (state === null || state === undefined || state.status !== 'ready' || !Array.isArray(state.changes) || state.changes.length === 0) return undefined
    return (
      state.changes.find((change) => change.isPlanningComplete !== true) ??
      state.changes.find((change) => change.listStatus !== 'complete') ??
      state.changes[0]
    )
  }

  /** Find the workspace row that a mounted session belongs to (quick bar). */
  function rowForSession(ctx, sessionId) {
    const rows = workspaceRows(ctx)
    const match = rows.find(
      (row) => row.sessionId === sessionId || (Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId)),
    )
    if (match !== undefined) return match
    const cwd = cwdOf(ctx, sessionId)
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return { workspaceId: undefined, cwd, sessionId, sessionIds: [sessionId] }
  }

  /** Format one templated locale string (`{name}` placeholders). */
  function tx(t, key, vars) {
    let text = t(key)
    if (typeof text !== 'string') text = String(key)
    if (vars !== undefined && vars !== null) {
      for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
    }
    return text
  }

  function basenameOf(path) {
    const trimmed = String(path ?? '').replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return index === -1 ? trimmed : trimmed.slice(index + 1)
  }

  /**
   * Put one command line into the conversation draft WITHOUT sending it:
   * focus the composer editor, move the caret to the end, insert the text.
   * The user then completes the arguments and presses Enter themselves.
   */
  function insertIntoComposer(text) {
    const editor = document.querySelector('[contenteditable="true"]')
    if (editor === null) return false
    editor.focus()
    const selection = window.getSelection()
    if (selection !== null) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    const hadText = (editor.textContent ?? '').trim() !== ''
    if (hadText) document.execCommand('insertLineBreak', false, '')
    if (document.execCommand('insertText', false, text)) return true
    editor.textContent += (hadText ? '\n' : '') + text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  /**
   * Replace the whole conversation draft with one command line, WITHOUT
   * sending it. Used by the change picker when the session input service is not
   * reachable: select everything in the editor and type over it, so the picked
   * change never stacks on the command token that opened the picker.
   *
   * @param {string} text - full command line, e.g. `/opsx-update add-dark-mode `.
   * @returns {boolean} whether an editor was found and updated.
   */
  function replaceComposerText(text) {
    const editor = document.querySelector('[contenteditable="true"]')
    if (editor === null) return false
    const line = String(text ?? '')
    editor.focus()
    const selection = window.getSelection()
    if (selection !== null) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    if (document.execCommand('insertText', false, line)) return true
    editor.textContent = line
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  /**
   * Copy one plain-text value to the clipboard. The async Clipboard API is
   * preferred; a temporary textarea keeps the button working when the browser
   * blocks it (or when the page is not focused). Never throws.
   *
   * @param {string} text - text to copy.
   * @returns {Promise<boolean>} whether the copy likely succeeded.
   */
  async function copyTextToClipboard(text) {
    const value = String(text ?? '')
    if (value === '') return false
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(value)
        return true
      }
    } catch {
      /* fall through to the DOM fallback */
    }
    try {
      if (typeof document === 'undefined') return false
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false
      document.body.removeChild(area)
      return copied
    } catch {
      return false
    }
  }

  /* ------------------------------------------------------------------ *
   * Panel surfaces.
   * ------------------------------------------------------------------ */

  /** Small tone badge: dot + text, used for schema sources, skip_specs, skills. */
  function ToneBadge({ tone, title, children }) {
    return h(
      'span',
      { className: 'dshspec-badge', title: title ?? undefined },
      h('span', { className: 'dshspec-badgeDot', style: { background: toneColor(tone) } }),
      children,
    )
  }

  /** Collapsible section with an optional count, header meta and action. */
  function Section({ title, count, headMeta, action, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen)
    return h(
      'section',
      { className: 'dshspec-section' },
      h(
        'div',
        { className: 'dshspec-sectionHead' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshspec-sectionToggle',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
          h('span', { className: 'dshspec-sectionTitle' }, title),
          count === undefined || count === null ? null : h('span', { className: 'dshspec-sectionCount' }, String(count)),
        ),
        headMeta ?? null,
        h('span', { className: 'dshspec-space' }),
        action ?? null,
      ),
      open ? h('div', { className: 'dshspec-sectionBody' }, children) : null,
    )
  }

  /** "There is more" footer — lists are never silently truncated. */
  function ListMore({ t, hidden, reveal, onMore }) {
    if (!(hidden > 0)) return null
    return h(
      'div',
      { className: 'dshspec-pageFoot' },
      h('span', null, moreItemsText(t, hidden)),
      h(
        'button',
        { type: 'button', className: 'dshspec-taskMore', onClick: onMore },
        h(Icon, { name: 'chevronDown', size: 12 }),
        tx(t, 'showMoreItems', { count: reveal }),
      ),
    )
  }

  /** Visible-count state for paged lists; grows by one page per click. */
  function useVisibleLimit(step) {
    const [limit, setLimit] = useState(step)
    const reveal = useCallback(() => setLimit((value) => value + step), [step])
    return [limit, reveal]
  }

  /** One-click init control: posts the workspace to the Host route, then refreshes. */
  function InitControl({ t, cwd, init, refresh }) {
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState(null)
    const initialize = async () => {
      setBusy(true)
      try {
        setResult(typeof init === 'function' ? await init(cwd) : { ok: false, text: t('commandFailed'), created: [] })
      } catch (error) {
        setResult({ ok: false, text: error instanceof Error ? error.message : String(error), created: [] })
      }
      if (typeof refresh === 'function') await refresh()
      setBusy(false)
    }
    const created = Array.isArray(result?.created) ? result.created : []
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' } },
      h(
        Button,
        { variant: 'primary', size: 'md', icon: 'folderPlus', disabled: busy, onClick: () => void initialize() },
        busy ? t('initBusy') : t('init'),
      ),
      result === null
        ? null
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' } },
            created.length > 0
              ? h(
                  'div',
                  { className: 'dshspec-chipRow' },
                  h('span', { className: 'dshspec-inlineTag' }, tx(t, 'initCreated', { items: '' })),
                  created.map((item) => h('span', { key: item, className: 'dshspec-fileChip' }, item)),
                )
              : null,
            result.ok === true
              ? h(Banner, { tone: 'info', wrap: true }, result.text === '' ? t('initAlready') : result.text)
              : h(Banner, { tone: 'error', wrap: true }, result.text ?? t('commandFailed')),
          ),
    )
  }

  function MissingBody({ t, init, refresh, cwd }) {
    return h(
      'div',
      { className: 'dshspec-missing' },
      h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'folderPlus', size: 20 })),
      h(
        'div',
        { className: 'dshspec-missingText' },
        h('div', { className: 'dshspec-missingTitle' }, t('missing')),
        h('div', { className: 'dshspec-missingDesc' }, t('missingHint')),
        h(InitControl, { t, init, refresh, cwd }),
      ),
    )
  }

  function LoadingBody() {
    return h(
      'div',
      { className: 'dshspec-loading', 'aria-hidden': 'true' },
      h('div', { className: 'dshspec-skelLine', style: { width: '42%' } }),
      h('div', { className: 'dshspec-skelLine', style: { width: '68%' } }),
      h('div', { className: 'dshspec-skelLine', style: { width: '55%' } }),
    )
  }

  function SectionEmpty({ icon, title, hint, action }) {
    return h(
      'div',
      { className: 'dshspec-sectionEmpty' },
      h('span', { className: 'dshspec-sectionEmptyIcon' }, h(Icon, { name: icon, size: 18 })),
      h('div', { className: 'dshspec-sectionEmptyTitle' }, title),
      hint === undefined ? null : h('div', { className: 'dshspec-sectionEmptyHint' }, hint),
      action ?? null,
    )
  }

  /* ------------------------------------------------------------------ *
   * Small document renderer — a safe Markdown subset, no HTML injection.
   * ------------------------------------------------------------------ */

  function renderInline(text, keyBase) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
    const out = []
    let last = 0
    let index = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index))
      const token = match[0]
      if (token.startsWith('`')) {
        out.push(h('code', { key: `${keyBase}-c${index++}`, className: 'dshspec-mdCode' }, token.slice(1, -1)))
      } else if (token.startsWith('**')) {
        out.push(h('strong', { key: `${keyBase}-b${index++}` }, token.slice(2, -2)))
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
        if (link === null) out.push(token)
        else out.push(h('a', { key: `${keyBase}-a${index++}`, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
      }
      last = match.index + token.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }

  function Markdown({ text }) {
    const lines = String(text ?? '').split(/\r?\n/)
    const blocks = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      if (/^\s*```/.test(line)) {
        i += 1
        const code = []
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          code.push(lines[i])
          i += 1
        }
        if (i < lines.length) i += 1
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'dshspec-mdPre' }, h('code', null, code.join('\n'))))
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading !== null) {
        const level = heading[1].length
        const keyBase = `b${blocks.length}`
        blocks.push(
          h(
            `h${Math.min(level + 1, 4)}`,
            { key: keyBase, className: `dshspec-mdH dshspec-mdH${level}` },
            renderInline(heading[2], keyBase),
          ),
        )
        i += 1
        continue
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        blocks.push(h('hr', { key: `b${blocks.length}`, className: 'dshspec-mdHr' }))
        i += 1
        continue
      }
      if (/^\s*>/.test(line)) {
        const quote = []
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''))
          i += 1
        }
        const keyBase = `b${blocks.length}`
        blocks.push(
          h(
            'blockquote',
            { key: keyBase, className: 'dshspec-mdQuote' },
            quote.map((piece, qi) => h('p', { key: qi, className: 'dshspec-mdP' }, renderInline(piece, `${keyBase}-${qi}`))),
          ),
        )
        continue
      }
      if (/^\s*\|/.test(line)) {
        const table = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          table.push(lines[i])
          i += 1
        }
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'dshspec-mdPre' }, h('code', null, table.join('\n'))))
        continue
      }
      const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (listItem !== null) {
        const ordered = /\d/.test(listItem[2])
        const baseIndent = listItem[1].length
        const items = []
        while (i < lines.length) {
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
          if (item === null) break
          const indent = item[1].length
          if (indent < baseIndent) break
          const checkbox = /^\[([ xX])\]\s*(.*)$/.exec(item[3])
          const content = checkbox === null ? item[3] : checkbox[2]
          const keyBase = `b${blocks.length}-${items.length}`
          items.push(
            h(
              'li',
              { key: keyBase, className: 'dshspec-mdLi', style: indent > baseIndent ? { marginLeft: 16 } : undefined },
              checkbox === null
                ? null
                : h('span', { className: 'dshspec-mdCheck' + (checkbox[1] !== ' ' ? ' dshspec-mdCheckOn' : '') }, checkbox[1] !== ' ' ? '✓' : ''),
              renderInline(content, keyBase),
            ),
          )
          i += 1
        }
        blocks.push(h(ordered ? 'ol' : 'ul', { key: `b${blocks.length}`, className: 'dshspec-mdList' }, items))
        continue
      }
      const paragraph = []
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^\s*(```|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/.test(lines[i])
      ) {
        paragraph.push(lines[i])
        i += 1
      }
      const keyBase = `b${blocks.length}`
      blocks.push(h('p', { key: keyBase, className: 'dshspec-mdP' }, renderInline(paragraph.join(' '), keyBase)))
    }
    return h('div', { className: 'dshspec-markdown' }, blocks)
  }

  /** Read-only Markdown preview modal for one openspec/ document (truncation offers a follow-up read). */
  function DocModal({ t, doc, onClose, onAlign, onReadMore }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [moreBusy, setMoreBusy] = useState(false)
    const [moreError, setMoreError] = useState(null)
    const [fullscreen, setFullscreen] = useState(false)
    const align = async () => {
      if (typeof onAlign !== 'function' || busy) return
      setBusy(true)
      setError(null)
      try {
        const outcome = await onAlign()
        if (outcome !== undefined && outcome !== null && outcome.ok === false) {
          setError(outcome.text ?? t('commandFailed'))
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
      setBusy(false)
    }
    const readMore = async () => {
      if (typeof onReadMore !== 'function' || moreBusy) return
      setMoreBusy(true)
      setMoreError(null)
      try {
        const outcome = await onReadMore()
        if (outcome !== undefined && outcome !== null && outcome.ok === false) setMoreError(outcome.error ?? t('docReadMoreFailed'))
      } catch (failure) {
        setMoreError(failure instanceof Error ? failure.message : String(failure))
      }
      setMoreBusy(false)
    }
    const shownLines = documentShownLines(doc.text ?? '')
    return h(
      Modal,
      {
        t,
        title: doc.title,
        description: doc.relPath ?? doc.path,
        onClose,
        width: fullscreen ? 'calc(100vw - 24px)' : 'min(1200px, calc(100vw - 48px))',
        focusCard: true,
        headActions: h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          [
            typeof onAlign === 'function'
              ? h(
                  Button,
                  { key: 'align', variant: 'outline', size: 'sm', icon: 'arrowUpRight', disabled: busy, onClick: () => void align() },
                  busy ? t('alignBusy') : t('alignDoc'),
                )
              : null,
            h(
              Button,
              {
                key: 'fullscreen',
                variant: 'ghost',
                size: 'sm',
                icon: fullscreen ? 'close' : 'layout',
                'aria-pressed': fullscreen ? 'true' : 'false',
                onClick: () => setFullscreen((value) => !value),
              },
              fullscreen ? t('docExitFullscreen') : t('docFullscreen'),
            ),
          ],
        ),
      },
      error === null ? null : h(Banner, { tone: 'error', wrap: true }, error),
      h(
        'div',
        { className: 'dshspec-docViewport', style: { maxHeight: fullscreen ? 'calc(100vh - 150px)' : 'min(78vh, 1040px)' } },
        doc.status === 'loading'
          ? h(LoadingBody)
          : doc.status === 'error'
            ? h(Banner, { tone: 'error', wrap: true }, `${t('readDocFailed')}：${doc.error ?? ''}`)
            : doc.text.trim() === ''
              ? h('div', { className: 'dshspec-sectionEmpty' }, t('docEmpty'))
              : h(Markdown, { text: doc.text }),
        doc.status === 'ready' && doc.truncated === true
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 2px 2px' } },
              h(Banner, { tone: 'warn', wrap: true }, documentTruncationText(t, { shown: shownLines, totalLines: doc.totalLines })),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(
                  Button,
                  { variant: 'outline', size: 'sm', icon: 'refresh', disabled: moreBusy, onClick: () => void readMore() },
                  moreBusy ? t('loading') : tx(t, 'docShowMore', { count: DOC_PAGE_LINES }),
                ),
                moreError === null ? null : h('span', { className: 'dshspec-errorText' }, moreError),
              ),
            )
          : null,
      ),
      doc.focusLine === undefined || doc.focusLine === null
        ? null
        : h('div', { className: 'dshspec-foot' }, h(Icon, { name: 'arrowUpRight', size: 12 }), h('span', null, tx(t, 'docAtLine', { line: doc.focusLine }))),
    )
  }

  /* ------------------------------------------------------------------ *
   * Native overview, artifact chips, metadata and issue lists.
   * ------------------------------------------------------------------ */

  /** Native artifact statuses in display order. */
  const ARTIFACT_STATUS_ORDER = ['done', 'skipped', 'ready', 'blocked']

  function Stat({ label, value }) {
    return h('div', { className: 'dshspec-stat' }, h('span', { className: 'dshspec-statValue' }, String(value)), h('span', { className: 'dshspec-statLabel' }, label))
  }

  /** One stage meter ring (artifact or task progress; never the legacy phase split). */
  function ProgressRing({ percent, label, title, size = 72, empty = false }) {
    const stroke = size <= 64 ? 6 : 7
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    const ratio = empty
      ? 0
      : Math.max(0, Math.min(1, (typeof percent === 'number' && Number.isFinite(percent) ? percent : 0) / 100))
    const color = ratio >= 1 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-business-primary)'
    return h(
      'div',
      { className: 'dshspec-ringMeter', 'data-meter': label },
      h(
        'div',
        {
          className: 'dshspec-ringWrap' + (empty ? ' dshspec-ringEmpty' : ''),
          title: title ?? label,
          style: { width: size, height: size },
          'data-empty': empty ? 'true' : undefined,
          'data-percent': empty ? undefined : String(Math.round(ratio * 100)),
        },
        h(
          'svg',
          { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: 'var(--dsw-alias-interactive-bg-hover)',
            strokeWidth: stroke,
          }),
          ratio > 0
            ? h('circle', {
                cx: size / 2,
                cy: size / 2,
                r: radius,
                fill: 'none',
                stroke: color,
                strokeWidth: stroke,
                strokeLinecap: 'round',
                strokeDasharray: `${circumference * ratio} ${circumference}`,
                transform: `rotate(-90 ${size / 2} ${size / 2})`,
                style: { transition: 'stroke-dasharray .3s ease' },
              })
            : null,
        ),
        h(
          'div',
          { className: 'dshspec-ringText' },
          h('span', { className: 'dshspec-ringValue' }, empty ? '—' : `${Math.round(ratio * 100)}%`),
        ),
      ),
      h('span', { className: 'dshspec-ringCaption', title: title ?? label }, label),
    )
  }

  /** Workspace overview: two independent stage rings (artifacts / tasks), validation counts and skills. */
  function SummaryBar({ t, state }) {
    const changes = Array.isArray(state.changes) ? state.changes : []
    const meters = workspaceProgress(changes)
    const totals = { done: 0, skipped: 0, ready: 0, blocked: 0 }
    let errors = 0
    let warnings = 0
    for (const change of changes) {
      const artifacts = Array.isArray(change.artifacts) ? change.artifacts : []
      const counts = artifactStatusCounts(artifacts)
      for (const status of ARTIFACT_STATUS_ORDER) totals[status] += counts[status]
      const validation = change.validation ?? {}
      errors += Number.isFinite(validation.errors) ? validation.errors : 0
      warnings += Number.isFinite(validation.warnings) ? validation.warnings : 0
    }
    const archiveCount = typeof state.archivedCount === 'number' ? state.archivedCount : state.archived.length
    const nativeSkills = state.skills !== null && state.skills !== undefined && Array.isArray(state.skills.native) ? state.skills.native : []
    // Two rings, two meters: a fully planned workspace still shows the open task
    // meter instead of collapsing both stages into one misleading 100%.
    const artifactTitle = tx(t, 'tasksDone', { done: meters.artifacts.done, total: meters.artifacts.total })
    const taskTitle = meters.tasks.empty ? t('noTasks') : tx(t, 'tasksDone', { done: meters.tasks.done, total: meters.tasks.total })
    return h(
      'div',
      { className: 'dshspec-summary', 'data-dshspec-summary': 'ready' },
      h(
        'div',
        { className: 'dshspec-meters' },
        h(ProgressRing, {
          percent: meters.artifacts.percent,
          label: t('artifactProgress'),
          title: artifactTitle,
          size: 64,
        }),
        h(ProgressRing, {
          percent: meters.tasks.percent,
          label: t('progressLabel'),
          title: taskTitle,
          size: 64,
          empty: meters.tasks.empty,
        }),
      ),
      h(
        'div',
        { className: 'dshspec-summaryPhase' },
        h(
          'div',
          { className: 'dshspec-phaseHead' },
          h('span', { className: 'dshspec-summaryLabel' }, t('artifactStatus')),
          h(
            'div',
            { className: 'dshspec-phaseHeadMeta' },
            nativeSkills.length > 0
              ? h(
                  ToneBadge,
                  { tone: 'business', title: tx(t, 'nativeSkillsTitle', { names: nativeSkills.map((skill) => skill.name ?? skill.workflow ?? '').join(', ') }) },
                  `${t('nativeSkills')} ${nativeSkills.length}`,
                )
              : null,
            state.skills !== null && state.skills !== undefined && state.skills.fallbackActive === true
              ? h(ToneBadge, { tone: 'muted', title: t('fallbackSkillsTitle') }, t('fallbackSkills'))
              : null,
          ),
        ),
        changes.length === 0
          ? h('div', { className: 'dshspec-note' }, t('noChanges'))
          : h(
              'div',
              { className: 'dshspec-phaseBar' },
              ARTIFACT_STATUS_ORDER.map((status) =>
                totals[status] > 0
                  ? h('span', {
                      key: status,
                      className: 'dshspec-phaseSeg',
                      style: { flexGrow: totals[status], background: toneColor(artifactStatusTone(status)) },
                      title: `${artifactStatusText(t, status)} ${totals[status]}`,
                    })
                  : null,
              ),
            ),
        h(
          'div',
          { className: 'dshspec-phaseLegend' },
          ARTIFACT_STATUS_ORDER.map((status) =>
            h(
              'span',
              { key: status, className: 'dshspec-legendItem' },
              h('span', { className: 'dshspec-badgeDot', style: { background: toneColor(artifactStatusTone(status)) } }),
              artifactStatusText(t, status),
              h('b', null, String(totals[status])),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dshspec-summaryStats' },
        h(Stat, { label: t('statActive'), value: changes.length }),
        h(Stat, { label: t('taskList'), value: meters.tasks.total === 0 ? '—' : `${meters.tasks.done}/${meters.tasks.total}` }),
        h(Stat, { label: t('statSpecs'), value: state.specs.length }),
        h(Stat, { label: t('statArchived'), value: archiveCount }),
        h(Stat, { label: t('validationLabel'), value: errors + warnings }),
      ),
    )
  }

  /** Document buttons for a change / capability / archive detail. */
  function DocGrid({ t, docs, openDoc, emptyText }) {
    const list = Array.isArray(docs) ? docs : []
    if (list.length === 0) return h('div', { className: 'dshspec-note' }, emptyText ?? t('noDocs'))
    return h(
      'div',
      { className: 'dshspec-docGrid' },
      list.map((doc) => {
        const path = typeof doc.path === 'string' ? doc.path : ''
        const basename = basenameOf(path) || String(doc.label ?? '')
        const label = doc.kind === 'delta' && typeof doc.label === 'string' && doc.label !== '' ? doc.label : basename
        return h(
          'button',
          {
            key: path === '' ? label : path,
            type: 'button',
            className: 'dshspec-docBtn',
            title: path,
            onClick: () => openDoc(doc),
          },
          h(Icon, { name: 'file', size: 14 }),
          h('span', null, label),
          doc.artifactId !== undefined && doc.artifactId !== null
            ? h('span', { className: 'dshspec-inlineTag' }, tx(t, 'artifactSource', { id: artifactLabel(doc.artifactId) }))
            : null,
          doc.kind === 'delta' ? h('span', { className: 'dshspec-docKind' }, 'delta') : null,
        )
      }),
    )
  }

  /** One label/value row (`.openspec.yaml` metadata, config facts). */
  function KvRow({ label, value }) {
    return h(
      'div',
      { className: 'dshspec-kv' },
      h('span', { className: 'dshspec-kvLabel' }, label),
      h('span', { className: 'dshspec-kvValue' }, value === undefined || value === null ? '—' : String(value)),
    )
  }

  /** `.openspec.yaml` metadata rows from the Host `ChangeState.metadata`. */
  function MetadataRows({ t, metadata }) {
    const value = metadata !== null && metadata !== undefined ? metadata : {}
    if (value.found !== true) return h('div', { className: 'dshspec-note' }, t('metaMissing'))
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h(KvRow, { label: t('metaSchema'), value: value.schema ?? t('metaNone') }),
      h(KvRow, { label: t('metaCreated'), value: value.created ?? t('metaNone') }),
      value.goal !== undefined && value.goal !== null && value.goal !== '' ? h(KvRow, { label: t('metaGoal'), value: value.goal }) : null,
      value.skip_specs === true ? h(KvRow, { label: t('metaSkip'), value: t('artifactSkipped') }) : null,
      value.retire_capabilities === true ? h(KvRow, { label: t('metaRetire'), value: t('artifactDone') }) : null,
    )
  }

  /**
   * Collapsible task checklist for one change, collapsed by default.
   *
   * Rows come from the Host `ChangeState.tasks.items` payload (bounded to 200
   * rows per change). When the Host sent no detail rows (older Host) or the cap
   * trimmed them, the block says so and offers the raw tracked document instead
   * of silently dropping rows.
   */
  function TaskChecklist({ t, tasks, docPath, openDoc, changeName, onToggleTask, busyLine, disabled }) {
    const [open, setOpen] = useState(false)
    const view = taskChecklistView(tasks)
    if (view.total === 0) return h('div', { className: 'dshspec-note' }, t('noTasks'))
    const toggle = () => setOpen((value) => !value)
    const hint = view.missing ? t('taskItemsMissing') : view.limited ? tx(t, 'taskItemsHidden', { count: view.hidden }) : ''
    const canOpenDoc = typeof openDoc === 'function' && typeof docPath === 'string' && docPath !== ''
    const canToggle = typeof onToggleTask === 'function' && typeof changeName === 'string' && changeName !== ''
    const manualCount = view.items.filter((item) => item.manual && !item.done).length
    const openTasksDoc = () => {
      if (!canOpenDoc) return
      openDoc({ path: docPath, label: basenameOf(docPath) || t('taskList') })
    }
    /** `[人工验收]` is metadata, not part of the sentence the user reads. */
    const taskLabel = (text) => String(text ?? '').replace(/(?:\[|【)\s*人工验收\s*(?:\]|】)/g, '').trim()
    return h(
      'div',
      { className: 'dshspec-taskBlock', 'data-dshspec-tasks': view.missing ? 'missing' : view.limited ? 'limited' : 'ready' },
      h(
        'button',
        {
          type: 'button',
          className: 'dshspec-taskToggle',
          'aria-expanded': open,
          'data-dshspec-tasks-toggle': open ? 'open' : 'closed',
          title: hint === '' ? undefined : hint,
          onClick: toggle,
        },
        h(Icon, { name: 'chevronRight', size: 12, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
        h('b', null, t('taskList')),
        h('span', { className: 'dshspec-taskToggleMeta' }, tx(t, 'tasksDone', { done: view.done, total: view.total })),
        manualCount > 0 ? h('span', { className: 'dshspec-manualTag', title: t('manualTaskHint') }, `${t('manualTask')} ${manualCount}`) : null,
        hint === '' ? null : h('span', { className: 'dshspec-taskToggleHint' }, hint),
      ),
      open
        ? h(
            'ul',
            { className: 'dshspec-taskList', 'data-dshspec-task-list': 'open' },
            view.items.map((item, index) => {
              const line = item.line
              const togglable = canToggle && line !== null
              const busy = busyLine !== undefined && busyLine !== null && line === busyLine
              return h(
                'li',
                {
                  key: `${item.id ?? 'task'}-${line ?? index}-${index}`,
                  className: 'dshspec-task' + (item.done ? ' dshspec-taskDone' : ''),
                  style: item.depth > 0 ? { paddingLeft: item.depth * 14 } : undefined,
                },
                togglable
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshspec-taskCheck',
                        'data-done': item.done ? 'true' : 'false',
                        title: item.manual ? t('manualTaskHint') : t('taskList'),
                        disabled: busy || disabled === true,
                        onClick: () => onToggleTask(changeName, line, !item.done),
                      },
                      h(Icon, {
                        name: busy ? 'refresh' : item.done ? 'checkSquare' : 'square',
                        size: 14,
                        className: busy ? 'dshspec-inlineSpinner' : undefined,
                      }),
                    )
                  : h(Icon, { name: item.done ? 'checkSquare' : 'square', size: 14 }),
                h('span', { className: 'dshspec-taskText' }, taskLabel(item.text) || item.text),
                item.manual
                  ? h(
                      'span',
                      { className: 'dshspec-taskTags' },
                      h('span', { className: 'dshspec-manualTag', title: t('manualTaskHint') }, t('manualTask')),
                    )
                  : null,
              )
            }),
          )
        : null,
      open && canOpenDoc
        ? h(
            'button',
            { type: 'button', className: 'dshspec-taskMore', onClick: openTasksDoc },
            h(Icon, { name: 'file', size: 12 }),
            t('openTasksDoc'),
          )
        : null,
    )
  }

  /** Workspace-relative document path of a change's tracked task list, when present. */
  function tasksDocOf(change) {
    const docs = Array.isArray(change?.docs) ? change.docs : []
    const tracks = typeof change?.tracks === 'string' && change.tracks !== '' ? change.tracks : 'tasks.md'
    const match = docs.find((doc) => typeof doc?.path === 'string' && (doc.path === tracks || doc.path.endsWith(`/${tracks}`)))
    return match === undefined ? undefined : match.path
  }

  /** One classified group (manual / other) of the aggregate pending-task list. */
  function PendingGroup({ t, title, items, onOpenTask, onToggleTask, taskBusy, isBusy }) {
    const [limit, reveal] = useVisibleLimit(PENDING_PAGE_SIZE)
    if (!Array.isArray(items) || items.length === 0) return null
    const page = paginate(items, { pageSize: limit })
    return h(
      'div',
      { className: 'dshspec-pendingGroup' },
      h(
        'div',
        { className: 'dshspec-pendingGroupHead' },
        h('span', null, title),
        h('span', { className: 'dshspec-sectionCount' }, String(items.length)),
      ),
      page.items.map((item, index) => {
        const line = item.line
        const busyLine = taskBusy !== null && taskBusy !== undefined && taskBusy.change === item.change && taskBusy.line === line
        const busy = busyLine || (typeof isBusy === 'function' && isBusy(item.change) === true)
        const canToggle = line !== null && typeof onToggleTask === 'function'
        return h(
          'div',
          { className: 'dshspec-pendingRow', key: `${item.change}:${line ?? 'x'}:${item.id ?? index}` },
          canToggle
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshspec-taskCheck',
                  'data-done': 'false',
                  title: item.manual ? t('manualTaskHint') : t('taskList'),
                  disabled: busy,
                  onClick: () => onToggleTask(item.change, line, true),
                },
                h(Icon, { name: busy ? 'refresh' : 'square', size: 14, className: busy ? 'dshspec-inlineSpinner' : undefined }),
              )
            : h(Icon, { name: 'clock', size: 14 }),
          h(
            'button',
            { type: 'button', className: 'dshspec-pendingChange', title: `${item.change} · ${t('pendingOpenTask')}`, onClick: () => onOpenTask(item) },
            item.change,
          ),
          h(
            'button',
            { type: 'button', className: 'dshspec-pendingText', title: `${item.text} · ${t('pendingOpenTask')}`, onClick: () => onOpenTask(item) },
            item.text,
          ),
          item.manual ? h('span', { className: 'dshspec-manualTag', title: t('manualTaskHint') }, t('manualTask')) : null,
        )
      }),
      h(ListMore, { t, hidden: page.hidden, reveal: Math.min(page.pageSize, page.hidden), onMore: reveal }),
    )
  }

  /** Aggregate "waiting for acceptance" list across every active change. */
  function PendingAcceptanceSection({ t, pending, limited, onOpenTask, onToggleTask, taskBusy, isBusy }) {
    return h(
      Section,
      {
        title: t('pendingAcceptance'),
        count: pending.total,
        // Open automatically only when there is human acceptance waiting;
        // otherwise keep the panel compact and let the user expand the count.
        defaultOpen: pending.manual.length > 0,
        headMeta:
          pending.total === 0
            ? null
            : h('span', { className: 'dshspec-note' }, tx(t, 'pendingBreakdown', { manual: pending.manual.length, automatic: pending.automatic.length })),
      },
      pending.total === 0
        ? h('div', { className: 'dshspec-note', style: { padding: '10px 14px' } }, t('pendingEmpty'))
        : h(
            'div',
            { className: 'dshspec-pendingList' },
            h(PendingGroup, {
              t,
              title: t('pendingManual'),
              items: pending.manual,
              onOpenTask,
              onToggleTask,
              taskBusy,
              isBusy,
            }),
            h(PendingGroup, {
              t,
              title: t('pendingAutomatic'),
              items: pending.automatic,
              onOpenTask,
              onToggleTask,
              taskBusy,
              isBusy,
            }),
            limited === true ? h('div', { className: 'dshspec-note', style: { padding: '8px 14px 10px' } }, t('pendingLimited')) : null,
          ),
    )
  }

  /** Validation issues with level, path and line; clicking opens the document. */
  function IssueList({ t, issues, onIssue }) {
    const list = Array.isArray(issues) ? issues : []
    const [limit, reveal] = useVisibleLimit(ISSUE_PAGE_SIZE)
    if (list.length === 0) return h('div', { className: 'dshspec-note' }, t('noIssues'))
    const page = paginate(list, { pageSize: limit })
    return h(
      'div',
      { className: 'dshspec-issueList' },
      page.items.map((issue, index) => {
        const level = typeof issue?.level === 'string' ? issue.level : 'INFO'
        const location = validationIssueLocation(issue)
        return h(
          'div',
          {
            key: `${location}#${index}`,
            className: 'dshspec-issue',
            'data-tone': issueLevelTone(level),
            role: 'button',
            tabIndex: 0,
            title: location === '' ? t('viewDoc') : `${t('viewDoc')} · ${location}`,
            onClick: () => onIssue(issue),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onIssue(issue)
              }
            },
          },
          h('span', { className: 'dshspec-issueLevel' }, level),
          location === '' ? null : h('span', { className: 'dshspec-issuePath' }, location),
          h('span', { className: 'dshspec-issueMsg' }, issue?.message ?? ''),
        )
      }),
      h(ListMore, { t, hidden: page.hidden, reveal: Math.min(page.pageSize, page.hidden), onMore: reveal }),
    )
  }

  /** Tone of a change's overall native state (progress colors / status dot). */
  function changeTone(change) {
    if (change === null || change === undefined) return 'muted'
    const validation = change.validation ?? {}
    if (Number.isFinite(validation.errors) && validation.errors > 0) return 'error'
    if (blockedArtifacts(change.artifacts).length > 0) return 'warn'
    if (change.isPlanningComplete !== true) return 'business'
    if (change.listStatus === 'complete') return 'success'
    return 'warn'
  }

  /** Icon for the derived native next action. */
  function nextActionIcon(kind) {
    if (kind === 'propose') return 'filePlus'
    if (kind === 'update') return 'activity'
    if (kind === 'archive') return 'archive'
    return 'play'
  }

  /** One-line Purpose summary for the capability list; the full text stays in the title attribute. */
  function purposeSummary(spec) {
    const raw = String(spec?.purpose ?? '').replace(/\s+/g, ' ').trim()
    if (raw === '') return ''
    return raw.length > 140 ? `${raw.slice(0, 139)}…` : raw
  }

  /** Per-artifact native status chips; a blocked chip expands its `missingDeps`. */
  function ArtifactChips({ t, change }) {
    const artifacts = sortArtifacts(change.artifacts)
    const [depsFor, setDepsFor] = useState(null)
    if (artifacts.length === 0) return h('div', { className: 'dshspec-note' }, t('docsFromSchema'))
    const selected = artifacts.find((artifact) => String(artifact.id) === depsFor)
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
      h(
        'div',
        { className: 'dshspec-chipRow' },
        artifacts.map((artifact) => {
          const status = typeof artifact.status === 'string' ? artifact.status : 'blocked'
          const blocked = status === 'blocked'
          const deps = Array.isArray(artifact.missingDeps) ? artifact.missingDeps : []
          const depsText = deps.length === 0 ? '—' : deps.map((dep) => artifactLabel(dep)).join('、')
          const common = {
            key: artifact.id,
            className: 'dshspec-artChip',
            'data-status': status,
            title: blocked
              ? tx(t, 'missingDeps', { deps: depsText })
              : `${artifactLabel(artifact.id)} · ${artifactStatusText(t, status)}`,
          }
          const content = [
            h('span', { key: 'dot', className: 'dshspec-artChipDot', style: { background: toneColor(artifactStatusTone(status)) } }),
            h('span', { key: 'label' }, artifactLabel(artifact.id)),
            h('span', { key: 'state', className: 'dshspec-artChipState' }, artifactStatusText(t, status)),
          ]
          return blocked
            ? h(
                'button',
                {
                  ...common,
                  type: 'button',
                  'aria-expanded': depsFor === artifact.id,
                  onClick: () => setDepsFor((current) => (current === artifact.id ? null : artifact.id)),
                },
                content,
              )
            : h('span', common, content)
        }),
      ),
      selected === undefined
        ? null
        : h(
            'div',
            { className: 'dshspec-depsRow' },
            h('b', null, `${artifactLabel(selected.id)} · ${t('artifactBlocked')}`),
            h(
              'span',
              null,
              tx(t, 'missingDeps', {
                deps: (Array.isArray(selected.missingDeps) ? selected.missingDeps : []).map((dep) => artifactLabel(dep)).join('、') || '—',
              }),
            ),
          ),
    )
  }

  /** One-line "information scent" summary on a collapsed change card. */
  function ChangeSummaryLine({ t, change, onToggle }) {
    const info = changeSummaryInfo(change.summary)
    const text = info.text === '' ? t('summaryPending') : info.text
    const truncated = info.truncated && info.source !== 'none'
    const title = info.text === '' ? t('summaryPending') : truncated ? `${info.text}…` : info.text
    return h(
      'div',
      {
        className: 'dshspec-itemSummary',
        'data-dshspec-summary-line': 'change',
        'data-source': info.source,
        title,
        onClick: onToggle,
      },
      h('span', { className: 'dshspec-itemSummaryText' }, truncated ? `${text}…` : text),
      truncated ? h('span', { className: 'dshspec-itemSummaryMore' }, t('summaryMore')) : null,
    )
  }

  /**
   * L1 overview for one change: why / what changes / impact+status, plus the
   * validate + sync-preview secondary actions. Nothing opens a document unless
   * the user asks for the full text.
   */
  function ChangeOverview({ t, change, openDoc, onValidate, onSyncPreview }) {
    const summary = change.summary ?? {}
    const [changesOpen, setChangesOpen] = useState(false)
    const why = typeof summary.why === 'string' ? summary.why : ''
    const digest = changeDigestTotals(summary)
    const changes = Array.isArray(summary.changes) ? summary.changes : []
    const proposalDoc = change.docs.find((doc) => doc.kind !== 'delta' && String(doc.artifactId ?? '') === 'proposal')
    const canOpenProposal = proposalDoc !== undefined && typeof openDoc === 'function'
    const openProposal = () => {
      if (canOpenProposal) openDoc(proposalDoc)
    }
    const collapsed = digest.shown > 1 && changesOpen === false
    return h(
      'div',
      { className: 'dshspec-overview', 'data-dshspec-overview': 'ready' },
      h(
        'div',
        { className: 'dshspec-ovRow' },
        h('span', { className: 'dshspec-ovLabel' }, t('overviewWhy')),
        h(
          'div',
          { className: 'dshspec-ovValue' },
          why === ''
            ? h('span', { className: 'dshspec-note' }, t('summaryPending'))
            : h('div', { className: 'dshspec-ovClamp', title: why }, why),
          why !== '' && summary.whyTruncated === true && canOpenProposal
            ? h(
                'button',
                { type: 'button', className: 'dshspec-taskMore', onClick: openProposal },
                h(Icon, { name: 'file', size: 12 }),
                t('summaryMore'),
              )
            : null,
        ),
      ),
      h(
        'div',
        { className: 'dshspec-ovRow' },
        h('span', { className: 'dshspec-ovLabel' }, t('overviewChanges')),
        h(
          'div',
          { className: 'dshspec-ovValue' },
          changes.length === 0
            ? h('span', { className: 'dshspec-note' }, t('summaryPending'))
            : changesOpen
              ? h(
                  'ul',
                  { className: 'dshspec-ovList' },
                  changes.map((item, index) => h('li', { key: index }, item)),
                )
              : h('div', { className: 'dshspec-ovClamp' }, changes[0]),
          digest.total === 0
            ? null
            : h(
                'div',
                { className: 'dshspec-ovActions' },
                digest.shown > 1
                  ? h(
                      'button',
                      { type: 'button', className: 'dshspec-taskMore', onClick: () => setChangesOpen((value) => !value) },
                      h(Icon, { name: collapsed ? 'chevronDown' : 'chevronRight', size: 12 }),
                      collapsed ? tx(t, 'summaryAllChanges', { count: digest.shown }) : t('collapse'),
                    )
                  : null,
                digest.total > digest.shown
                  ? h('span', { className: 'dshspec-note' }, tx(t, 'summaryChangesTotal', { count: digest.total }))
                  : null,
                canOpenProposal && digest.shown > 1
                  ? h(
                      'button',
                      { type: 'button', className: 'dshspec-taskMore', onClick: openProposal },
                      h(Icon, { name: 'file', size: 12 }),
                      t('summaryMore'),
                    )
                  : null,
              ),
        ),
      ),
      h(
        'div',
        { className: 'dshspec-ovRow' },
        h('span', { className: 'dshspec-ovLabel' }, t('overviewImpact')),
        h('span', { className: 'dshspec-ovValue' }, changeOverviewFacts(t, change)),
      ),
      h(
        'div',
        { className: 'dshspec-ovActions' },
        h(Button, { variant: 'outline', size: 'sm', icon: 'check', onClick: () => onValidate(change) }, t('validateAction')),
        h(Button, { variant: 'outline', size: 'sm', icon: 'refresh', onClick: () => onSyncPreview(change) }, t('syncPreviewAction')),
      ),
    )
  }

  /** One document row inside a group body. */
  function DocRow({ label, meta, end, title, onClick }) {
    return h(
      'button',
      { type: 'button', className: 'dshspec-docRow', title: title ?? meta, onClick },
      h(Icon, { name: 'file', size: 13, className: 'dshspec-docRowIcon' }),
      h('span', { className: 'dshspec-docRowName' }, label),
      meta === '' ? null : h('span', { className: 'dshspec-docRowMeta' }, meta),
      end === '' ? null : h('span', { className: 'dshspec-docRowEnd' }, end),
    )
  }

  /** L2 document groups: artifact order, delta rows once, metadata last; collapsed by default. */
  function DocumentGroups({ t, change, openDoc, openGroups, onToggleGroup, onToggleTask, taskBusyLine, disabled }) {
    const groups = groupChangeDocuments(change)
    if (groups.length === 0) return null
    const tasksDocPath = tasksDocOf(change)
    const deltaDocFor = (file) => {
      const path = String(file.path).replace(/\\/g, '/')
      const match = change.docs.find(
        (doc) => doc.kind === 'delta' && (String(doc.path).replace(/\\/g, '/') === path || String(doc.path).replace(/\\/g, '/').endsWith(`/${path}`)),
      )
      return match ?? { path: file.path, label: file.label }
    }
    return h(
      'div',
      { className: 'dshspec-docGroups', 'data-dshspec-doc-groups': 'ready' },
      groups.map((group) => {
        const isOpen = openGroups[group.id] === true
        const title =
          group.kind === 'metadata'
            ? t('metadataGroup')
            : group.id === 'specs'
              ? t('specChangesGroup')
              : group.id === 'proposal'
                ? t('artifactProposal')
                : group.id === 'design'
                  ? t('artifactDesign')
                  : group.id === 'tasks'
                    ? t('artifactTasks')
                    : artifactLabel(group.id)
        const count = group.kind === 'metadata' ? 0 : group.kind === 'delta' ? group.deltas.length : group.docs.length
        const countText = count === 0 ? '' : tx(t, group.kind === 'delta' ? 'docGroupFiles' : 'docGroupCount', { count })
        const meta =
          group.kind === 'metadata'
            ? t('metadataLabel')
            : group.kind === 'delta'
              ? deltaFileOpsText(t, change.delta)
              : ''
        const status = typeof group.status === 'string' && group.status !== '' ? group.status : null
        const bodyChildren = []
        if (group.kind === 'metadata') {
          bodyChildren.push(
            h('div', { key: 'schema', className: 'dshspec-note' }, `${t('effectiveSchema')} · ${change.schemaName || '—'}`),
            h(MetadataRows, { key: 'rows', t, metadata: change.metadata }),
          )
        }
        for (const [index, file] of (group.kind === 'delta' ? group.deltas : group.docs).entries()) {
          const isDelta = group.kind === 'delta'
          const doc = isDelta ? deltaDocFor(file) : file
          bodyChildren.push(
            h(DocRow, {
              key: `${isDelta ? file.path : file.path}-${index}`,
              label: isDelta ? file.label || basenameOf(file.path) : basenameOf(file.path),
              meta: isDelta ? basenameOf(file.path) : '',
              end: isDelta ? deltaFileOpsText(t, file) : '',
              title: doc.path,
              onClick: () => openDoc(doc),
            }),
          )
        }
        if (group.id === 'tasks')
          bodyChildren.push(
            h(TaskChecklist, {
              key: 'tasks',
              t,
              tasks: change.tasks,
              docPath: tasksDocPath,
              openDoc,
              changeName: change.name,
              onToggleTask,
              busyLine: taskBusyLine,
              disabled,
            }),
          )
        return h(
          'div',
          { key: group.id, className: 'dshspec-docGroup', 'data-dshspec-doc-group': group.id },
          h(
            'button',
            {
              type: 'button',
              className: 'dshspec-docGroupHead',
              'aria-expanded': isOpen,
              onClick: () => onToggleGroup(group.id),
            },
            h(Icon, { name: 'chevronRight', size: 12, className: 'dshspec-chev' + (isOpen ? ' dshspec-chevOpen' : '') }),
            status === null
              ? null
              : h('span', {
                  className: 'dshspec-artChipDot',
                  style: { background: toneColor(artifactStatusTone(status)) },
                  title: artifactStatusText(t, status),
                }),
            h('span', { className: 'dshspec-docGroupTitle', title: group.description || title }, title),
            meta === '' ? null : h('span', { className: 'dshspec-docGroupMeta' }, meta),
            h('span', { className: 'dshspec-docGroupEnd' }, countText),
          ),
          isOpen ? h('div', { className: 'dshspec-docGroupBody' }, bodyChildren) : null,
        )
      }),
    )
  }

  /**
   * One collapsible change card: native artifact chips stay visible; the body is
   * progressive — an overview first, then collapsed document groups.
   */
  function ChangeCard({
    t,
    change,
    open,
    onToggle,
    openDoc,
    onIssue,
    onValidate,
    onSyncPreview,
    runStatus,
    boundSession,
    onOpenSession,
    onRun,
    onPropose,
    onToggleTask,
    taskBusyLine,
  }) {
    const action = deriveNextAction(change)
    const progress = taskProgressInfo(change.tasks)
    const blocked = blockedArtifacts(change.artifacts)
    const validation = change.validation ?? {}
    const [openGroups, setOpenGroups] = useState({})
    const toggle = () => onToggle()
    const issueCount = (Number.isFinite(validation.errors) ? validation.errors : 0) + (Number.isFinite(validation.warnings) ? validation.warnings : 0)
    const toggleGroup = (id) => setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }))
    const status = runStatus ?? { kind: 'planning', label: t('statusPlanning'), tone: 'business', busy: false }
    const busy = status.busy === true
    const openBound = () => {
      if (typeof onOpenSession === 'function') onOpenSession(boundSession)
    }
    return h(
      'div',
      { className: 'dshspec-item', 'data-dshspec-change': change.name },
      h(
        'div',
        {
          className: 'dshspec-itemHead',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggle()
            }
          },
        },
        h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
        h('span', { className: 'dshspec-changeName', title: change.name }, change.name),
        h(
          'span',
          { className: 'dshspec-statusBadge', 'data-status': status.kind, title: busy ? (status.kind === 'waiting' ? t('statusWaitHint') : t('statusRunHint')) : status.label },
          h(Icon, { name: status.kind === 'running' ? 'refresh' : status.kind === 'waiting' ? 'alert' : status.kind === 'complete' ? 'check' : 'activity', size: 11 }),
          status.label,
        ),
        change.schemaName === ''
          ? null
          : h(ToneBadge, { tone: 'muted', title: tx(t, 'changeSchema', { name: change.schemaName }) }, change.schemaName),
        change.metadata.skip_specs === true ? h(ToneBadge, { tone: 'muted', title: t('skipSpecs') }, t('skipSpecs')) : null,
        blocked.length > 0
          ? h(ToneBadge, { tone: 'warn', title: t('changesBlockedHint') }, tx(t, 'blockedCount', { count: blocked.length }))
          : null,
        boundSession === null || boundSession === undefined
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dshspec-sessionChip',
                title: `${t('boundSession')} · ${boundSession.sessionId}`,
                onClick: (event) => {
                  event.stopPropagation()
                  openBound()
                },
              },
              h(Icon, { name: 'message', size: 11 }),
              tx(t, 'sessionShort', { id: boundSession.sessionId.slice(0, 8) }),
            ),
        progress.total > 0
          ? h(
              'div',
              { className: 'dshspec-changeProgress' },
              h(Progress, { done: progress.done, total: progress.total, color: toneColor(changeTone(change)) }),
            )
          : null,
        h('span', { className: 'dshspec-space' }),
        h(
          'div',
          { className: 'dshspec-changeButtons' },
          h(
            Button,
            {
              variant: 'primary',
              size: 'md',
              icon: busy ? 'refresh' : nextActionIcon(action.kind),
              title: busy ? (status.kind === 'waiting' ? t('statusWaitHint') : t('statusRunHint')) : change.nextSteps.length > 0 ? `${t('quickNext')} · ${change.nextSteps.join(' · ')}` : nextActionText(t, action),
              disabled: busy,
              'data-dshspec-run-status': status.kind,
              onClick: (event) => {
                event.stopPropagation()
                if (busy) return
                if (typeof onRun === 'function') {
                  onRun(action.line, change.name)
                  return
                }
                if (action.kind === 'propose' && typeof onPropose === 'function') onPropose()
              },
            },
            busy ? status.label : nextActionText(t, action),
          ),
        ),
      ),
      open ? null : h(ChangeSummaryLine, { t, change, onToggle: toggle }),
      h('div', { className: 'dshspec-itemChips' }, h(ArtifactChips, { t, change })),
      open
        ? h(
            'div',
            { className: 'dshspec-itemBody' },
            h(ChangeOverview, { t, change, openDoc, onValidate, onSyncPreview }),
            issueCount > 0
              ? h(
                  'div',
                  { className: 'dshspec-issueBlock' },
                  h(
                    'div',
                    { className: 'dshspec-subHead' },
                    h('b', null, t('issuesList')),
                    h('span', null, validationSummaryText(t, validation)),
                  ),
                  h(IssueList, { t, issues: validation.issues, onIssue }),
                )
              : null,
            h('div', { className: 'dshspec-subHead' }, h('b', null, t('docGroups'))),
            h(DocumentGroups, {
              t,
              change,
              openDoc,
              openGroups,
              onToggleGroup: toggleGroup,
              onToggleTask,
              taskBusyLine,
              disabled: busy,
            }),
          )
        : null,
    )
  }

  /** Capability specs with native counts, validation and nested-path grouping. */
  function CapabilitySection({ t, specs, openDoc, onIssues }) {
    const list = Array.isArray(specs) ? specs : []
    const [limit, reveal] = useVisibleLimit(SPEC_PAGE_SIZE)
    if (list.length === 0) {
      return h(SectionEmpty, { icon: 'layers', title: t('noCapabilities'), hint: t('noCapabilitiesHint') })
    }
    const rows = groupSpecsByPath(list)
    const page = paginate(rows, { pageSize: limit })
    const openSpec = (spec) => {
      if (spec === null || spec === undefined || typeof spec.path !== 'string' || spec.path === '') return
      openDoc({ path: spec.path, label: basenameOf(spec.path) || `${spec.name}/spec.md`, artifactId: 'specs' })
    }
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column' } },
      page.items.map((row, index) =>
        row.kind === 'group'
          ? h(
              'div',
              { key: `group-${row.fullName}`, className: 'dshspec-nestedGroup', style: { paddingLeft: 14 + row.depth * 18 } },
              h(Icon, { name: 'layers', size: 13 }),
              h('span', null, row.label),
            )
          : h(
              'div',
              {
                key: `spec-${row.fullName}-${index}`,
                className: 'dshspec-nested',
                style: { paddingLeft: 14 + row.depth * 18 },
                title: row.fullName,
                role: 'button',
                tabIndex: 0,
                onClick: () => openSpec(row.spec),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openSpec(row.spec)
                  }
                },
              },
              h(Icon, { name: 'file', size: 14 }),
              h(
                'span',
                { className: 'dshspec-treeText' },
                h('span', { className: 'dshspec-nestedName' }, row.label),
                h('span', { className: 'dshspec-nestedMeta', title: String(row.spec.purpose ?? '') }, purposeSummary(row.spec) || t('capabilityPurpose')),
              ),
              h(
                'span',
                { className: 'dshspec-nestedEnd' },
                h('span', { className: 'dshspec-legendItem' }, tx(t, 'requirementCount', { count: row.spec.requirementCount ?? 0 })),
                h('span', { className: 'dshspec-legendItem' }, tx(t, 'scenarioCount', { count: row.spec.scenarioCount ?? 0 })),
                totalIssues(row.spec.validation) > 0 && typeof onIssues === 'function'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshspec-taskMore',
                        title: validationSummaryText(t, row.spec.validation),
                        onClick: (event) => {
                          event.stopPropagation()
                          onIssues(row.spec)
                        },
                      },
                      h(Icon, { name: 'alert', size: 12 }),
                      tx(t, 'specIssues', { count: totalIssues(row.spec.validation) }),
                    )
                  : null,
                h(Icon, { name: 'chevronRight', size: 14 }),
              ),
            ),
      ),
      h(ListMore, { t, hidden: page.hidden, reveal: Math.min(page.pageSize, page.hidden), onMore: reveal }),
    )
  }

  /** Total error/warning count of one validation summary. */
  function totalIssues(validation) {
    const errors = Number.isFinite(validation?.errors) ? validation.errors : 0
    const warnings = Number.isFinite(validation?.warnings) ? validation.warnings : 0
    return errors + warnings
  }

  /** Archive rows grouped by local date; each change's artifacts/tasks/metadata load on demand. */
  function ArchiveSection({ t, source, archived, openDoc, cwd, compose, onNotice }) {
    const [open, setOpen] = useState(false)
    const [expanded, setExpanded] = useState({})
    const [details, setDetails] = useState({})
    const [limit, reveal] = useVisibleLimit(ARCHIVE_PAGE_SIZE)
    const [reportDialog, setReportDialog] = useState(null)
    const [reportPreview, setReportPreview] = useState(null)
    const groups = groupArchivedByLocalDate(archived)

    const visibleGroups = []
    let remaining = limit
    let hidden = 0
    for (const group of groups) {
      if (remaining <= 0) {
        hidden += group.entries.length
        continue
      }
      const entries = group.entries.slice(0, remaining)
      hidden += group.entries.length - entries.length
      remaining -= entries.length
      if (entries.length > 0) visibleGroups.push({ date: group.date, entries })
    }

    const keyOf = (entry) => String(entry?.path ?? entry?.name ?? '')
    const load = useCallback(
      (entry) => {
        const key = keyOf(entry)
        if (source === undefined) {
          setDetails((prev) => ({ ...prev, [key]: { status: 'error', error: t('archiveLoadFailed') } }))
          return
        }
        setDetails((prev) => (prev[key] === undefined ? { ...prev, [key]: { status: 'loading' } } : prev))
        void source
          .loadArchive(entry)
          .then((result) => {
            setDetails((prev) => ({
              ...prev,
              [key]:
                result !== null && result !== undefined && result.ok === true
                  ? { status: 'ready', change: result.change, fallback: result.fallback === true }
                  : { status: 'error', error: result?.error ?? t('archiveLoadFailed') },
            }))
          })
          .catch((error) => {
            setDetails((prev) => ({ ...prev, [key]: { status: 'error', error: error instanceof Error ? error.message : String(error) } }))
          })
      },
      [source, t],
    )

    const toggle = (entry) => {
      const key = keyOf(entry)
      const willOpen = expanded[key] !== true
      setExpanded((prev) => ({ ...prev, [key]: willOpen }))
      if (willOpen && details[key] === undefined) load(entry)
    }

    /**
     * Open the report dialog for one archived row. The event is stopped so the
     * row never expands/collapses (or toggles on keyboard Enter) as a side
     * effect of asking for a report.
     *
     * @param {object} entry - one `WorkspaceState.archived` row.
     * @returns {(event?: Event) => void} click/key handler.
     */
    const openReport = (entry) => (event) => {
      if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
      setReportDialog({ scope: 'change', entry })
    }

    /** Open the same dialog in the period scope from the section header. */
    const openPeriodReport = () => setReportDialog({ scope: 'range' })

    const renderDetail = (detail, entry) => {
      if (detail === undefined || detail.status === 'loading') {
        return h('div', { className: 'dshspec-inlineLoad' }, h(Icon, { name: 'refresh', size: 14, className: 'dshspec-spin' }), h('span', null, t('archiveDetailLoading')))
      }
      if (detail.status === 'error') return h(Banner, { tone: 'error', wrap: true }, detail.error ?? t('archiveLoadFailed'))
      const change = detail.change
      if (change === null || change === undefined) return h(Banner, { tone: 'error', wrap: true }, t('archiveLoadFailed'))
      const deltaText = deltaSummaryText(t, change.delta)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('archiveMetadata')), h('span', null, change.schemaName ?? '')),
        h(MetadataRows, { t, metadata: change.metadata }),
        typeof change.metadataText === 'string' && change.metadataText !== ''
          ? h('pre', { className: 'dshspec-pre dshspec-prePlain' }, change.metadataText)
          : null,
        detail.fallback === true ? h('div', { className: 'dshspec-note' }, t('archiveProbeNote')) : null,
        h(TaskChecklist, { t, tasks: change.tasks, docPath: tasksDocOf(change), openDoc }),
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('archiveArtifacts'))),
        h(DocGrid, { t, docs: change.docs, openDoc }),
        deltaText === '' ? null : h('div', { className: 'dshspec-subHead' }, h('b', null, t('deltaSection')), h('span', null, deltaText)),
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('issuesList')), h('span', null, validationSummaryText(t, change.validation))),
        totalIssues(change.validation) > 0
          ? h(IssueList, {
              t,
              issues: change.validation.issues,
              onIssue: (issue) => {
                if (typeof issue?.path !== 'string' || issue.path === '') return
                const base = typeof entry?.path === 'string' ? entry.path : ''
                const relative = issue.path.startsWith('openspec/') || issue.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(issue.path)
                const path = relative || base === '' ? issue.path : `${base}/${issue.path}`
                openDoc({ path, label: basenameOf(path) }, issue.line)
              },
            })
          : null,
      )
    }

    const sectionNode = h(
      Section,
      {
        title: t('archiveSectionTitle'),
        count: archived.length,
        headMeta: h('span', { className: 'dshspec-note' }, t('archivedHint')),
        action:
          archived.length === 0
            ? null
            : h(
                Button,
                { variant: 'outline', size: 'sm', icon: 'file', title: t('reportPeriodEntry'), onClick: openPeriodReport },
                t('reportPeriodEntry'),
              ),
        defaultOpen: false,
      },
      archived.length === 0
        ? h(SectionEmpty, { icon: 'archive', title: t('noArchived') })
        : visibleGroups.map((group) =>
            h(
              'div',
              { key: group.date ?? 'unknown', className: 'dshspec-archGroup' },
              h(
                'div',
                { className: 'dshspec-archHead' },
                h(Icon, { name: 'archive', size: 13 }),
                h('span', null, group.date === null ? t('archiveUnknownDate') : group.date),
                h('span', { className: 'dshspec-sectionCount' }, String(group.entries.length)),
              ),
              group.entries.map((entry) => {
                const key = keyOf(entry)
                const isOpen = expanded[key] === true
                const detail = details[key]
                const label = archiveEntryLabel(entry)
                return h(
                  'div',
                  { key, className: 'dshspec-item' },
                  h(
                    'div',
                    {
                      className: 'dshspec-itemHead',
                      role: 'button',
                      tabIndex: 0,
                      'aria-expanded': isOpen,
                      onClick: () => toggle(entry),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggle(entry)
                        }
                      },
                    },
                    h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (isOpen ? ' dshspec-chevOpen' : '') }),
                    h('span', { className: 'dshspec-changeName', title: entry.path ?? entry.name }, label),
                    detail !== undefined && detail.status === 'ready' && detail.change?.tasks !== null
                      ? h(
                          'div',
                          { className: 'dshspec-changeProgress' },
                          h(Progress, {
                            done: taskProgressInfo(detail.change.tasks).done,
                            total: taskProgressInfo(detail.change.tasks).total,
                            color: toneColor('success'),
                          }),
                        )
                      : null,
                    h('span', { className: 'dshspec-space' }),
                    h(IconButton, {
                      icon: 'file',
                      label: t('reportEntry'),
                      size: 26,
                      onClick: openReport(entry),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
                      },
                    }),
                    h(Icon, { name: 'archive', size: 14, className: 'dshspec-decoIcon' }),
                  ),
                  isOpen ? h('div', { className: 'dshspec-itemBody' }, renderDetail(detail, entry)) : null,
                )
              }),
            ),
          ),
      h(ListMore, { t, hidden, reveal: Math.min(limit, hidden), onMore: reveal }),
    )
    // The report entries live in the section header (visible while collapsed),
    // so the dialogs render as SIBLINGS of the collapsible section instead of
    // inside its body — otherwise a collapsed archive view would swallow them.
    return h(
      React.Fragment,
      null,
      sectionNode,
      reportDialog === null
        ? null
        : h(ReportDialog, {
            t,
            scope: reportDialog.scope,
            entry: reportDialog.entry,
            archived,
            cwd,
            source,
            compose,
            onNotice,
            onPreview: (report) => {
              // Preview replaces the form (never stacks two modal layers).
              setReportPreview({
                path: report.path ?? report.absolutePath,
                absolutePath: report.absolutePath,
                back: reportDialog,
              })
              setReportDialog(null)
            },
            onClose: () => setReportDialog(null),
          }),
      reportPreview === null
        ? null
        : h(ReportPreviewDialog, {
            t,
            source,
            path: reportPreview.path,
            absolutePath: reportPreview.absolutePath,
            onClose: () => {
              const back = reportPreview.back ?? null
              setReportPreview(null)
              if (back !== null) setReportDialog(back)
            },
          }),
    )
  }

  /**
   * Report dialog — one archived change or a date range.
   *
   * The dialog only composes the human-report prompt and fills the target
   * conversation draft: the Host calls (`report-prompt` / `report-status`) are
   * read-only and nothing is ever sent. The period hit list is computed locally
   * from `state.archived[].date`, so changing the range costs no Host call.
   * An existing report is discovered through `report-status` and can be
   * previewed inline (sandboxed iframe) or copied as a path.
   */
  function ReportDialog({ t, scope: initialScope, entry, archived, cwd, source, compose, onNotice, onPreview, onClose }) {
    const initialSettings = useRef(null)
    if (initialSettings.current === null) initialSettings.current = loadReportSettings(cwd)
    const [scope, setScope] = useState(initialScope === 'range' ? 'range' : 'change')
    const [root, setRoot] = useState(initialSettings.current.root)
    const [inArchive, setInArchive] = useState(initialSettings.current.mode === 'archive')
    const [range, setRange] = useState(() => reportDefaultRange())
    const [status, setStatus] = useState({ loading: true, value: null, error: '' })
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [preview, setPreview] = useState(null)
    const changeEntry = entry !== null && typeof entry === 'object' ? entry : null

    const rangeMode = scope === 'range'
    const included = rangeMode ? reportArchivedInRange(archived, range.from, range.to) : []
    const rangeMissing = rangeMode && (String(range.from).trim() === '' || String(range.to).trim() === '')
    const rangeInvalid = rangeMode && rangeMissing !== true && String(range.from) > String(range.to)
    const rangeEmpty = rangeMode && rangeMissing !== true && rangeInvalid !== true && included.length === 0
    const changeLabel = archiveEntryLabel(changeEntry ?? {})
    const changeDate = archiveEntryDate(changeEntry ?? {})
    const normalizedRoot = normalizeReportRoot(root)
    // Absolute report roots are accepted only inside the workspace (the Host
    // rejects outside paths because the DSH file policy cannot write or verify
    // them); warn as soon as the typed root would fall outside.
    const absoluteRoot = /^(?:[A-Za-z]:[\\/]|\/)/.test(normalizedRoot)
    const cwdKey = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const rootKey = normalizedRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const absoluteRootOutside = absoluteRoot && cwdKey !== '' && rootKey !== cwdKey && !rootKey.startsWith(`${cwdKey}/`)
    const archiveDir =
      changeEntry !== null && typeof changeEntry.name === 'string' && changeEntry.name !== '' ? changeEntry.name : changeLabel
    const outputPath = rangeMode
      ? reportOutputRelPath({ scope: 'range', root: normalizedRoot, from: range.from, to: range.to })
      : inArchive
        ? `openspec/changes/archive/${archiveDir}/report.html`
        : reportOutputRelPath({ scope: 'change', root: normalizedRoot, changeName: changeLabel })

    // Discover an existing report for the current target. `root` is not a
    // dependency on purpose: retyping the directory must not flood the Host
    // with status calls; the status is re-read when scope / range / target
    // changes (and after a successful generation, when the dialog closes).
    useEffect(() => {
      let cancelled = false
      const payload =
        scope === 'range'
          ? { scope: 'range', from: range.from, to: range.to, reportRoot: normalizeReportRoot(root) }
          : {
              scope: 'change',
              path: relPathOf(cwd, changeEntry?.path ?? ''),
              name: archiveEntryLabel(changeEntry ?? {}),
              // Archive mode ignores the report root; omit it so an old
              // out-of-workspace preference cannot fail the status read.
              ...(inArchive ? { inArchive: true } : { reportRoot: normalizeReportRoot(root), inArchive: false }),
            }
      // An incomplete / inverted / empty range can never have a report (the Host
      // rejects it too), so skip the status call and show "not generated".
      if (
        scope === 'range' &&
        (String(range.from).trim() === '' ||
          String(range.to).trim() === '' ||
          String(range.from) > String(range.to) ||
          reportArchivedInRange(archived, range.from, range.to).length === 0)
      ) {
        setStatus({ loading: false, value: null, error: '' })
        return () => {
          cancelled = true
        }
      }
      setStatus({ loading: true, value: null, error: '' })
      const timer = setTimeout(() => {
        if (source === undefined || typeof source.reportStatus !== 'function') {
          if (!cancelled) setStatus({ loading: false, value: null, error: t('reportStatusFailed') })
          return
        }
        void source
          .reportStatus(payload)
          .then((value) => {
            if (!cancelled) setStatus({ loading: false, value: normalizeReportStatus(value, scope), error: '' })
          })
          .catch((failure) => {
            if (!cancelled) {
              setStatus({ loading: false, value: null, error: failure instanceof Error ? failure.message : String(failure) })
            }
          })
      }, 240)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }, [scope, range.from, range.to, changeEntry, inArchive, source, t])

    const report = status.value !== null && status.value !== undefined && status.value.exists === true ? status.value : null

    /**
     * Show the existing report. The archive section lifts preview into its own
     * state so the form and the sandboxed viewer are never stacked; without
     * that owner the dialog offers the same preview inline.
     *
     * @param {object} target - normalized report-status value.
     */
    const openPreview = (target) => {
      const previewTarget = {
        path: target.path ?? target.absolutePath,
        absolutePath: target.absolutePath ?? target.path,
      }
      if (typeof onPreview === 'function') {
        onPreview(previewTarget)
        return
      }
      setPreview(previewTarget)
    }

    /** Copy the discovered report path (absolute first) and report the outcome. */
    const copyPath = async () => {
      if (report === null) return
      const target = report.absolutePath ?? report.path
      if (typeof target !== 'string' || target === '') return
      const copied = await copyTextToClipboard(target)
      if (typeof onNotice === 'function') {
        onNotice({ ok: copied === true, text: t(copied === true ? 'reportPathCopied' : 'reportCopyFailed') }, null, t(copied === true ? 'reportPathCopied' : 'reportCopyFailed'))
      }
    }

    /** Compose the Host prompt, fill the target draft, then close — never send. */
    const submit = async () => {
      if (busy === true) return
      if (rangeMissing) {
        setError(t('reportWarningRangeMissing'))
        return
      }
      if (rangeInvalid) {
        setError(t('reportWarningRangeOrder'))
        return
      }
      if (rangeEmpty) {
        setError(t('reportWarningRangeEmpty'))
        return
      }
      if (typeof compose !== 'function') {
        setError(t('reportComposeMissing'))
        return
      }
      setBusy(true)
      setError('')
      try {
        const payload = rangeMode
          ? { scope: 'range', from: range.from, to: range.to, reportRoot: normalizedRoot }
          : {
              scope: 'change',
              path: relPathOf(cwd, changeEntry?.path ?? ''),
              name: changeLabel,
              // Archive mode ignores the report root; omit it so an old
              // out-of-workspace preference cannot fail prompt composition.
              ...(inArchive ? { inArchive: true } : { reportRoot: normalizedRoot, inArchive: false }),
            }
        // Host contract: report-prompt is read-only and only returns the prompt.
        const result = source === undefined || typeof source.reportPrompt !== 'function' ? null : await source.reportPrompt(payload)
        const text = typeof result?.text === 'string' ? result.text : ''
        if (text.trim() === '') throw new Error(t('commandFailed'))
        const filled = await compose(text)
        if (filled === false || (filled !== null && typeof filled === 'object' && filled.ok === false)) {
          throw new Error(filled?.text ?? t('reportComposeMissing'))
        }
        saveReportSettings(cwd, { root: normalizedRoot, mode: inArchive ? 'archive' : 'root' })
        if (typeof onNotice === 'function') onNotice({ ok: true, text: t('reportPromptFilled') }, null, t('reportPromptFilled'))
        onClose()
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusy(false)
      }
    }

    // Preview replaces the dialog instead of stacking a second modal, so Esc /
    // backdrop closes exactly one layer and returns to the report form.
    if (preview !== null) {
      return h(ReportPreviewDialog, {
        t,
        source,
        path: preview.path,
        absolutePath: preview.absolutePath,
        onClose: () => setPreview(null),
      })
    }

    const statusNode = status.loading
      ? h(
          'div',
          { className: 'dshspec-reportStatus' },
          h(Icon, { name: 'refresh', size: 14, className: 'dshspec-spin' }),
          h('b', null, t('reportStatusLabel')),
          h('span', { className: 'dshspec-reportStatusMeta' }, t('reportStatusLoading')),
        )
      : status.error !== ''
        ? h(Banner, { tone: 'warn', wrap: true }, `${t('reportStatusFailed')}：${status.error}`)
        : report !== null
          ? h(
              'div',
              { className: 'dshspec-reportStatus' },
              h('b', null, t('reportStatusLabel')),
              h('span', { className: 'dshspec-reportStatusMeta' }, t('reportStatusGenerated')),
              report.generatedAt === null
                ? null
                : h('span', { className: 'dshspec-reportStatusMeta' }, tx(t, 'reportGeneratedAt', { time: report.generatedAt })),
              report.path === null
                ? null
                : h('span', { className: 'dshspec-reportStatusMeta', title: report.absolutePath ?? report.path }, report.path),
              rangeMode && report.includedCount > 0
                ? h('span', { className: 'dshspec-reportStatusMeta' }, tx(t, 'reportIncludedCount', { count: report.includedCount }))
                : null,
              h(
                'span',
                { className: 'dshspec-reportStatusActions' },
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'sm',
                    icon: 'file',
                    onClick: () => openPreview(report),
                  },
                  t('reportPreview'),
                ),
                h(Button, { variant: 'ghost', size: 'sm', icon: 'file', onClick: () => void copyPath() }, t('reportCopyPath')),
              ),
            )
          : h(
              'div',
              { className: 'dshspec-reportStatus' },
              h(Icon, { name: 'info', size: 14 }),
              h('b', null, t('reportStatusLabel')),
              h('span', null, t('reportStatusMissing')),
            )

    const scopeNode = h(
      'div',
      { className: 'dshspec-scopeTabs', role: 'tablist' },
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          className: 'dshspec-scopeTab',
          'aria-selected': rangeMode ? 'false' : 'true',
          'data-active': rangeMode ? undefined : 'true',
          disabled: changeEntry === null,
          onClick: () => setScope('change'),
        },
        t('reportScopeChange'),
      ),
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          className: 'dshspec-scopeTab',
          'aria-selected': rangeMode ? 'true' : 'false',
          'data-active': rangeMode ? 'true' : undefined,
          onClick: () => setScope('range'),
        },
        t('reportScopeRange'),
      ),
    )

    const targetNode = rangeMode
      ? [
          h(
            'div',
            { key: 'range', className: 'dshspec-rangeGrid' },
            h(
              'div',
              { className: 'dshspec-field' },
              h('label', { className: 'dshspec-fieldLabel' }, t('reportRangeFrom')),
              h('input', {
                className: 'dshspec-input',
                type: 'date',
                value: range.from,
                'data-autofocus': true,
                onChange: (event) => setRange((prev) => ({ ...prev, from: event.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dshspec-field' },
              h('label', { className: 'dshspec-fieldLabel' }, t('reportRangeTo')),
              h('input', {
                className: 'dshspec-input',
                type: 'date',
                value: range.to,
                onChange: (event) => setRange((prev) => ({ ...prev, to: event.target.value })),
              }),
            ),
          ),
          h('div', { key: 'rangeHint', className: 'dshspec-hint' }, t('reportRangeHint')),
          rangeMissing || rangeInvalid || rangeEmpty
            ? h(
                Banner,
                { key: 'rangeWarn', tone: 'warn', wrap: true },
                rangeMissing
                  ? t('reportWarningRangeMissing')
                  : rangeInvalid
                    ? t('reportWarningRangeOrder')
                    : t('reportWarningRangeEmpty'),
              )
            : h(
                'div',
                { key: 'included', className: 'dshspec-field' },
                h('label', { className: 'dshspec-fieldLabel' }, `${t('reportIncludedList')} · ${tx(t, 'reportIncludedCount', { count: included.length })}`),
                h(
                  'div',
                  { className: 'dshspec-reportList' },
                  included.slice(0, 10).map((item) => {
                    const name = archiveEntryLabel(item)
                    const date = archiveEntryDate(item)
                    return h(
                      'div',
                      { key: `${item.name ?? ''}\u0000${name}`, className: 'dshspec-reportListItem' },
                      h('span', { className: 'dshspec-reportListItemName', title: String(item.path ?? item.name ?? '') }, name),
                      date === null ? null : h('span', { className: 'dshspec-reportListItemDate' }, date),
                    )
                  }),
                ),
                included.length > 10 ? h('div', { className: 'dshspec-note' }, moreItemsText(t, included.length - 10)) : null,
              ),
        ]
      : h(
          'div',
          { className: 'dshspec-reportStatus' },
          h('b', null, t('reportChangeLabel')),
          h('span', { className: 'dshspec-reportStatusMeta' }, changeLabel),
          changeDate === null ? null : h('span', { className: 'dshspec-reportListItemDate' }, `${t('reportDateLabel')} ${changeDate}`),
          changeEntry === null
            ? null
            : h('span', { className: 'dshspec-outputPath' }, relPathOf(cwd, changeEntry.path ?? '')),
        )

    return h(
      Modal,
      {
        t,
        title: t('reportDialogTitle'),
        description: t('reportDialogDesc'),
        onClose,
        width: 640,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', size: 'md', onClick: onClose, disabled: busy }, t('dialogCancel')),
          h(
            Button,
            {
              key: 'generate',
              variant: 'primary',
              size: 'md',
              icon: 'file',
              onClick: () => void submit(),
              disabled: busy === true || rangeMissing || rangeInvalid || rangeEmpty || (rangeMode !== true && changeEntry === null),
            },
            busy === true ? t('commandSending') : report !== null ? t('reportRegenerate') : t('reportGenerate'),
          ),
        ],
      },
      scopeNode,
      targetNode,
      h(
        'div',
        { className: 'dshspec-field' },
        h('label', { className: 'dshspec-fieldLabel' }, t('reportRootLabel')),
        h('input', {
          className: 'dshspec-input',
          type: 'text',
          value: root,
          placeholder: t('reportRootPlaceholder'),
          spellCheck: false,
          onChange: (event) => setRoot(event.target.value),
        }),
        h('div', { className: 'dshspec-hint' }, t('reportRootHint')),
      ),
      rangeMode || changeEntry === null
        ? null
        : h(
            'label',
            { className: 'dshspec-toggleRow' },
            h('input', {
              type: 'checkbox',
              checked: inArchive,
              onChange: (event) => setInArchive(event.target.checked),
            }),
            h('span', null, t('reportArchiveMode')),
          ),
      h(
        'div',
        { className: 'dshspec-kv' },
        h('span', { className: 'dshspec-kvLabel' }, t('reportOutputPath')),
        h('span', { className: 'dshspec-kvValue dshspec-outputPath' }, outputPath),
      ),
      absoluteRootOutside && (rangeMode || inArchive !== true) ? h(Banner, { tone: 'warn', wrap: true }, t('reportWarningAbsolute')) : null,
      statusNode,
      error === '' ? null : h(Banner, { tone: 'error', wrap: true }, error),
    )
  }

  /**
   * Read-only report preview.
   *
   * The report HTML is fetched through the existing `document` route and
   * rendered in a `sandbox=""` iframe (no scripts, no same-origin access to the
   * host page). A truncated read shows an explicit note instead of silently
   * cutting the report, and the path stays copyable when rendering is not
   * possible.
   */
  function ReportPreviewDialog({ t, source, path: reportPath, absolutePath, onClose }) {
    const target = typeof reportPath === 'string' && reportPath !== '' ? reportPath : typeof absolutePath === 'string' ? absolutePath : ''
    const [state, setState] = useState({ status: 'loading', text: '', truncated: false, totalLines: null, error: '' })
    const [copied, setCopied] = useState('')

    useEffect(() => {
      let cancelled = false
      if (target === '' || source === undefined || typeof source.readDocument !== 'function') {
        setState({ status: 'error', text: '', truncated: false, totalLines: null, error: t('reportPreviewUnavailable') })
        return () => {
          cancelled = true
        }
      }
      setState({ status: 'loading', text: '', truncated: false, totalLines: null, error: '' })
      void source
        .readDocument(target, { offset: 1, limit: 4000 })
        .then((page) => {
          if (cancelled) return
          setState(
            page.ok === true
              ? { status: 'ready', text: page.text, truncated: page.truncated === true, totalLines: page.totalLines, error: '' }
              : { status: 'error', text: '', truncated: false, totalLines: null, error: page.error ?? t('readDocFailed') },
          )
        })
        .catch((failure) => {
          if (cancelled) return
          setState({ status: 'error', text: '', truncated: false, totalLines: null, error: failure instanceof Error ? failure.message : String(failure) })
        })
      return () => {
        cancelled = true
      }
    }, [source, target, t])

    /** Copy the previewed report path; inline notice (there is no panel banner here). */
    const copyPath = async () => {
      const value = typeof absolutePath === 'string' && absolutePath !== '' ? absolutePath : target
      if (value === '') return
      const ok = await copyTextToClipboard(value)
      setCopied(ok === true ? 'ok' : 'failed')
    }

    const shown = documentShownLines(state.text)

    return h(
      Modal,
      {
        t,
        title: t('reportPreviewTitle'),
        description: target === '' ? t('reportPreviewUnavailable') : target,
        onClose,
        width: 900,
        focusCard: true,
        footer: [
          h(Button, { key: 'copy', variant: 'ghost', size: 'md', icon: 'file', onClick: () => void copyPath() }, t('reportCopyPath')),
          h(Button, { key: 'close', variant: 'primary', size: 'md', onClick: onClose }, t('close')),
        ],
      },
      state.status === 'loading' ? h(LoadingBody) : null,
      state.status === 'error' ? h(Banner, { tone: 'error', wrap: true }, `${t('reportPreviewUnavailable')}：${state.error}`) : null,
      copied === '' ? null : h(Banner, { tone: copied === 'ok' ? 'info' : 'warn', wrap: true }, copied === 'ok' ? t('reportPathCopied') : t('reportCopyFailed')),
      state.truncated === true ? h(Banner, { tone: 'warn', wrap: true }, tx(t, 'reportPreviewTruncated', { shown })) : null,
      h('div', { className: 'dshspec-hint' }, t('reportPreviewNote')),
      state.status === 'ready'
        ? h('iframe', {
            className: 'dshspec-reportFrame',
            sandbox: '',
            srcDoc: state.text,
            title: t('reportPreviewTitle'),
          })
        : null,
    )
  }

  /** Project configuration (`openspec/config.yaml`) and available schemas. */
  function ProjectSection({ t, state }) {
    const config = state.config !== null && state.config !== undefined ? state.config : {}
    const schemas = Array.isArray(state.schemas) ? state.schemas : []
    const rules = config.rules !== null && typeof config.rules === 'object' ? config.rules : {}
    const ruleArtifacts = Object.keys(rules)
    const rulesCount = ruleArtifacts.reduce((sum, id) => sum + (Array.isArray(rules[id]) ? rules[id].length : 0), 0)
    const contextText = typeof config.context === 'string' ? config.context.trim() : ''
    const contextSummary = contextText.length > 240 ? `${contextText.slice(0, 239)}…` : contextText
    const operations = config.operations !== null && typeof config.operations === 'object' ? config.operations : {}
    const applyGuidance = typeof operations.apply?.guidance === 'string' ? operations.apply.guidance : ''
    const archiveGuidance = typeof operations.archive?.guidance === 'string' ? operations.archive.guidance : ''
    const [contextOpen, setContextOpen] = useState(false)
    const [rulesOpen, setRulesOpen] = useState({})
    return h(
      Section,
      {
        title: t('configSection'),
        count: rulesCount,
        headMeta: h('span', { className: 'dshspec-note' }, `${t('effectiveSchema')} · ${config.schema ?? '—'}`),
        defaultOpen: false,
      },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px' } },
        config.found !== true ? h('div', { className: 'dshspec-note' }, tx(t, 'configMissing', { schema: config.schema ?? 'spec-driven' })) : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(KvRow, { label: t('effectiveSchema'), value: config.schema ?? '—' }),
          config.found === true ? h(KvRow, { label: 'config', value: config.file ?? 'openspec/config.yaml' }) : null,
        ),
        h(
          'div',
          { className: 'dshspec-subHead' },
          h('b', null, t('contextLabel')),
          contextText === '' ? h('span', null, t('contextEmpty')) : h('span', null, `${contextText.length} chars`),
        ),
        contextText === ''
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'dshspec-contextBox' }, contextOpen ? contextText : contextSummary),
              contextText.length > 240
                ? h(
                    'button',
                    { type: 'button', className: 'dshspec-taskMore', onClick: () => setContextOpen((value) => !value) },
                    h(Icon, { name: contextOpen ? 'chevronRight' : 'chevronDown', size: 12 }),
                    contextOpen ? t('contextHide') : t('contextShow'),
                  )
                : null,
            ),
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('rulesLabel')), h('span', null, tx(t, 'rulesCount', { count: rulesCount }))),
        ruleArtifacts.length === 0
          ? h('div', { className: 'dshspec-note' }, t('rulesEmpty'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              ruleArtifacts.map((id) => {
                const items = Array.isArray(rules[id]) ? rules[id] : []
                const opened = rulesOpen[id] === true
                return h(
                  'div',
                  { key: id, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  h(
                    'button',
                    { type: 'button', className: 'dshspec-taskMore', onClick: () => setRulesOpen((prev) => ({ ...prev, [id]: !prev[id] })) },
                    h(Icon, { name: opened ? 'chevronDown' : 'chevronRight', size: 12 }),
                    `${artifactLabel(id)} · ${tx(t, 'rulesCount', { count: items.length })}`,
                  ),
                  opened
                    ? h(
                        'ul',
                        { className: 'dshspec-taskList' },
                        items.map((rule, index) =>
                          h('li', { key: index, className: 'dshspec-task' }, h(Icon, { name: 'chevronRight', size: 10 }), h('span', null, rule)),
                        ),
                      )
                    : null,
                )
              }),
            ),
        applyGuidance === '' && archiveGuidance === ''
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { className: 'dshspec-subHead' }, h('b', null, t('operationsLabel'))),
              applyGuidance === '' ? null : h(KvRow, { label: t('operationApply'), value: applyGuidance }),
              archiveGuidance === '' ? null : h(KvRow, { label: t('operationArchive'), value: archiveGuidance }),
            ),
        Array.isArray(config.warnings) && config.warnings.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              config.warnings.map((warning, index) => h(Banner, { key: index, tone: 'warn', wrap: true }, warning)),
            )
          : null,
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('schemasSection')), h('span', null, String(schemas.length))),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          schemas.map((schema) =>
            h(
              'div',
              { key: `${schema.source}-${schema.name}`, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h(
                'div',
                { className: 'dshspec-summaryLine' },
                h('span', { className: 'dshspec-strongMeta' }, h('b', null, schema.name)),
                h(ToneBadge, { tone: schema.source === 'project' ? 'business' : 'muted' }, schemaSourceText(t, schema.source)),
                typeof schema.description === 'string' && schema.description !== ''
                  ? h('span', { className: 'dshspec-note', title: schema.description }, schema.description.length > 120 ? `${schema.description.slice(0, 119)}…` : schema.description)
                  : null,
              ),
              h(
                'div',
                { className: 'dshspec-note' },
                tx(t, 'schemaArtifacts', {
                  items: (Array.isArray(schema.artifacts) ? schema.artifacts : []).map((id) => artifactLabel(id)).join('、') || '—',
                }),
              ),
            ),
          ),
        ),
      ),
    )
  }

  /** The selected workspace: native overview, changes, project config, capabilities and archive. */
  /* ------------------------------------------------------------------ *
   * Multi-role orchestration: one program, several child changes, one
   * session per (task, role).
   * ------------------------------------------------------------------ */

  const ORCHESTRATION_ROLE_ORDER = ['product', 'design', 'dev', 'test']
  const ORCHESTRATION_MODEL_ROLES = ['pm', ...ORCHESTRATION_ROLE_ORDER]
  const ORCHESTRATION_ROLE_LABELS = { pm: 'PM', product: '产品', design: '设计', dev: '开发', test: '测试' }

  /** Parse a `provider/model` model reference; empty means the session default. */
  function parseModelRef(value) {
    const text = String(value ?? '').trim()
    if (text === '') return { provider: '', model: '' }
    const slash = text.indexOf('/')
    if (slash <= 0 || slash === text.length - 1) return { provider: text, model: '' }
    return { provider: text.slice(0, slash).trim(), model: text.slice(slash + 1).trim() }
  }

  /** Role/model editor used by both create and settings dialogs. */
  function RoleModelFields({ t, roles, modelOptions, onChange }) {
    const hasOptions = Array.isArray(modelOptions) && modelOptions.length > 0
    return h(
      'div',
      { className: 'dshspec-field' },
      h('label', { className: 'dshspec-fieldLabel' }, t('orchestrationRoles')),
      ...ORCHESTRATION_MODEL_ROLES.map((role) =>
        h(
          'div',
          { key: role, className: 'dshspec-orchFormRole' },
          h('span', { className: 'dshspec-orchFormRoleLabel' }, ORCHESTRATION_ROLE_LABELS[role] ?? role),
          hasOptions
            ? h(
                'select',
                {
                  className: 'dshspec-input dshspec-select',
                  value: roles[role] ?? '',
                  onChange: (event) => onChange(role, event.target.value),
                },
                h('option', { value: '' }, t('orchestrationNoModel')),
                ...modelOptions.map((option) =>
                  h('option', { key: option.value, value: option.value }, option.label),
                ),
              )
            : h('input', {
                className: 'dshspec-input',
                value: roles[role] ?? '',
                placeholder: t('orchestrationModelHint'),
                onChange: (event) => onChange(role, event.target.value),
              }),
        ),
      ),
      h('div', { className: 'dshspec-hint' }, t('orchestrationModelHint')),
    )
  }

  /** Create one multi-role program: goal + role models, everything else by AI. */
  function ProgramDialog({ t, busy, error: externalError, modelOptions, onClose, onSubmit }) {
    const [goal, setGoal] = useState('')
    const [roles, setRoles] = useState({ pm: '', product: '', design: '', dev: '', test: '' })
    const [error, setError] = useState('')

    const submit = () => {
      if (busy === true) return
      const cleanGoal = goal.trim()
      if (cleanGoal === '') {
        setError(t('orchestrationRequired'))
        return
      }
      setError('')
      onSubmit({
        goal: cleanGoal,
        roles: Object.fromEntries(
          ORCHESTRATION_MODEL_ROLES.map((role) => [role, parseModelRef(roles[role])]),
        ),
      })
    }

    return h(
      Modal,
      {
        t,
        title: t('orchestrationCreateTitle'),
        description: t('orchestrationCreateDesc'),
        onClose,
        width: 720,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', size: 'md', onClick: onClose, disabled: busy }, t('dialogCancel')),
          h(
            Button,
            { key: 'create', variant: 'primary', size: 'md', icon: 'sparkle', onClick: submit, disabled: busy === true },
            busy === true ? t('orchestrationGenerating') : t('orchestrationGenerate'),
          ),
        ],
      },
      h(
        'div',
        { className: 'dshspec-field' },
        h('label', { className: 'dshspec-fieldLabel' }, t('orchestrationGoal')),
        h('textarea', {
          className: 'dshspec-textarea',
          'data-autofocus': true,
          rows: 5,
          maxLength: 20_000,
          value: goal,
          placeholder: t('orchestrationGoalPlaceholder'),
          onChange: (event) => setGoal(event.target.value),
        }),
        h('div', { className: 'dshspec-hint' }, t('orchestrationAutoPlanHint')),
      ),
      h(RoleModelFields, {
        t,
        roles,
        modelOptions,
        onChange: (role, value) => setRoles((current) => ({ ...current, [role]: value })),
      }),
      busy === true ? h(Banner, { tone: 'info', wrap: true }, t('orchestrationPlanningWait')) : null,
      error === '' ? null : h(Banner, { tone: 'error', wrap: true }, error),
      externalError === undefined || externalError === '' ? null : h(Banner, { tone: 'error', wrap: true }, externalError),
    )
  }

  /** Edit role models after the program was created. */
  function ProgramModelsDialog({ t, program, busy, error: externalError, modelOptions, onClose, onSubmit }) {
    const [roles, setRoles] = useState(() =>
      Object.fromEntries(
        ORCHESTRATION_MODEL_ROLES.map((role) => {
          const model = program.roles?.[role]
          return [role, model?.provider && model?.model ? `${model.provider}/${model.model}` : '']
        }),
      ),
    )
    const [error, setError] = useState('')
    const submit = () => {
      if (busy === true) return
      setError('')
      onSubmit(
        Object.fromEntries(
          ORCHESTRATION_MODEL_ROLES.map((role) => [role, parseModelRef(roles[role])]),
        ),
      )
    }
    return h(
      Modal,
      {
        t,
        title: `${program.title} · ${t('orchestrationModels')}`,
        description: t('orchestrationModelHint'),
        onClose,
        width: 560,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', size: 'md', onClick: onClose, disabled: busy }, t('dialogCancel')),
          h(
            Button,
            { key: 'save', variant: 'primary', size: 'md', icon: 'check', onClick: submit, disabled: busy === true },
            busy === true ? t('commandSending') : t('orchestrationSave'),
          ),
        ],
      },
      h(RoleModelFields, {
        t,
        roles,
        modelOptions,
        onChange: (role, value) => setRoles((current) => ({ ...current, [role]: value })),
      }),
      error === '' ? null : h(Banner, { tone: 'error', wrap: true }, error),
      externalError === undefined || externalError === '' ? null : h(Banner, { tone: 'error', wrap: true }, externalError),
    )
  }

  /** One role cell in the task matrix. */
  function RoleCell({ t, program, task, role, binding, live, busyKey, onStartRole, onOpenSession }) {
    const gate = task.roles?.[role]
    if (gate === undefined) return h('span', { className: 'dshspec-hint' }, '—')
    const running = live?.running === true || (live?.pendingInteraction !== undefined && live?.pendingInteraction !== null)
    const busy = busyKey === `${program.id}/${task.id}/${role}`
    let state = gate.done ? 'done' : running ? 'running' : gate.ready ? 'ready' : 'waiting'
    const label =
      state === 'done'
        ? t('orchestrationDone')
        : state === 'running'
          ? t('orchestrationRunning')
          : state === 'ready'
            ? t('orchestrationReady')
            : t('orchestrationWaiting')
    return h(
      'div',
      { className: 'dshspec-orchRole' },
      h(
        'span',
        { className: 'dshspec-orchState', 'data-tone': state, title: (gate.missing ?? []).join('；') },
        state === 'done' ? h(Icon, { name: 'check', size: 11 }) : null,
        label,
      ),
      gate.done === true
        ? null
        : h(
            'button',
            {
              type: 'button',
              className: 'dshspec-orchRoleBtn',
              disabled: gate.ready !== true || busy || running,
              title: gate.ready !== true ? (gate.missing ?? []).join('；') : gate.note ?? '',
              onClick: () => onStartRole(program, task, role),
            },
            busy || running ? t('orchestrationRunning') : binding === null ? t('orchestrationStart') : t('orchestrationContinue'),
          ),
      binding === null || binding.sessionId === undefined
        ? null
        : h(
            'button',
            {
              type: 'button',
              className: 'dshspec-orchRoleBtn',
              onClick: () => onOpenSession(binding.sessionId),
            },
            t('openSession'),
          ),
    )
  }

  /** Program overview + task × role matrix. */
  function OrchestrationSection({
    t,
    cwd,
    programs,
    modelDirectories,
    roleBindings,
    statusSource,
    onPlan,
    onStartRole,
    onAccept,
    onUpdateRoles,
    onSetAuto,
    onPmReview,
    onOpenSession,
  }) {
    const roleSnapshot = useRoleBindings(roleBindings)
    const statuses = useSessionStatuses(statusSource)
    const modelCatalog = useModelCatalog(modelDirectories)
    const [dialog, setDialog] = useState(null)
    const [modelsProgram, setModelsProgram] = useState(null)
    const [busyKey, setBusyKey] = useState(null)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const autoInFlight = useRef(new Set())
    const autoAttempted = useRef(new Map())
    const startRef = useRef(onStartRole)
    startRef.current = onStartRole
    const modelOptions =
      modelCatalog?.value?.groups?.flatMap((group) => {
        const providerLabel = typeof group.name === 'string' && group.name !== '' ? group.name : group.id
        return (group.models ?? []).map((model) => ({
          value: `${group.id}/${model.id}`,
          label: `${providerLabel} / ${typeof model.name === 'string' && model.name !== '' ? model.name : model.id}`,
        }))
      }) ?? []

    const create = async (payload) => {
      setBusyKey('create')
      setError('')
      try {
        const outcome = await onPlan(payload)
        if (outcome?.ok === false) setError(outcome.text ?? t('orchestrationPlanFailed'))
        else {
          setDialog(null)
          setNotice(t('orchestrationGenerated'))
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusyKey(null)
      }
    }

    const start = async (program, task, role) => {
      const key = `${program.id}/${task.id}/${role}`
      setBusyKey(key)
      setError('')
      try {
        const outcome = await onStartRole(program, task, role)
        if (outcome?.ok === false) setError(outcome.text ?? t('orchestrationStartFailed'))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusyKey(null)
      }
    }

    const accept = async (program, task) => {
      const key = `${program.id}/${task.id}/accept`
      setBusyKey(key)
      setError('')
      try {
        const outcome = await onAccept(program, task, true)
        if (outcome?.ok === false) setError(outcome.text ?? t('orchestrationAcceptFailed'))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusyKey(null)
      }
    }

    const saveModels = async (program, roles) => {
      setBusyKey(`${program.id}/models`)
      setError('')
      try {
        const outcome = await onUpdateRoles(program, roles)
        if (outcome?.ok === false) setError(outcome.text ?? t('commandFailed'))
        else {
          setModelsProgram(null)
          setNotice(t('orchestrationSaved'))
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusyKey(null)
      }
    }

    const toggleAuto = async (program, auto) => {
      setBusyKey(`${program.id}/auto`)
      setError('')
      try {
        const outcome = await onSetAuto(program, auto)
        if (outcome?.ok === false) setError(outcome.text ?? t('commandFailed'))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusyKey(null)
      }
    }

    const pmRun = async (program) => {
      setBusyKey(`${program.id}/pm`)
      setError('')
      try {
        const outcome = await onPmReview(program)
        if (outcome?.ok === false) setError(outcome.text ?? t('commandFailed'))
        else setNotice(t('orchestrationPmSent'))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusyKey(null)
      }
    }

    // PM auto-driver: start at most two ready roles per tick. The 2-minute
    // cooldown gives a started role time to write artifacts; a completed role
    // (gate.done) is never retried.
    useEffect(() => {
      if (typeof startRef.current !== 'function') return
      let started = 0
      for (const program of programs) {
        if (program.auto !== true) continue
        for (const task of program.tasks) {
          if (task.accepted === true) continue
          for (const role of ORCHESTRATION_ROLE_ORDER) {
            const gate = task.roles?.[role]
            if (gate === undefined || gate.done === true || gate.ready !== true) continue
            const key = `${program.id}/${task.id}/${role}`
            if (autoInFlight.current.has(key)) continue
            const binding = roleBindings?.get?.(cwd, program.id, task.id, role) ?? null
            if (binding !== null) {
              const live = statuses?.get?.(binding.sessionId)
              if (
                live?.running === true ||
                (live?.pendingInteraction !== undefined && live?.pendingInteraction !== null)
              ) {
                autoAttempted.current.set(key, Date.now())
                continue
              }
            }
            const last = autoAttempted.current.get(key) ?? 0
            if (Date.now() - last < 2 * 60 * 1000) continue
            autoAttempted.current.set(key, Date.now())
            autoInFlight.current.add(key)
            started += 1
            Promise.resolve(startRef.current(program, task, role))
              .then((outcome) => {
                if (outcome?.ok === false) setError(outcome.text ?? t('orchestrationStartFailed'))
              })
              .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
              .finally(() => autoInFlight.current.delete(key))
            if (started >= 2) return
          }
        }
      }
    }, [programs, statuses, roleBindings, cwd, t])

    return h(
      Section,
      {
        title: t('orchestration'),
        count: programs.length,
        defaultOpen: programs.length > 0,
        headMeta: h('span', { className: 'dshspec-hint' }, t('orchestrationHint')),
        action: h(
          Button,
          { variant: 'outline', size: 'sm', icon: 'sparkle', onClick: () => setDialog('create') },
          t('orchestrationNew'),
        ),
      },
      programs.length === 0
        ? h(SectionEmpty, {
            icon: 'users',
            title: t('orchestrationEmpty'),
            hint: t('orchestrationEmptyHint'),
            action: h(
              Button,
              { variant: 'primary', size: 'sm', icon: 'sparkle', onClick: () => setDialog('create') },
              t('orchestrationNew'),
            ),
          })
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            ...programs.map((program) =>
              h(
                'div',
                { key: program.id, className: 'dshspec-orchProgram' },
                h(
                  'div',
                  { className: 'dshspec-orchHead' },
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('div', { className: 'dshspec-orchTitle' }, program.title),
                    program.goal === '' ? null : h('div', { className: 'dshspec-orchGoal' }, program.goal),
                    program.auto === true ? h('div', { className: 'dshspec-hint' }, t('orchestrationAutoHint')) : null,
                    program.pmStatus === '' || program.pmStatus === undefined
                      ? null
                      : h(
                          'details',
                          { className: 'dshspec-orchPm' },
                          h('summary', null, t('orchestrationPmStatus')),
                          h('pre', { className: 'dshspec-orchPmText' }, program.pmStatus),
                        ),
                    h(
                      'div',
                      { className: 'dshspec-orchMeta' },
                      h('span', { className: 'dshspec-orchPill' }, `${program.progress?.accepted ?? 0}/${program.tasks.length} ${t('orchestrationAccepted')}`),
                      ...ORCHESTRATION_MODEL_ROLES.map((role) => {
                        const model = program.roles?.[role]
                        const value = model?.provider !== '' && model?.model !== '' ? `${model.provider}/${model.model}` : t('orchestrationNoModel')
                        return h('span', { key: role, className: 'dshspec-orchPill' }, `${ORCHESTRATION_ROLE_LABELS[role]} · ${value}`)
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' } },
                    h(
                      Button,
                      {
                        variant: program.auto === true ? 'primary' : 'outline',
                        size: 'sm',
                        icon: 'activity',
                        disabled: busyKey === `${program.id}/auto`,
                        onClick: () => toggleAuto(program, program.auto !== true),
                      },
                      program.auto === true ? t('orchestrationAutoPause') : t('orchestrationAutoOff'),
                    ),
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        size: 'sm',
                        icon: 'users',
                        disabled: busyKey === `${program.id}/pm`,
                        onClick: () => pmRun(program),
                      },
                      busyKey === `${program.id}/pm` ? t('orchestrationPmRunning') : t('orchestrationPm'),
                    ),
                    h(
                      Button,
                      { variant: 'ghost', size: 'sm', icon: 'users', onClick: () => setModelsProgram(program) },
                      t('orchestrationModels'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dshspec-orchTableWrap' },
                  h(
                    'table',
                    { className: 'dshspec-orchTable' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, t('orchestrationTask')),
                        ...ORCHESTRATION_ROLE_ORDER.map((role) => h('th', { key: role }, ORCHESTRATION_ROLE_LABELS[role])),
                        h('th', null, t('orchestrationAccept')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      ...program.tasks.map((task) =>
                        h(
                          'tr',
                          { key: task.id },
                          h(
                            'td',
                            null,
                            h('div', { className: 'dshspec-orchTaskName' }, task.title),
                            h('div', { className: 'dshspec-orchChange' }, task.change),
                            task.dependsOn.length === 0
                              ? null
                              : h('div', { className: 'dshspec-orchDeps' }, `${t('orchestrationDeps')}: ${task.dependsOn.join(', ')}`),
                            task.progress?.total > 0
                              ? h('div', { className: 'dshspec-orchDeps' }, `${task.progress.done}/${task.progress.total} ${t('orchestrationTask')}`)
                              : null,
                          ),
                          ...ORCHESTRATION_ROLE_ORDER.map((role) => {
                            const binding = roleBindings?.get?.(cwd, program.id, task.id, role) ?? null
                            const live = binding === null ? undefined : statuses?.get?.(binding.sessionId)
                            return h(
                              'td',
                              { key: role },
                              h(RoleCell, {
                                t,
                                program,
                                task,
                                role,
                                binding,
                                live,
                                busyKey,
                                onStartRole: start,
                                onOpenSession,
                              }),
                            )
                          }),
                          h(
                            'td',
                            null,
                            h(
                              'div',
                              { className: 'dshspec-orchUser' },
                              task.accepted === true
                                ? h(
                                    'span',
                                    { className: 'dshspec-orchState', 'data-tone': 'done' },
                                    h(Icon, { name: 'check', size: 11 }),
                                    t('orchestrationAccepted'),
                                  )
                                : h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dshspec-orchRoleBtn',
                                      disabled: task.roles?.test?.done !== true || busyKey === `${program.id}/${task.id}/accept`,
                                      title: task.roles?.test?.done === true ? '' : t('orchestrationWaitingTest'),
                                      onClick: () => accept(program, task),
                                    },
                                    t('orchestrationAccept'),
                                  ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      error === '' ? null : h(Banner, { tone: 'error', wrap: true }, error),
      notice === '' ? null : h('div', { className: 'dshspec-hint' }, notice),
      dialog === 'create'
        ? h(ProgramDialog, {
            t,
            busy: busyKey === 'create',
            error,
            modelOptions,
            onClose: () => setDialog(null),
            onSubmit: create,
          })
        : null,
      modelsProgram === null
        ? null
        : h(ProgramModelsDialog, {
            t,
            program: modelsProgram,
            busy: busyKey === `${modelsProgram.id}/models`,
            error,
            modelOptions,
            onClose: () => setModelsProgram(null),
            onSubmit: (roles) => saveModels(modelsProgram, roles),
          }),
    )
  }

  function WorkspaceDetail({ t, row, source, align, compose, init, onRefresh, bindings, roleBindings, modelDirectories, statusSource, run, startRole, planProgram, acceptTask, updateRoles, setAuto, pmReview, openSession, sessionExists }) {
    const stateSource = source !== undefined ? source.hooks.state : undefined
    const state = useSyncExternalStore(
      stateSource !== undefined ? stateSource.subscribe : () => () => {},
      stateSource !== undefined ? stateSource.getSnapshot : () => ({ status: 'loading', cwd: row.cwd }),
    )
    const bindingSnapshot = useBindings(bindings)
    const sessionStatuses = useSessionStatuses(statusSource)
    const [expanded, setExpanded] = useState({})
    const [doc, setDoc] = useState(null)
    const [notice, setNotice] = useState(null)
    const [modal, setModal] = useState(null)
    const [dialog, setDialog] = useState(null)
    const [dialogBusy, setDialogBusy] = useState(false)
    const [dialogError, setDialogError] = useState('')
    const [busyChange, setBusyChange] = useState(null)
    const [taskBusy, setTaskBusy] = useState(null)
    const [commandResult, setCommandResult] = useState(null)
    const [changeLimit, revealChanges] = useVisibleLimit(CHANGE_PAGE_SIZE)
    const noticeTimer = useRef(null)

    useEffect(
      () => () => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
      },
      [],
    )

    const report = useCallback(
      (outcome, line, successText) => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        const failed = outcome !== undefined && outcome !== null && outcome.ok === false
        setNotice({
          tone: failed ? 'error' : 'info',
          icon: failed ? 'alert' : 'check',
          text: failed ? outcome?.text ?? t('commandFailed') : successText ?? `${t('commandSentTo')} · ${line ?? ''}`,
        })
        noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
      },
      [t],
    )

    // Session activity is the fastest signal that the workspace files changed
    // (the AI may still be writing); re-read the Host state on every transition
    // so the panel's progress and status chips settle without waiting for the
    // polling tick.
    useEffect(() => {
      if (statusSource === undefined || typeof statusSource.subscribe !== 'function' || source === undefined) return () => {}
      return statusSource.subscribe(() => {
        void source.refresh()
      })
    }, [source, statusSource])

    // When the browser blocks OS notifications, completion/permission notices
    // still need a visible surface inside the panel.
    useSystemNotice(
      useCallback((text) => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        setNotice({ tone: 'warn', icon: 'alert', text })
        noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
      }, []),
    )

    /** Run one command in the change's bound conversation and report its outcome. */
    const runNow = useCallback(
      async (line, changeName) => {
        if (typeof run !== 'function') {
          const failed = { ok: false, text: t('commandSendFailed') }
          report(failed, line)
          return failed
        }
        setBusyChange(typeof changeName === 'string' ? changeName : '__workspace__')
        try {
          const outcome = await run(line, changeName)
          // Direct execution may refuse (target conversation busy/waiting, host
          // validation, ...). Instead of leaving the click without a visible
          // effect, hand the exact command to the workspace conversation as a
          // draft the user sends manually — the panel's accepted fallback.
          if (
            outcome !== undefined &&
            outcome !== null &&
            outcome.ok === false &&
            typeof compose === 'function'
          ) {
            const draft = await compose(row, line)
            if (draft !== undefined && draft !== null && draft.ok === true) {
              const drafted = { ok: true, text: line, drafted: true }
              report(drafted, line, t('commandDrafted'))
              return drafted
            }
          }
          report(outcome, line)
          if (
            outcome !== undefined &&
            outcome !== null &&
            outcome.ok !== false &&
            typeof outcome.resultText === 'string' &&
            outcome.resultText !== '' &&
            /^\/opsx-(?:status|validate)\b/.test(String(line ?? ''))
          ) {
            setCommandResult(outcome.resultText)
          }
          return outcome
        } catch (failure) {
          const failed = { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
          report(failed, line)
          return failed
        } finally {
          setBusyChange(null)
        }
      },
      [compose, report, row, run, t],
    )

    /** Open a bound conversation from a change card chip. */
    const openBoundSession = useCallback(
      (binding) => {
        if (binding === null || binding === undefined || typeof binding.sessionId !== 'string') return
        if (typeof openSession === 'function') openSession(binding.sessionId)
      },
      [openSession],
    )

    /** Tick/untick one task and re-read the Host state. */
    const toggleTask = useCallback(
      async (changeName, line, done) => {
        if (source === undefined || typeof source.toggleTask !== 'function') {
          report({ ok: false, text: t('taskToggleFailed') })
          return
        }
        setTaskBusy({ change: changeName, line })
        try {
          const result = await source.toggleTask(changeName, line, done)
          if (result.ok !== true) report({ ok: false, text: result.error ?? t('taskToggleFailed') })
        } finally {
          setTaskBusy(null)
        }
      },
      [report, source, t],
    )

    const openDoc = useCallback(
      (item, focusLine) => {
        const rawPath = typeof item?.path === 'string' ? item.path : ''
        if (rawPath === '') return
        const base = {
          title: item.label ?? basenameOf(rawPath),
          path: rawPath,
          relPath: relPathOf(row.cwd, rawPath),
          status: 'loading',
          text: '',
          truncated: false,
          totalLines: null,
          offset: 1,
          focusLine: typeof focusLine === 'number' && Number.isFinite(focusLine) ? focusLine : null,
        }
        setDoc(base)
        if (source === undefined) {
          setDoc({ ...base, status: 'error', error: t('commandFailed') })
          return
        }
        void source.readDocument(rawPath, { offset: 1, limit: DOC_PAGE_LINES }).then((page) => {
          setDoc((prev) => {
            if (prev === null || prev.path !== rawPath) return prev
            return page.ok
              ? { ...prev, status: 'ready', text: page.text, truncated: page.truncated === true, totalLines: page.totalLines, offset: page.offset }
              : { ...prev, status: 'error', error: page.error ?? '' }
          })
        })
      },
      [row.cwd, source, t],
    )

    const openIssue = useCallback(
      (issue, change) => {
        if (typeof issue?.path !== 'string' || issue.path === '') return
        let path = issue.path
        const workspaceRelative = path.startsWith('openspec/') || path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
        if (!workspaceRelative && change !== undefined && typeof change.name === 'string' && change.name !== '') {
          path = `openspec/changes/${change.name}/${path}`
        }
        openDoc({ path, label: basenameOf(path) }, issue.line)
      },
      [openDoc],
    )

    const readMoreDoc = useCallback(async () => {
      if (doc === null || source === undefined) return { ok: false, error: t('docReadMoreFailed') }
      const shown = documentShownLines(doc.text)
      const page = await source.readDocument(doc.path, { offset: (doc.offset ?? 1) + shown, limit: DOC_PAGE_LINES })
      if (!page.ok) return { ok: false, error: page.error ?? t('docReadMoreFailed') }
      setDoc((prev) =>
        prev !== null && prev.path === doc.path
          ? {
              ...prev,
              text: `${prev.text}\n${page.text}`,
              truncated: page.truncated === true,
              totalLines: page.totalLines ?? prev.totalLines,
            }
          : prev,
      )
      return { ok: true }
    }, [doc, source, t])

    const openValidation = useCallback(
      (change) => {
        setModal({ kind: 'validate', status: 'loading', name: change.name })
        if (source === undefined) {
          setModal({ kind: 'validate', status: 'error', name: change.name, error: t('validateFailed') })
          return
        }
        void source.validateChange(change.name).then((result) => {
          setModal((prev) =>
            prev !== null && prev.kind === 'validate' && prev.name === change.name
              ? result.ok === true
                ? { kind: 'validate', status: 'ready', name: change.name, validation: result.validation }
                : { kind: 'validate', status: 'error', name: change.name, error: result.error ?? t('validateFailed') }
              : prev,
          )
        })
      },
      [source, t],
    )

    const openSpecIssues = useCallback((spec) => {
      if (spec === null || spec === undefined) return
      setModal({ kind: 'spec-issues', status: 'ready', name: spec.name, validation: spec.validation })
    }, [])

    const openSyncPreview = useCallback(
      (change) => {
        setModal({ kind: 'sync', status: 'loading', name: change.name })
        if (source === undefined) {
          setModal({ kind: 'sync', status: 'error', name: change.name, error: t('syncPreviewFailed') })
          return
        }
        void source.syncPreview(change.name).then((result) => {
          setModal((prev) =>
            prev !== null && prev.kind === 'sync' && prev.name === change.name
              ? result.ok === true
                ? { kind: 'sync', status: 'ready', name: change.name, text: result.text }
                : { kind: 'sync', status: 'error', name: change.name, error: result.error ?? t('syncPreviewFailed') }
              : prev,
          )
        })
      },
      [source, t],
    )

    const reload = useCallback(async () => {
      if (source === undefined) {
        if (typeof onRefresh === 'function') await onRefresh()
        return
      }
      await source.refresh()
    }, [source, onRefresh])

    const toggleChange = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))

    const changes = state.status === 'ready' ? state.changes : []
    const specs = state.status === 'ready' ? state.specs : []
    const archived = state.status === 'ready' ? state.archived : []
    const changePage = paginate(changes, { pageSize: changeLimit })
    const warnings = Array.isArray(state.warnings) ? state.warnings : []
    const pending = pendingAcceptanceTasks(changes)
    const pendingLimited = changes.some(
      (change) =>
        Number.isFinite(change?.tasks?.total) &&
        Number.isFinite(change?.tasks?.items?.length) &&
        change.tasks.total > change.tasks.items.length,
    )

    /** Whether a change's bound conversation is currently busy (disable quick ticks). */
    const isPendingChangeBusy = (changeName) => {
      const change = changes.find((entry) => entry.name === changeName)
      if (change === undefined) return false
      const stored = bindings?.get(row.cwd, changeName) ?? null
      const binding =
        stored !== null && (typeof sessionExists !== 'function' || sessionExists(stored.sessionId)) ? stored : null
      return busyChange === changeName || changeStatusInfo(change, binding, sessionStatuses, t).busy === true
    }

    /** Open the owning tasks.md at the pending task's line. */
    const openPendingTask = (item) => {
      const change = changes.find((entry) => entry.name === item.change)
      const docPath = tasksDocOf(change)
      if (typeof docPath !== 'string' || docPath === '') return
      openDoc({ path: docPath, label: basenameOf(docPath) || t('taskList') }, item.line)
    }

    const { submitPropose, submitExplore } = createDialogSubmitters({
      t,
      runNow,
      setDialogBusy,
      setDialogError,
      setDialog,
    })

    const validationModal =
      modal !== null && modal.kind === 'validate'
        ? h(
            Modal,
            {
              t,
              title: t('validateTitle'),
              description: `${modal.name ?? ''} · ${t('validateDesc')}`,
              onClose: () => setModal(null),
              width: 680,
              focusCard: true,
            },
            modal.status === 'loading'
              ? h(LoadingBody)
              : modal.status === 'error'
                ? h(Banner, { tone: 'error', wrap: true }, modal.error ?? t('validateFailed'))
                : h(
                    'div',
                    { className: 'dshspec-modalBody' },
                    h(Banner, { tone: totalIssues(modal.validation) > 0 ? 'warn' : 'info', wrap: true }, validationSummaryText(t, modal.validation)),
                    h(IssueList, {
                      t,
                      issues: modal.validation?.issues,
                      onIssue: (issue) => {
                        openIssue(issue, { name: modal.name })
                        setModal(null)
                      },
                    }),
                  ),
          )
        : null

    const syncModal =
      modal !== null && modal.kind === 'sync'
        ? h(
            Modal,
            {
              t,
              title: t('syncPreviewTitle'),
              description: `${modal.name ?? ''} · ${t('syncPreviewDesc')}`,
              onClose: () => setModal(null),
              width: 760,
              focusCard: true,
            },
            modal.status === 'loading'
              ? h(LoadingBody)
              : modal.status === 'error'
                ? h(Banner, { tone: 'error', wrap: true }, modal.error ?? t('syncPreviewFailed'))
                : modal.text === ''
                  ? h('div', { className: 'dshspec-note' }, t('syncPreviewDesc'))
                  : h(Markdown, { text: modal.text }),
          )
        : null

    const specIssuesModal =
      modal !== null && modal.kind === 'spec-issues'
        ? h(
            Modal,
            {
              t,
              title: t('validateTitle'),
              description: `${modal.name ?? ''} · ${validationSummaryText(t, modal.validation)}`,
              onClose: () => setModal(null),
              width: 680,
              focusCard: true,
            },
            h(IssueList, {
              t,
              issues: modal.validation?.issues,
              onIssue: (issue) => {
                openIssue(issue)
                setModal(null)
              },
            }),
          )
        : null

    return h(
      'section',
      { className: 'dshspec-detail', 'data-dshspec-workspace': row.cwd },
      h(
        'div',
        { className: 'dshspec-detailBar' },
        h(Icon, { name: 'folder', size: 15, className: 'dshspec-detailBarIcon' }),
        h('span', { className: 'dshspec-detailBarPath', title: row.cwd }, row.cwd),
        h(
          'div',
          { className: 'dshspec-detailActions' },
          h(Button, { variant: 'ghost', size: 'md', icon: 'compass', title: '/opsx-explore [主题]', onClick: () => setDialog({ kind: 'explore' }) }, t('explore')),
          h(Button, { variant: 'outline', size: 'md', icon: 'filePlus', title: '/opsx-propose <change-name> [说明]', onClick: () => setDialog({ kind: 'propose' }) }, t('propose')),
          h(Button, { variant: 'ghost', size: 'md', icon: 'activity', title: '/opsx-status', onClick: () => void runNow('/opsx-status') }, t('status')),
        ),
      ),
      notice === null ? null : h(Banner, { tone: notice.tone, icon: notice.icon, wrap: notice.tone === 'error' }, notice.text),
      state.status === 'loading' ? h(LoadingBody) : null,
      state.status === 'error'
        ? h(
            'div',
            { className: 'dshspec-card' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h(Banner, { tone: 'error', wrap: true }, `${t('error')}：${state.error ?? ''}`),
              h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void reload() }, t('retry')),
            ),
          )
        : null,
      state.status === 'missing' ? h('div', { className: 'dshspec-card' }, h(MissingBody, { t, init, refresh: () => void reload(), cwd: row.cwd })) : null,
      state.status === 'ready'
        ? [
            h(SummaryBar, { key: 'summary', t, state }),
            h(OrchestrationSection, {
              key: 'orchestration',
              t,
              cwd: row.cwd,
              programs: Array.isArray(state.orchestration) ? state.orchestration : [],
              modelDirectories,
              roleBindings,
              statusSource,
              onPlan: planProgram,
              onStartRole: startRole,
              onAccept: acceptTask,
              onUpdateRoles: updateRoles,
              onSetAuto: setAuto,
              onPmReview: pmReview,
              onOpenSession: openSession,
            }),
            h(PendingAcceptanceSection, {
              key: 'pending',
              t,
              pending,
              limited: pendingLimited,
              onOpenTask: openPendingTask,
              onToggleTask: toggleTask,
              taskBusy,
              isBusy: isPendingChangeBusy,
            }),
            state.backgroundError === undefined || state.backgroundError === null
              ? null
              : h(Banner, { key: 'background', tone: 'warn', wrap: true }, `${t('error')}：${state.backgroundError}`),
            h(ProjectSection, { key: 'config', t, state }),
            h(
              'section',
              { key: 'changes', className: 'dshspec-section' },
              h(
                'div',
                { className: 'dshspec-sectionHead' },
                h('span', { className: 'dshspec-sectionTitle' }, t('activeChanges')),
                h('span', { className: 'dshspec-sectionCount' }, String(changes.length)),
                h('span', { className: 'dshspec-space' }),
                h(Button, { variant: 'primary', size: 'sm', icon: 'filePlus', onClick: () => setDialog({ kind: 'propose' }) }, t('newProposal')),
              ),
              h(
                'div',
                { className: 'dshspec-sectionBody' },
                changes.length === 0
                  ? h(SectionEmpty, {
                      icon: 'sparkle',
                      title: t('noChanges'),
                      hint: t('noChangesHint'),
                      action: h(Button, { variant: 'primary', size: 'md', icon: 'filePlus', onClick: () => setDialog({ kind: 'propose' }) }, t('newProposal')),
                    })
                  : changePage.items.map((change) => {
                      const storedBinding = bindings?.get(row.cwd, change.name) ?? null
                      const binding =
                        storedBinding !== null && (typeof sessionExists !== 'function' || sessionExists(storedBinding.sessionId))
                          ? storedBinding
                          : null
                      const baseStatus = changeStatusInfo(change, binding, sessionStatuses, t)
                      const runStatus =
                        busyChange === change.name
                          ? { ...baseStatus, kind: 'running', label: t('statusRunning'), busy: true }
                          : baseStatus
                      return h(ChangeCard, {
                        key: change.name,
                        t,
                        change: normalizeChangeState(change, change.name),
                        open: expanded[change.name] === true,
                        onToggle: () => toggleChange(change.name),
                        openDoc,
                        onIssue: (issue) => openIssue(issue, change),
                        onValidate: openValidation,
                        onSyncPreview: openSyncPreview,
                        runStatus,
                        boundSession: binding,
                        onOpenSession: openBoundSession,
                        onRun: (line, changeName) => void runNow(line, changeName),
                        onPropose: () => setDialog({ kind: 'propose' }),
                        onToggleTask: toggleTask,
                        taskBusyLine: taskBusy !== null && taskBusy.change === change.name ? taskBusy.line : null,
                      })
                    }),
                h(ListMore, { t, hidden: changePage.hidden, reveal: Math.min(changePage.pageSize, changePage.hidden), onMore: revealChanges }),
              ),
            ),
            h(
              Section,
              { key: 'specs', title: t('capabilitySpecs'), count: specs.length, defaultOpen: true },
              h(CapabilitySection, { t, specs, openDoc, onIssues: openSpecIssues }),
            ),
            h(ArchiveSection, {
              key: 'archive',
              t,
              source,
              archived,
              openDoc,
              cwd: row.cwd,
              compose: (line) => (typeof compose === 'function' ? compose(row, line) : undefined),
              onNotice: report,
            }),
            warnings.length === 0
              ? null
              : h(
                  Section,
                  { key: 'warnings', title: t('workspaceWarnings'), count: warnings.length, defaultOpen: false },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px' } },
                    warnings.map((warning, index) => h(Banner, { key: index, tone: 'warn', wrap: true }, warning)),
                  ),
                ),
            state.watchDown === true || (source !== undefined && source.sessionId === undefined)
              ? h(
                  'div',
                  { key: 'watch', className: 'dshspec-foot' },
                  h(Icon, { name: 'refresh', size: 14 }),
                  h('span', null, source !== undefined && source.sessionId === undefined ? t('pollingHint') : t('watchDown')),
                )
              : null,
          ]
        : null,
      validationModal,
      syncModal,
      specIssuesModal,
      dialog !== null && dialog.kind === 'propose'
        ? h(ProposeDialog, {
            t,
            busy: dialogBusy,
            error: dialogError,
            onClose: () => {
              setDialog(null)
              setDialogError('')
            },
            onSubmit: (value) => void submitPropose(value),
          })
        : null,
      dialog !== null && dialog.kind === 'explore'
        ? h(ExploreDialog, {
            t,
            busy: dialogBusy,
            error: dialogError,
            onClose: () => {
              setDialog(null)
              setDialogError('')
            },
            onSubmit: (topic) => void submitExplore(topic),
          })
        : null,
      commandResult === null
        ? null
        : h(
            Modal,
            {
              t,
              title: t('status'),
              description: t('statusDesc'),
              onClose: () => setCommandResult(null),
              width: 720,
              focusCard: true,
            },
            h('pre', { className: 'dshspec-pre dshspec-prePlain' }, commandResult),
          ),
      doc === null
        ? null
        : h(DocModal, {
            t,
            doc,
            onClose: () => setDoc(null),
            onAlign: typeof align === 'function' ? () => align(row, doc)() : undefined,
            onReadMore: readMoreDoc,
          }),
    )
  }

  /** Cached workspace selection so navigating away and back keeps the pick. */
  let lastSelectedWorkspace = null

  /** The monitoring page: workspace switcher on top, selected workspace below. */
  function OpenspecPanel({ t, rowsSource, sourceFor, runFor, composeFor, startRoleFor, planProgramFor, acceptTaskFor, updateRolesFor, setAutoFor, pmReviewFor, alignFor, initFor, onRefreshSessions, bindings, roleBindings, modelDirectories, statusSource, openSession, sessionExists }) {
    const rows = useSyncExternalStore(rowsSource.subscribe, rowsSource.getSnapshot)
    const [selected, setSelected] = useState(() => lastSelectedWorkspace)
    const [nonce, setNonce] = useState(0)
    const [spinning, setSpinning] = useState(false)
    const selectedRow = rows.find((row) => row.cwd === selected) ?? rows[0]

    const select = (cwd) => {
      lastSelectedWorkspace = cwd
      setSelected(cwd)
    }

    const refreshAll = async () => {
      setSpinning(true)
      try {
        await onRefreshSessions()
      } finally {
        setSpinning(false)
        setNonce((value) => value + 1)
      }
    }

    return h(
      'div',
      { className: 'dshspec-root', 'data-dshspec-panel': true, 'data-dshspec-build': BUILD },
      h(
        'div',
        { className: 'dshspec-page' },
        h(
          'div',
          { className: 'dshspec-pageHead' },
          h(
            'div',
            { className: 'dshspec-pageHeadText' },
            h('h1', { className: 'dshspec-title' }, t('title')),
            h('p', { className: 'dshspec-sub', style: { margin: '2px 0 0' } }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'dshspec-pageActions' },
            h(IconButton, {
              icon: 'refresh',
              label: t('refreshAll'),
              size: 32,
              onClick: () => void refreshAll(),
              className: spinning ? 'dshspec-spin' : undefined,
            }),
          ),
        ),
        rows.length === 0
          ? h(
              'section',
              { className: 'dshspec-card' },
              h(
                'div',
                { className: 'dshspec-empty' },
                h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'info', size: 20 })),
                h('div', { className: 'dshspec-emptyTitle' }, t('nosession')),
              ),
            )
          : [
              h(
                'div',
                { key: 'wsbar', className: 'dshspec-wsbar' },
                h('span', { className: 'dshspec-wsbarLabel' }, t('workspaceLabel')),
                h(
                  'div',
                  { className: 'dshspec-wstabs' },
                  rows.map((row) =>
                    h(
                      'button',
                      {
                        key: row.cwd,
                        type: 'button',
                        className: 'dshspec-wstab',
                        title: row.cwd,
                        'data-active': selectedRow !== undefined && row.cwd === selectedRow.cwd ? 'true' : undefined,
                        onClick: () => select(row.cwd),
                      },
                      h(Icon, { name: 'folder', size: 15 }),
                      h('span', { className: 'dshspec-wstabName' }, basenameOf(row.cwd)),
                    ),
                  ),
                ),
              ),
              selectedRow === undefined
                ? null
                : h(WorkspaceDetail, {
                    key: `${selectedRow.cwd}#${nonce}`,
                    t,
                    row: selectedRow,
                    source: sourceFor(selectedRow),
                    run: typeof runFor === 'function' ? (line, change) => runFor(selectedRow)(line, change) : undefined,
                    compose: typeof composeFor === 'function' ? (row, line) => composeFor(row)(line) : undefined,
                    align: alignFor,
                    init: initFor,
                    onRefresh: onRefreshSessions,
                    bindings,
                    roleBindings,
                    modelDirectories,
                    startRole: typeof startRoleFor === 'function' ? (program, task, role) => startRoleFor(selectedRow, program, task, role) : undefined,
                    planProgram: typeof planProgramFor === 'function' ? (payload) => planProgramFor(selectedRow, payload) : undefined,
                    acceptTask: typeof acceptTaskFor === 'function' ? (program, task, accepted) => acceptTaskFor(selectedRow, program, task, accepted) : undefined,
                    updateRoles: typeof updateRolesFor === 'function' ? (program, roles) => updateRolesFor(selectedRow, program, roles) : undefined,
                    setAuto: typeof setAutoFor === 'function' ? (program, auto) => setAutoFor(selectedRow, program, auto) : undefined,
                    pmReview: typeof pmReviewFor === 'function' ? (program) => pmReviewFor(selectedRow, program) : undefined,
                    statusSource,
                    openSession,
                    sessionExists,
                  }),
            ],
      ),
    )
  }



  /** Inline composer quick bar: native status, next-step action, skip_specs/blocked/skills signals. */
  function DockBody({ t, state, source, openPanel, init, sessionId, variant, bindings, statusSource, run, sessionExists }) {
    const [toast, setToast] = useState(null)
    const [selectedName, setSelectedName] = useState(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const [dialog, setDialog] = useState(null)
    const [dialogBusy, setDialogBusy] = useState(false)
    const [dialogError, setDialogError] = useState('')
    const [sending, setSending] = useState(false)
    const menuRef = useRef(null)
    const toastTimer = useRef(null)
    const bindingSnapshot = useBindings(bindings)
    const sessionStatuses = useSessionStatuses(statusSource)

    useEffect(
      () => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      },
      [],
    )

    useEffect(() => {
      if (!menuOpen) return
      const onPointerDown = (event) => {
        if (menuRef.current !== null && !menuRef.current.contains(event.target)) setMenuOpen(false)
      }
      const onKey = (event) => {
        if (event.key === 'Escape') setMenuOpen(false)
      }
      document.addEventListener('mousedown', onPointerDown, true)
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('mousedown', onPointerDown, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }, [menuOpen])

    const showToast = useCallback((text) => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      setToast(text)
      toastTimer.current = setTimeout(() => setToast(null), 3200)
    }, [])
    useSystemNotice(showToast)

    const changes = state.status === 'ready' ? state.changes.map((change) => normalizeChangeState(change, change.name)) : []
    const rawTarget = changes.find((change) => change.name === selectedName) ?? primaryChange(state)
    const target = rawTarget === undefined ? undefined : normalizeChangeState(rawTarget, rawTarget.name)
    const cwd = typeof state.cwd === 'string' ? state.cwd : source?.cwd ?? ''
    const storedBinding = target === undefined || cwd === '' ? null : bindings?.get(cwd, target.name) ?? null
    const binding =
      storedBinding !== null && (typeof sessionExists !== 'function' || sessionExists(storedBinding.sessionId))
        ? storedBinding
        : null
    const baseStatus = changeStatusInfo(target, binding, sessionStatuses, t)
    const busy = sending === true || baseStatus.busy === true

    /** Send immediately in the change's bound conversation (no second Enter). */
    const runNow = async (line, changeName) => {
      if (typeof run !== 'function') {
        showToast(t('commandSendFailed'))
        return { ok: false, text: t('commandSendFailed') }
      }
      setSending(true)
      try {
        const outcome = await run(line, changeName)
        if (outcome !== undefined && outcome !== null && outcome.ok === false) showToast(outcome.text ?? t('commandSendFailed'))
        else {
          const resultText = typeof outcome?.resultText === 'string' && outcome.resultText !== '' ? outcome.resultText : ''
          const compact = resultText.replace(/\s+/g, ' ').trim()
          showToast(compact === '' ? `${t('commandSentTo')} · ${line}` : compact.length > 220 ? `${compact.slice(0, 219)}…` : compact)
        }
        return outcome
      } catch (failure) {
        const text = failure instanceof Error ? failure.message : String(failure)
        showToast(text)
        return { ok: false, text }
      } finally {
        setSending(false)
      }
    }

    const { submitPropose, submitExplore } = createDialogSubmitters({
      t,
      runNow,
      setDialogBusy,
      setDialogError,
      setDialog,
    })

    const action = deriveNextAction(target)
    const progress = taskProgressInfo(target?.tasks)
    const blocked = target !== undefined ? blockedArtifacts(target.artifacts) : []
    const nativeSkills = state.skills !== null && state.skills !== undefined && Array.isArray(state.skills.native) ? state.skills.native : []
    const fallbackActive = state.skills !== null && state.skills !== undefined && state.skills.fallbackActive === true
    const runNext = () => {
      if (busy) return
      if (target === undefined) {
        setDialog({ kind: 'propose' })
        return
      }
      void runNow(action.line, target.name)
    }

    const dot = h('span', { className: 'dshspec-dot', style: { background: toneColor(target === undefined ? 'muted' : changeTone(target)) } })
    const nameNode =
      target === undefined
        ? h('span', { className: 'dshspec-dockName', title: t('quickNoChange') }, `OpenSpec · ${t('quickNoChange')}`)
        : h('span', { className: 'dshspec-dockName', title: target.name }, target.name)
    const statusMeta =
      target === undefined
        ? []
        : [
            h(
              'span',
              { key: 'status', className: 'dshspec-statusBadge', 'data-status': busy ? 'running' : baseStatus.kind, title: busy ? (baseStatus.kind === 'waiting' ? t('statusWaitHint') : t('statusRunHint')) : baseStatus.label },
              h(Icon, { name: busy || baseStatus.kind === 'running' ? 'refresh' : baseStatus.kind === 'waiting' ? 'alert' : baseStatus.kind === 'complete' ? 'check' : 'activity', size: 11 }),
              busy ? t('statusRunning') : baseStatus.label,
            ),
            target.schemaName === '' ? null : h(ToneBadge, { key: 'schema', tone: 'muted', title: tx(t, 'changeSchema', { name: target.schemaName }) }, target.schemaName),
            target.metadata.skip_specs === true ? h(ToneBadge, { key: 'skip', tone: 'muted', title: t('skipSpecs') }, t('skipSpecs')) : null,
            blocked.length > 0
              ? h(
                  ToneBadge,
                  {
                    key: 'blocked',
                    tone: 'warn',
                    title: blocked.map((artifact) => `${artifactLabel(artifact.id)}: ${artifact.missingDeps.map((dep) => artifactLabel(dep)).join('、')}`).join('\n'),
                  },
                  tx(t, 'blockedCount', { count: blocked.length }),
                )
              : null,
            progress.total > 0
              ? h('span', { key: 'progress', className: 'dshspec-progressCount', title: t('progressLabel') }, tx(t, 'taskProgress', { done: progress.done, total: progress.total }))
              : null,
          ]
    const skillsBadge =
      nativeSkills.length > 0
        ? h(
            ToneBadge,
            { tone: 'business', title: tx(t, 'nativeSkillsTitle', { names: nativeSkills.map((skill) => skill.name ?? skill.workflow ?? '').join(', ') }) },
            `${t('nativeSkills')} ${nativeSkills.length}`,
          )
        : fallbackActive
          ? h(ToneBadge, { tone: 'muted', title: t('fallbackSkillsTitle') }, t('fallbackSkills'))
          : null

    const statusArea =
      target === undefined || changes.length <= 1
        ? h('div', { className: 'dshspec-dockStatus' }, dot, nameNode, statusMeta)
        : h(
            'div',
            { className: 'dshspec-dockStatus' },
            h(
              'div',
              { className: 'dshspec-dockTargetWrap', ref: menuRef },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshspec-dockTarget',
                  title: t('switchChange'),
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  onClick: () => setMenuOpen((value) => !value),
                },
                dot,
                nameNode,
                statusMeta,
                h(Icon, { name: 'chevronDown', size: 12, className: 'dshspec-dockCaret' }),
              ),
              menuOpen
                ? h(
                    'div',
                    { className: 'dshspec-dockMenu', role: 'menu' },
                    h('div', { className: 'dshspec-dockMenuHead' }, h('span', null, t('switchChange')), h('span', null, String(changes.length))),
                    changes.map((change) => {
                      const itemProgress = taskProgressInfo(change.tasks)
                      const itemBinding = bindings?.get(cwd, change.name) ?? null
                      const itemStatus = changeStatusInfo(change, itemBinding, sessionStatuses, t)
                      return h(
                        'button',
                        {
                          key: change.name,
                          type: 'button',
                          role: 'menuitemradio',
                          className: 'dshspec-dockMenuItem',
                          title: change.name,
                          'aria-checked': target !== undefined && change.name === target.name ? 'true' : 'false',
                          'data-active': target !== undefined && change.name === target.name ? 'true' : undefined,
                          onClick: () => {
                            setSelectedName(change.name)
                            setMenuOpen(false)
                          },
                        },
                        h('span', { className: 'dshspec-dockMenuName' }, change.name),
                        h(ToneBadge, { tone: itemStatus.tone }, itemStatus.label),
                        change.metadata.skip_specs === true ? h('span', { className: 'dshspec-dockMenuCount' }, 'skip_specs') : null,
                        itemProgress.total > 0 ? h('span', { className: 'dshspec-dockMenuCount' }, `${itemProgress.done}/${itemProgress.total}`) : null,
                        target !== undefined && change.name === target.name ? h(Icon, { name: 'check', size: 14 }) : null,
                      )
                    }),
                  )
                : null,
            ),
          )

    return h(
      'div',
      {
        className: 'dshspec-dock',
        'data-dshspec-quickbar': 'ready',
        'data-dshspec-session': sessionId,
        ...(variant === undefined ? {} : { 'data-dshspec-variant': variant }),
      },
      statusArea,
      h(
        'div',
        { className: 'dshspec-dockActions' },
        h(
          'div',
          { className: 'dshspec-seg' },
          h(Button, { variant: 'ghost', size: 'sm', className: 'dshspec-dockGhost', title: '/opsx-explore [主题]', onClick: () => setDialog({ kind: 'explore' }) }, t('explore')),
          // The primary button already says「提案」when proposing is the next
          // step — do not repeat it in the segment next to it.
          action.kind === 'propose'
            ? null
            : h(Button, { variant: 'ghost', size: 'sm', className: 'dshspec-dockGhost', title: '/opsx-propose <change-name> [说明]', onClick: () => setDialog({ kind: 'propose' }) }, t('propose')),
          h(
            Button,
            {
              variant: 'primary',
              size: 'sm',
              icon: busy ? 'refresh' : nextActionIcon(action.kind),
              title: busy ? (baseStatus.kind === 'waiting' ? t('statusWaitHint') : t('statusRunHint')) : action.kind === 'propose' && target === undefined ? '/opsx-propose ' : action.line,
              onClick: runNext,
              disabled: busy,
              'data-dshspec-run-status': busy ? 'running' : baseStatus.kind,
            },
            busy ? (baseStatus.kind === 'waiting' ? t('statusWaiting') : t('statusRunning')) : nextActionText(t, action),
          ),
        ),
        skillsBadge === null ? null : h('span', { className: 'dshspec-dockSkills' }, skillsBadge),
        h(Button, { variant: 'ghost', size: 'sm', className: 'dshspec-dockStatusBtn', title: '/opsx-status', onClick: () => void runNow('/opsx-status') }, t('status')),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      ),
      toast === null ? null : h('div', { className: 'dshspec-toast', role: 'status' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, toast)),
      dialog !== null && dialog.kind === 'propose'
        ? h(ProposeDialog, {
            t,
            busy: dialogBusy,
            error: dialogError,
            onClose: () => {
              setDialog(null)
              setDialogError('')
            },
            onSubmit: (value) => void submitPropose(value),
          })
        : null,
      dialog !== null && dialog.kind === 'explore'
        ? h(ExploreDialog, {
            t,
            busy: dialogBusy,
            error: dialogError,
            onClose: () => {
              setDialog(null)
              setDialogError('')
            },
            onSubmit: (topic) => void submitExplore(topic),
          })
        : null,
    )
  }

  /** The quick bar: under the composer, or at the right end of the hero workspace row. */
  function QuickBar({ state: stateSource, source, openPanel, t, init, sessionId, heroOnly, bindings, statusSource, run, sessionExists }) {
    if (stateSource === undefined || source === undefined) return null
    const state = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
    if (state.status === 'loading') return null
    // The hero seat renders a compact inline variant (see the
    // `data-dshspec-variant=hero` CSS rules) instead of a full-width stripe.
    const heroAttr = heroOnly === true ? { 'data-dshspec-variant': 'hero' } : {}
    if (state.status === 'error') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'error', 'data-dshspec-session': sessionId, ...heroAttr },
        h(
          'div',
          { className: 'dshspec-banner dshspec-bannerError', style: { flex: 1, minWidth: 0 } },
          h(Icon, { name: 'alert', size: 14 }),
          h('span', { className: 'dshspec-bannerText', title: state.error ?? '' }, `${t('error')}：${state.error ?? ''}`),
        ),
        h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void source.refresh() }, t('retry')),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    if (state.status === 'missing') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'missing', 'data-dshspec-session': sessionId, ...heroAttr },
        h('span', { className: 'dshspec-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }),
        h('span', { className: 'dshspec-dockName' }, `OpenSpec · ${t('quickMissing')}`),
        h('span', { className: 'dshspec-space' }),
        h(InitControl, { t, init, refresh: () => source.refresh(), cwd: state.cwd }),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    return h(DockBody, {
      t,
      state,
      source,
      openPanel,
      init,
      sessionId,
      variant: heroOnly === true ? 'hero' : undefined,
      bindings,
      statusSource,
      run,
      sessionExists,
    })
  }

  /* ------------------------------------------------------------------ *
   * Registration.
   * ------------------------------------------------------------------ */

  /** Sidebar glyph: a small phase-loop mark. */
  function PanelIcon() {
    return h(
      'svg',
      { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
      h('path', {
        d: 'M 8 7 a 6.5 6.5 0 1 1 -1 7.5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
      }),
      h('circle', { cx: 8, cy: 7, r: 1.9, fill: 'currentColor' }),
      h('rect', { x: 10, y: 12.5, width: 8, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.9 }),
      h('rect', { x: 10, y: 16, width: 5.5, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.55 }),
    )
  }

  /** Build marker for served-bundle verification. */
  const BUILD = '20261023-role-orchestration-0.12.0'

  /**
   * Register the locale dictionaries, the monitoring page, the sidebar glyph,
   * and the composer quick bar.
   * @param ctx - browser services used by these contributions.
   */
  function apply(ctx) {
    injectStyle()
    ctx.effect(() => ctx.locale.register(NS, { zh: T.zh, en: T.en }), 'dsh-spec: dictionaries')
    const t = ctx.locale.bind(NS)

    /** One change ↔ conversation binding store for the panel, dock and notifier. */
    const bindings = createBindingStore()
    /** One (program, task, role) ↔ conversation map for multi-role tasks. */
    const roleBindings = createRoleBindingStore()
    /** Shared provider/model catalog used by the role model picker. */
    const modelDirectories =
      ctx.modelDirectories ?? (typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined)
    const uiSession = typeof ctx.get === 'function' ? ctx.get('uiSession') : ctx.uiSession
    const statusSource = uiSession?.sessionStatus

    /** One workspace source per (cwd, session) pair, shared by the dock and the panel. */
    const sources = new Map()
    const sourceFor = (row) => {
      const key = `${row.cwd}|${typeof row.sessionId === 'string' ? row.sessionId : ''}`
      let source = sources.get(key)
      if (source === undefined) {
        source = createWorkspaceSource(ctx, { cwd: row.cwd, sessionId: row.sessionId })
        sources.set(key, source)
      }
      return source
    }

    /** Wait until the target session's composer dock has mounted. */
    const waitForDock = (target, timeoutMs) =>
      new Promise((resolve) => {
        const started = Date.now()
        const probe = () => {
          if (typeof document === 'undefined') {
            resolve(false)
            return
          }
          const escaped = String(target).replace(/["\\]/g, '')
          if (document.querySelector('[data-dshspec-quickbar][data-dshspec-session="' + escaped + '"]') !== null) {
            resolve(true)
            return
          }
          if (Date.now() - started >= timeoutMs) {
            resolve(false)
            return
          }
          setTimeout(probe, 120)
        }
        probe()
      })

    /**
     * Bring one workspace's conversation on screen and put the command line
     * into its composer draft — never auto-send. An existing session is opened
     * first; only a workspace without any session asks the host to create one.
     * The dock marker tells us the target session has been mounted before we
     * type into the editor.
     */
    const composeFor = (row) => async (line) => {
      // The public conversation input API takes plain multi-line text, which a
      // report prompt needs (the DOM `execCommand` fallback can lose line
      // breaks). It is feature-detected: a composition without `conversation`
      // keeps the previous editor-based behavior.
      let conversationInput
      try {
        conversationInput = typeof ctx.get === 'function' ? ctx.get('conversation')?.input : undefined
      } catch {
        conversationInput = undefined
      }
      /** Fill one resolved session's draft; the DOM editor is the fallback. */
      const fill = (sessionId) => {
        let shell
        try {
          if (conversationInput !== undefined && conversationInput !== null && typeof conversationInput.shell === 'function') {
            shell = conversationInput.shell(sessionId)
          }
        } catch {
          shell = undefined
        }
        if (shell !== undefined && shell !== null && typeof shell.setDraft === 'function') {
          try {
            shell.setDraft(line)
          } catch {
            return fillEditor()
          }
          try {
            if (typeof shell.focus === 'function') shell.focus()
          } catch {
            /* focusing the composer is best effort; the draft is already filled */
          }
          return { ok: true, text: line }
        }
        return fillEditor()
      }
      /** DOM-editor fallback: insert the line without sending it. */
      const fillEditor = () => {
        const inserted = insertIntoComposer(line)
        return inserted === false ? { ok: false, text: t('insertFailed') } : { ok: true, text: line }
      }
      try {
        const existing = [
          ...(Array.isArray(row.sessionIds) ? row.sessionIds : []),
          row.sessionId,
        ].filter((id) => typeof id === 'string')
        for (const candidate of [...new Set(existing)]) {
          if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(candidate)
          if (await waitForDock(candidate, 1800)) return fill(candidate)
        }
        let created
        if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
          const connected = await withTimeout(
            Promise.resolve(ctx.uiWorkspace.connectWorkspace(row.workspaceId)),
            15000,
            '连接工作区',
          )
          if (typeof connected === 'string') created = connected
          else if (connected !== null && typeof connected === 'object') {
            if (typeof connected.sessionId === 'string') created = connected.sessionId
            else if (typeof connected.id === 'string') created = connected.id
          }
        }
        if (typeof created !== 'string') return { ok: false, text: t('switchFailed') }
        if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(created)
        await waitForDock(created, 10000)
        return fill(created)
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /* ------------------------------------------------------------------ *
     * Direct command execution + change ↔ session binding.
     * ------------------------------------------------------------------ */

    /** Whether a session id is still present in the Session Controller. */
    const sessionExists = (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      try {
        const snap = ctx.sessions.list.getSnapshot()
        return snap?.byId?.[sessionId] !== undefined
      } catch {
        return false
      }
    }

    /** Session id from a connectWorkspace / create result. */
    const sessionIdOf = (value) => {
      if (typeof value === 'string') return value
      if (value !== null && typeof value === 'object') {
        if (typeof value.sessionId === 'string') return value.sessionId
        if (typeof value.id === 'string') return value.id
      }
      return undefined
    }

    /** The phase a command line belongs to (binding metadata only). */
    const phaseOfLine = (line) => {
      const match = /^\/opsx-([a-z-]+)/.exec(String(line ?? ''))
      return match === null ? 'command' : match[1]
    }

    /** Create (or reuse the workspace's blank) conversation for one action. */
    const createSessionFor = async (row) => {
      if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
        const connected = await withTimeout(
          Promise.resolve(ctx.uiWorkspace.connectWorkspace(row.workspaceId)),
          20000,
          '创建会话',
        )
        const id = sessionIdOf(connected)
        if (typeof id === 'string') return id
      }
      if (row.workspaceId !== undefined && typeof ctx.sessions?.create === 'function') {
        const id = sessionIdOf(await ctx.sessions.create({ workspaceId: row.workspaceId }))
        if (typeof id === 'string') return id
      }
      if (typeof row.sessionId === 'string' && row.sessionId !== '') return row.sessionId
      throw new Error(t('switchFailed'))
    }

    /**
     * Create a role conversation through the normal workspace path. The
     * low-level `sessions.create` result is not guaranteed to be initialized in
     * the UI; `createSessionFor` uses `uiWorkspace.connectWorkspace` (or the
     * Host fallback) exactly like ordinary panel actions.
     */
    const createRoleSession = async (row) => createSessionFor(row)

    /** Focus one conversation without blocking the command transaction. */
    const openSessionById = (sessionId) => {
      try {
        if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(sessionId)
      } catch {
        /* the command can still run in a background session */
      }
    }

    /** Duplicate-command guard for one conversation (rapid double clicks). */
    const inFlightCommands = new Set()
    const recentChangeActions = new Map()

    /** Host `command.execute` transaction: unknown/malformed lines are explicit failures. */
    const executeCommand = async (sessionId, line) => {
      const result = await withTimeout(
        Promise.resolve(ctx.remote.commands.execute(sessionId, line, [])),
        60000,
        '发送命令',
      )
      if (result === null || typeof result !== 'object') return { ok: false, text: t('commandSendFailed') }
      if (result.ok !== true) {
        return { ok: false, text: result.error?.message ?? t('commandSendFailed') }
      }
      const value = result.value
      if (value === undefined || value === null) return { ok: false, text: `未知命令：${line}` }
      const outcome = value.result
      if (outcome !== null && typeof outcome === 'object' && outcome.kind === 'error') {
        return { ok: false, text: typeof outcome.text === 'string' ? outcome.text : t('commandFailed') }
      }
      return {
        ok: true,
        text: line,
        sessionId,
        resultText: outcome !== null && typeof outcome === 'object' && typeof outcome.text === 'string' ? outcome.text : '',
      }
    }

    /* ---- System notifications ---------------------------------------- */

    let notificationAsked = false
    const deniedNotices = new Set()

    /** Request Notification permission from a user gesture; never throws. */
    const ensureNotificationPermission = () => {
      if (notificationAsked) return
      notificationAsked = true
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'default') {
          Promise.resolve(Notification.requestPermission()).catch(() => {})
        }
      } catch {
        /* notification API unavailable */
      }
    }

    /**
     * Show one OS notification; when the browser blocks it, dispatch an in-app
     * notice so the panel/dock can still tell the user what happened.
     */
    const systemNotify = (title, body, sessionId) => {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const notification = new Notification(title, {
            body,
            tag: `dsh-spec:${sessionId ?? 'workspace'}:${body}`,
            requireInteraction: false,
            silent: false,
          })
          notification.onclick = () => {
            try {
              window.focus()
            } catch {
              /* window focus is best effort */
            }
            if (typeof sessionId === 'string' && sessionId !== '') openSessionById(sessionId)
            try {
              notification.close()
            } catch {
              /* already closed */
            }
          }
          setTimeout(() => {
            try {
              notification.close()
            } catch {
              /* already closed */
            }
          }, 12000)
          return true
        }
      } catch {
        /* fall through to the in-app notice */
      }
      if (deniedNotices.has(title)) return false
      deniedNotices.add(title)
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('dsh-spec:notice', { detail: { title, text: body, sessionId } }))
        }
      } catch {
        /* no DOM */
      }
      return false
    }

    /* ---- Auto-named proposals ---------------------------------------- *
     * `/opsx-propose --auto` lets the AI choose the name itself, so there is
     * no change name to bind at command time. Watch the workspace state for
     * the first change that did not exist before the command and bind that
     * change to the conversation that produced it.
     * ------------------------------------------------------------------ */

    const autoProposeWatchers = new Map()
    const AUTO_PROPOSE_POLL_MS = 3000
    const AUTO_PROPOSE_TIMEOUT_MS = 10 * 60 * 1000
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const watchAutoPropose = async (cwd, sessionId, beforeNames) => {
      const previous = autoProposeWatchers.get(sessionId)
      if (previous !== undefined) previous.cancelled = true
      const record = { cancelled: false }
      autoProposeWatchers.set(sessionId, record)
      const started = Date.now()
      while (!record.cancelled && Date.now() - started < AUTO_PROPOSE_TIMEOUT_MS) {
        await sleep(AUTO_PROPOSE_POLL_MS)
        if (record.cancelled) break
        let snapshot
        try {
          snapshot = await callRoute(ctx, 'state', { cwd }, '读取变更列表')
        } catch {
          continue
        }
        const changes = Array.isArray(snapshot?.changes) ? snapshot.changes : []
        const created = changes.find(
          (change) => change !== null && typeof change === 'object' && typeof change.name === 'string' && !beforeNames.has(change.name),
        )
        if (created !== undefined) {
          bindings.set(cwd, created.name, sessionId, 'propose')
          if (autoProposeWatchers.get(sessionId) === record) autoProposeWatchers.delete(sessionId)
          return
        }
      }
      if (autoProposeWatchers.get(sessionId) === record) autoProposeWatchers.delete(sessionId)
      if (!record.cancelled) systemNotify(t('autoProposeTimeoutTitle'), t('autoProposeTimeoutBody'), sessionId)
    }
    ctx.effect(
      () => () => {
        for (const record of autoProposeWatchers.values()) record.cancelled = true
        autoProposeWatchers.clear()
      },
      'dsh-spec: auto-named proposal watchers',
    )

    /** Find the state source cached for one workspace (no new polling source). */
    const sourceForCwd = (cwd) => {
      for (const source of sources.values()) {
        if (source.cwd === cwd) return source
      }
      return undefined
    }

    /** Notify the bound change when its session completes or asks for permission. */
    const setupNotifications = () => {
      if (statusSource === undefined || typeof statusSource.subscribe !== 'function') return () => {}
      let previous = statusSource.getSnapshot() ?? EMPTY_SESSION_STATUSES
      const unsubscribe = statusSource.subscribe(() => {
        const next = statusSource.getSnapshot() ?? EMPTY_SESSION_STATUSES
        for (const [sessionId, after] of next) {
          const before = previous.get(sessionId)
          if (before === after) continue
          const info = bindings.findSession(sessionId)
          const roleInfo = info === null ? roleBindings.findSession(sessionId) : null
          if ((info === null || info.change === null) && roleInfo === null) continue
          const subject = roleInfo === null ? info.change : `${roleInfo.task} / ${roleInfo.role}`
          const pendingBefore = before?.pendingInteraction
          const pendingNow = after?.pendingInteraction
          if (pendingNow !== undefined && pendingNow !== null && pendingNow.kind !== pendingBefore?.kind) {
            systemNotify(
              roleInfo === null
                ? tx(t, 'notifyPendingTitle', { change: subject })
                : tx(t, 'notifyRolePendingTitle', { task: roleInfo.task, role: roleInfo.role }),
              t('notifyPendingBody'),
              sessionId,
            )
            continue
          }
          if (before?.running === true && after?.running !== true) {
            if (roleInfo !== null) {
              systemNotify(
                tx(t, 'notifyRoleTurnTitle', { task: roleInfo.task, role: roleInfo.role }),
                t('notifyTurnBody'),
                sessionId,
              )
              continue
            }
            const source = sourceForCwd(info.cwd)
            const snapshot = source?.hooks.state.getSnapshot()
            const change = snapshot?.status === 'ready' ? snapshot.changes?.find((item) => item.name === info.change) : undefined
            const complete = change?.isPlanningComplete === true && change?.listStatus === 'complete'
            systemNotify(
              tx(t, complete ? 'notifyDoneTitle' : 'notifyTurnTitle', { change: info.change }),
              complete ? t('notifyDoneBody') : t('notifyTurnBody'),
              sessionId,
            )
          }
        }
        previous = next
      })
      return unsubscribe
    }
    ctx.effect(setupNotifications, 'dsh-spec: completion/permission notifications')

    /**
     * Bind sessions started by typed phase commands (their Host titles are
     * `[阶段] 主题`). This is the fallback that keeps a conversation bound even
     * when it was not started from a panel button.
     */
    const setupTitleBindings = () => {
      const read = () => {
        try {
          const snap = ctx.sessions.list.getSnapshot()
          const rows = snap?.byId !== undefined && snap.byId !== null ? Object.values(snap.byId) : Array.isArray(snap) ? snap : []
          for (const row of rows) {
            if (row === null || typeof row !== 'object') continue
            const sessionId = typeof row.id === 'string' ? row.id : typeof row.sessionId === 'string' ? row.sessionId : ''
            const cwd = typeof row.cwd === 'string' ? row.cwd : ''
            if (sessionId === '' || cwd === '') continue
            const title =
              typeof row.title === 'string'
                ? row.title
                : typeof row.projectionValues?.title === 'string'
                  ? row.projectionValues.title
                  : ''
            if (title === '') continue
            const match = /^\[(探索|提案|实施|更新|同步|归档|已同步|已归档)\]\s*(.*)$/.exec(title)
            if (match === null) continue
            const phase = match[1]
            const subject = match[2].trim()
            if (phase === '探索') {
              bindings.setExplore(cwd, sessionId)
              continue
            }
            if (phase === '已同步' || phase === '已归档') continue
            if (subject === '' || subject.includes('…') || !/^[a-z0-9][a-z0-9-]*$/.test(subject)) continue
            bindings.set(cwd, subject, sessionId, phase)
          }
        } catch {
          /* session store unavailable: bindings stay as they are */
        }
      }
      read()
      return ctx.sessions.list.subscribe(read)
    }
    ctx.effect(setupTitleBindings, 'dsh-spec: bind sessions from phase titles')

    /**
     * Resolve the one conversation for one change (or explore action), bind it,
     * open it and execute the command line immediately. `preferredSessionId` is
     * the dock's current conversation; it is reused only when it is not already
     * bound to a different change.
     */
    const runFor = (row, preferredSessionId) => async (line, changeName) => {
      ensureNotificationPermission()
      const change = typeof changeName === 'string' && changeName !== '' ? changeName : null
      const isAutoPropose = /^\/opsx-propose\s+--auto(?:\s|$)/.test(String(line ?? ''))
      try {
        // The change name is chosen by the model, so capture the current names
        // before the command and bind the first new one afterwards.
        let autoBaseline = null
        if (isAutoPropose) {
          try {
            const before = await callRoute(ctx, 'state', { cwd: row.cwd }, '读取变更列表')
            autoBaseline = new Set(
              (Array.isArray(before?.changes) ? before.changes : [])
                .map((entry) => entry?.name)
                .filter((name) => typeof name === 'string' && name !== ''),
            )
          } catch {
            autoBaseline = null
          }
        }
        let sessionId = ''
        if (change !== null) {
          const bound = bindings.get(row.cwd, change)
          if (bound !== null && sessionExists(bound.sessionId)) {
            sessionId = bound.sessionId
          } else {
            const candidate = typeof preferredSessionId === 'string' && preferredSessionId !== '' ? preferredSessionId : row.sessionId
            if (typeof candidate === 'string' && sessionExists(candidate)) {
              const owner = bindings.changeForSession(row.cwd, candidate)
              const info = bindings.findSession(candidate)
              if (owner === null && (info === null || info.change === null)) sessionId = candidate
            }
            if (sessionId === '') sessionId = await createSessionFor(row)
            bindings.set(row.cwd, change, sessionId, phaseOfLine(line))
          }
        } else {
          const candidate = typeof preferredSessionId === 'string' && preferredSessionId !== '' ? preferredSessionId : row.sessionId
          const isExplore = /^\/opsx-explore(?:\s|$)/.test(String(line ?? ''))
          if (isExplore || isAutoPropose) {
            const candidateLive = statusSource?.getSnapshot?.().get?.(candidate)
            const candidateBusy =
              candidateLive?.running === true ||
              (candidateLive?.pendingInteraction !== undefined && candidateLive?.pendingInteraction !== null)
            if (
              typeof candidate === 'string' &&
              sessionExists(candidate) &&
              bindings.changeForSession(row.cwd, candidate) === null &&
              candidateBusy !== true
            ) {
              sessionId = candidate
            }
            if (sessionId === '') {
              const explore = bindings.getExplore(row.cwd)
              if (
                explore !== null &&
                sessionExists(explore.sessionId) &&
                bindings.changeForSession(row.cwd, explore.sessionId) === null
              ) {
                const live = statusSource?.getSnapshot?.().get?.(explore.sessionId)
                const busy = live?.running === true || (live?.pendingInteraction !== undefined && live?.pendingInteraction !== null)
                if (!busy) sessionId = explore.sessionId
              }
            }
            if (sessionId === '') sessionId = await createSessionFor(row)
            if (isExplore) bindings.setExplore(row.cwd, sessionId)
          } else {
            // Direct commands such as /opsx-status may run in the current
            // conversation even when it is bound to a change; they neither
            // create nor steal a binding.
            if (typeof candidate === 'string' && sessionExists(candidate)) sessionId = candidate
            if (sessionId === '') sessionId = await createSessionFor(row)
          }
        }
        // Defense in depth: the buttons are already disabled while the bound
        // conversation is busy, but a stale/rapid click must not stack a second
        // planning or implementation turn on the same change.
        if (change !== null && statusSource !== undefined && typeof statusSource.getSnapshot === 'function') {
          const live = statusSource.getSnapshot()?.get?.(sessionId)
          if (live?.running === true || (live?.pendingInteraction !== undefined && live?.pendingInteraction !== null)) {
            return { ok: false, text: live?.pendingInteraction !== undefined && live?.pendingInteraction !== null ? t('statusWaitHint') : t('statusRunHint') }
          }
        }
        if (change !== null) {
          const last = recentChangeActions.get(sessionId) ?? 0
          if (inFlightCommands.has(sessionId) || Date.now() - last < 1500) {
            return { ok: false, text: t('statusRunHint') }
          }
        }
        if (inFlightCommands.has(sessionId)) return { ok: false, text: t('statusRunHint') }
        inFlightCommands.add(sessionId)
        try {
          openSessionById(sessionId)
          // Let navigation retain the Session before the host command transaction
          // addresses it; the delay is tiny and only on an explicit user action.
          await new Promise((resolve) => setTimeout(resolve, 50))
          const outcome = await executeCommand(sessionId, line)
          if (change !== null && outcome.ok === true) recentChangeActions.set(sessionId, Date.now())
          if (isAutoPropose && autoBaseline !== null && outcome.ok === true) {
            void watchAutoPropose(row.cwd, sessionId, autoBaseline)
          }
          return outcome
        } finally {
          inFlightCommands.delete(sessionId)
        }
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Start a NEW session for the document's workspace and carry the document
     * into its draft as plain text (the public input API accepts plain text
     * only; structured @ references are internal to the shell). The panel's
     * doc viewer shows this as「去工作区对齐」.
     */
    /**
     * Start one (program, task, role) conversation: create/reuse its own
     * session, apply the configured model, then execute `/opsx-role`.
     */
    const startRoleFor = (row) => async (program, task, role) => {
      ensureNotificationPermission()
      try {
        let binding = roleBindings.get(row.cwd, program.id, task.id, role)
        if (binding !== null && !sessionExists(binding.sessionId)) {
          roleBindings.remove(row.cwd, program.id, task.id, role)
          binding = null
        }
        let sessionId = binding?.sessionId ?? ''
        if (sessionId === '') {
          sessionId = await createRoleSession(row)
          roleBindings.set(row.cwd, program.id, task.id, role, sessionId)
        }
        openSessionById(sessionId)
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (statusSource !== undefined && typeof statusSource.getSnapshot === 'function') {
          const live = statusSource.getSnapshot()?.get?.(sessionId)
          if (live?.running === true || (live?.pendingInteraction !== undefined && live?.pendingInteraction !== null)) {
            return {
              ok: false,
              text:
                live?.pendingInteraction !== undefined && live?.pendingInteraction !== null
                  ? t('statusWaitHint')
                  : t('statusRunHint'),
            }
          }
        }
        const model = program.roles?.[role]
        if (model?.provider && model?.model) {
          if (typeof ctx.sessions?.selectModel !== 'function') {
            return { ok: false, text: '当前 DSH 组合不支持按会话选择模型' }
          }
          try {
            const selected = await withTimeout(
              Promise.resolve(
                ctx.sessions.selectModel({ sessionId, provider: model.provider, model: model.model }),
              ),
              20000,
              '选择模型',
            )
            if (selected !== null && selected !== undefined && selected.ok === false) {
              return { ok: false, text: selected.error?.message ?? selected.error?.code ?? '模型选择失败' }
            }
          } catch (failure) {
            return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
          }
        } else if (model?.provider || model?.model) {
          return { ok: false, text: '角色模型配置不完整，请填写 provider/model' }
        }
        // Reuse the ordinary command transaction: it opens the target session,
        // applies the 50ms navigation delay, and routes the slash command.
        const outcome = await runFor(row, sessionId)(`/opsx-role ${program.id} ${task.id} ${role}`)
        if (outcome.ok === true) void sourceFor(row).refresh()
        return outcome
      } catch (failure) {
        return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
      }
    }

    const alignFor = (row, doc) => async () => {
      const relative = doc?.relPath ?? doc?.path ?? ''
      const prompt = t('alignDraft').replace('{path}', relative)
      try {
        if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.startSession === 'function') {
          await withTimeout(
            Promise.resolve(ctx.uiWorkspace.startSession(row.workspaceId, { prompt, clearPreviousDraft: true })),
            15000,
            '新建会话',
          )
          return { ok: true, text: prompt }
        }
        return await composeFor(row)(prompt)
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Session-less init for a panel workspace row: post the workspace path to
     * the Host's /dsh-spec route, which validates it against the registered
     * workspaces, writes the native scaffold and reports the created items.
     */
    const initFor = async (cwd) => initWorkspace(ctx, cwd)

    /**
     * Goal + role models -> planner prompt -> `.plans/<id>.json` -> program.
     *
     * The planner prompt runs through the same `runFor` path as every other
     * panel command, so it uses the current conversation (with its selected
     * model) or the normal blank-session creation path. The Host still validates
     * the file and creates the change skeletons; the planner never writes them.
     */
    const planProgramFor = (row) => async ({ goal, roles }) => {
      const draftId = `auto-${Date.now().toString(36)}`
      try {
        await callRoute(
          ctx,
          'orchestration-draft',
          { cwd: row.cwd, draft: { id: draftId, goal, roles } },
          '创建规划草稿',
        )
        const command = await runFor(row)(`/opsx-plan ${draftId}`)
        if (command.ok !== true) return command
        const deadline = Date.now() + 5 * 60 * 1000
        let lastError = ''
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          let value
          try {
            value = await callRoute(ctx, 'orchestration-plan', { cwd: row.cwd, id: draftId }, '读取任务拆分')
          } catch {
            continue
          }
          if (typeof value?.error === 'string' && value.error !== '') lastError = value.error
          if (value?.plan !== null && value?.plan !== undefined) {
            await callRoute(
              ctx,
              'orchestration-create',
              {
                cwd: row.cwd,
                program: {
                  id: draftId,
                  title: value.plan.title,
                  goal,
                  roles,
                  tasks: value.plan.tasks,
                },
              },
              '创建多角色任务',
            )
            await sourceFor(row).refresh()
            return { ok: true, id: draftId }
          }
        }
        return {
          ok: false,
          text:
            lastError === ''
              ? t('orchestrationPlanTimeout')
              : `${t('orchestrationPlanFailed')}：${lastError}`,
        }
      } catch (failure) {
        return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
      }
    }

    /** Toggle the PM auto-driver for one program. */
    const setAutoFor = (row) => async (program, auto) => {
      try {
        await callRoute(
          ctx,
          'orchestration-auto',
          { cwd: row.cwd, program: program.id, auto: auto === true },
          '切换自动推进',
        )
        await sourceFor(row).refresh()
        return { ok: true }
      } catch (failure) {
        return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
      }
    }

    /** Run one PM oversight turn in the current planner/conversation path. */
    const pmReviewFor = (row) => async (program) => {
      try {
        const outcome = await runFor(row)(`/opsx-pm ${program.id}`)
        if (outcome?.ok !== false) await sourceFor(row).refresh()
        return outcome
      } catch (failure) {
        return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
      }
    }

    /** Update role provider/model assignments for one program. */
    const updateRolesFor = (row) => async (program, roles) => {
      try {
        await callRoute(
          ctx,
          'orchestration-roles',
          { cwd: row.cwd, program: program.id, roles },
          '更新角色模型',
        )
        await sourceFor(row).refresh()
        return { ok: true }
      } catch (failure) {
        return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
      }
    }

    /** Record final user acceptance for one child task. */
    const acceptTaskFor = (row) => async (program, task, accepted) => {
      try {
        await callRoute(
          ctx,
          'orchestration-accept',
          { cwd: row.cwd, program: program.id, task: task.id, accepted: accepted === true },
          '验收',
        )
        await sourceFor(row).refresh()
        return { ok: true }
      } catch (failure) {
        return { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
      }
    }

    /** Stable rows snapshot for the panel: recomputed only when a store changes. */
    let lastRaw
    let lastRows = []
    const rowsSource = {
      subscribe: (listener) => ctx.workspaces.list.subscribe(listener),
      getSnapshot: () => {
        const raw = ctx.workspaces.list.getSnapshot()
        if (raw !== lastRaw) {
          lastRaw = raw
          lastRows = workspaceRows(ctx)
        }
        return lastRows
      },
    }

    const refreshAll = async () => {
      const rows = rowsSource.getSnapshot()
      await Promise.all(rows.map((row) => sourceFor(row).refresh()))
    }

    /**
     * Web-client change picker: decorate the five change-taking host commands so
     * a change is selected from a list (same shell as `/model`) instead of being
     * typed. Client-only and self-contained behind its own inject — a composition
     * without `commandUi` / `conversation` keeps the panel, quick bar and host
     * commands working exactly as before.
     */
    ctx.inject(['commandUi', 'conversation'], (scope) => {
      const commandUi = scope.get('commandUi')
      const conversation = scope.get('conversation')
      if (commandUi === undefined || typeof commandUi.decorate !== 'function') return
      if (conversation === undefined || conversation.input === undefined) return

      /** Synchronous last-known workspace state for one session (picker availability). */
      const stateFor = (sessionId) => {
        const row = rowForSession(ctx, sessionId)
        if (row === undefined) return null
        return sourceFor(row).hooks.state.getSnapshot()
      }

      /** Fresh workspace state for the picker rows; the popup owns the loading/error face. */
      const refreshFor = async (sessionId) => {
        const row = rowForSession(ctx, sessionId)
        if (row === undefined) throw new Error(t('pickerLoadFailed'))
        const source = sourceFor(row)
        await source.refresh()
        return source.hooks.state.getSnapshot()
      }

      /** Fill the draft with the picked command line — never execute and never send it. */
      const fillComposer = (sessionId, line) => {
        try {
          const shell = conversation.input.shell(sessionId)
          if (shell === undefined || shell === null || typeof shell.setDraft !== 'function') throw new Error('input shell unavailable')
          shell.setDraft(line)
          if (typeof shell.focus === 'function') shell.focus()
          return true
        } catch {
          return replaceComposerText(line)
        }
      }

      for (const command of CHANGE_PICKER_COMMANDS) {
        const decoration = {
          name: command,
          available: (session) => changePickerAvailable(stateFor(session?.sessionId)),
          ui: {
            kind: 'popupSelect',
            searchMode: 'substring',
            searchLabels: () => ({
              placeholder: t('pickerSearch'),
              empty: t('pickerEmpty'),
              noResults: t('pickerNoResults'),
            }),
            options: async (session) => changePickerOptions(await refreshFor(session?.sessionId), t),
            onSelect: (option, session) => {
              fillComposer(session?.sessionId, changePickerLine(command, option?.name))
            },
          },
        }
        try {
          scope.effect(() => commandUi.decorate(decoration), `dsh-spec: change picker /${command}`)
        } catch (error) {
          console.warn(`[dsh-spec] change picker unavailable for /${command}:`, error)
        }
      }
    })

    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({
        t,
        rowsSource,
        sourceFor,
        runFor,
        composeFor,
        startRoleFor: (row, program, task, role) => startRoleFor(row)(program, task, role),
        planProgramFor: (row, payload) => planProgramFor(row)(payload),
        acceptTaskFor: (row, program, task, accepted) => acceptTaskFor(row)(program, task, accepted),
        updateRolesFor: (row, program, roles) => updateRolesFor(row)(program, roles),
        setAutoFor: (row, program, auto) => setAutoFor(row)(program, auto),
        pmReviewFor: (row, program) => pmReviewFor(row)(program),
        alignFor,
        initFor,
        onRefreshSessions: refreshAll,
        bindings,
        roleBindings,
        modelDirectories,
        statusSource,
        openSession: (sessionId) => openSessionById(sessionId),
        sessionExists,
      }),
    }, OpenspecPanel))

    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 12,
      locale: NS,
      label: () => t('panel'),
    }, PanelIcon))

    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: DOCK_ID,
      order: 5,
      locale: NS,
      inject: (sessionId) => {
        const row = rowForSession(ctx, sessionId)
        const source = row === undefined ? undefined : sourceFor(row)
        return {
          sessionId,
          state: source === undefined ? undefined : source.hooks.state,
          source,
          init: initFor,
          bindings,
          statusSource,
          sessionExists,
          run: row === undefined ? undefined : runFor(row, sessionId),
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        }
      },
    }, QuickBar))

    // Pre-conversation seat: the shell renders `conversation.hero.options` at
    // the right end of the workspace chip row, and ONLY while the conversation
    // is still blank (the hero). Once the first message starts, the hero row
    // unmounts and the composer dock above takes over — the two seats are
    // mutually exclusive by construction, so the bar never renders twice.
    ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
      name: 'conversation.hero.options',
      id: DOCK_ID,
      order: 5,
      locale: NS,
      inject: (sessionId) => {
        const row = rowForSession(ctx, sessionId)
        const source = row === undefined ? undefined : sourceFor(row)
        return {
          sessionId,
          state: source === undefined ? undefined : source.hooks.state,
          source,
          init: initFor,
          heroOnly: true,
          bindings,
          statusSource,
          sessionExists,
          run: row === undefined ? undefined : runFor(row, sessionId),
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        }
      },
    }, QuickBar))
  }

  return { inject: ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.commands', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'connection', 'layout', 'modelDirectories'], apply }
}

window.__ModuleLoader__.load({
  id: 'dsh-spec',
  factory: (require) => {
    const plugin = createOpenSpecPlugin(require)
    return { inject: plugin.inject, apply: plugin.apply }
  },
})
