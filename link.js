/**
 * Pure linking logic for Session Link: which sessions form a link scope, how a
 * link key is parsed, and the exact model-facing wording.
 *
 * A "link" is a named set of sessions that may talk to each other. Nothing here
 * touches Cordis or the filesystem, so `index.js` owns the wiring while this
 * module owns the arithmetic and the wording — both can therefore be exercised
 * by a plain Node test without a running Harness.
 *
 * The scope has to be editable by a human with no agent in the loop, so every
 * rule below is expressed in terms of plain data: a link id, a set of session
 * ids, and a default link. An agent can read and edit the same data through
 * tools; neither path can produce a state the other cannot read.
 *
 * @module dsh-interlink/link
 */

/** Cap on a `notice` source summary, matching the harness context-summary bound. */
export const SUMMARY_MAX = 120

/** Longest session message body accepted, so one relay cannot flood a peer. */
export const MAX_MESSAGE_CHARS = 8000

/** Longest custom link id; ids appear in tool arguments, so they stay short. */
export const MAX_LINK_ID = 40

/** The legacy fallback link id, kept for the reserved-name set and store defaults. */
export const DEFAULT_LINK_ID = 'main'

/** Fallback when a config value is missing or malformed. */
export const DEFAULT_MAX_MESSAGE_CHARS = MAX_MESSAGE_CHARS

/** Rules an explicitly named link id may not shadow, because links address them. */
export const RESERVED_LINKS = Object.freeze(['scope', 'session', 'auto', 'default', 'lobby'])

/**
 * Normalize a user-supplied link id.
 *
 * Lowercase, dash-separated, no leading or trailing separators: the same grammar
 * the loader uses for record names, so an id is always safe to print in a tool
 * description, a route query, or a store key.
 *
 * @param {unknown} value - anything a caller supplied.
 * @returns {string | undefined} the normalized id, or `undefined` when unusable.
 */
export function normalizeLinkId(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_LINK_ID) return undefined
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) return undefined
  if (trimmed.includes('..')) return undefined
  return trimmed
}

/**
 * Validate one session id as it appears in the store and on the wire.
 *
 * Session ids in this harness are `session-<uuid>`, but the store must not
 * assume that: an id is a non-empty token, and that is all the linkage needs.
 *
 * @param {unknown} value - candidate id.
 * @returns {boolean} whether it is a usable session id.
 */
export function isSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\s/.test(value)
}

/**
 * Clip one summary to the harness bound.
 *
 * @param {string} text - the untrimmed summary.
 * @returns {string} at most {@link SUMMARY_MAX} characters.
 */
export function clipSummary(text) {
  if (text.length <= SUMMARY_MAX) return text
  return `${text.slice(0, SUMMARY_MAX - 1)}…`
}

/**
 * Build the durable one-line summary of a relay, for `notice`-style sources.
 *
 * @param {string} fromId - sender session id.
 * @param {string} toId - recipient session id.
 * @param {string} linkId - link the relay travelled on.
 * @returns {string} the clipped summary.
 */
export function relaySummary(fromId, toId, linkId) {
  return clipSummary(`link ${linkId}: ${shortId(fromId)} → ${shortId(toId)}`)
}

/**
 * Shorten a session id for display: a session id is long and the interesting
 * part is its head.
 *
 * @param {string} sessionId - the full id.
 * @returns {string} at most 12 characters of it.
 */
export function shortId(sessionId) {
  const text = String(sessionId)
  return text.length <= 14 ? text : text.slice(0, 14)
}

/**
 * Decide which link one session belongs to.
 *
 * Precedence, most specific first:
 * 1. `overrides` — a value a human or an agent recorded for this exact session;
 * 2. `auto` — when enabled, one link per working directory, so two sessions in
 *    the same project share a link without anyone naming it;
 * 3. `undefined` — no rule names the session, so it is on no link at all.
 *
 * Off-by-default is deliberate: a session that nobody deliberately grouped
 * must not be reachable by every other session in the profile. A link is a
 * statement someone made, not a consequence of opening a folder, so until an
 * id is named (or the folder rule is turned on) this session has no peers.
 *
 * A session whose cwd is unknown never takes the `auto` rule: an empty cwd is
 * not a project, and grouping every cwd-less session together would silently
 * connect unrelated work.
 *
 * @param {object} input - the decision inputs.
 * @param {string} input.sessionId - the session to classify.
 * @param {string} [input.cwd] - its working directory, when known.
 * @param {Map<string, string> | Record<string, string>} [input.overrides] - recorded per-session links.
 * @param {boolean} [input.auto] - whether the cwd rule is enabled.
 * @returns {string | undefined} the link id, or `undefined` when the session is on no link.
 */
export function linkOf(input) {
  return linksOf(input)[0]
}

/**
 * Every link one session is on.
 *
 * A session may join several links at once, so reachability is a set rather
 * than a value. The order is recorded links first (as stored), then the
 * directory rule when nothing was recorded and `auto` is on.
 *
 * @param {object} input - the decision inputs.
 * @param {string} input.sessionId - the session to classify.
 * @param {string} [input.cwd] - its working directory, when known.
 * @param {Map<string, string | string[]> | Record<string, string | string[]>} [input.overrides] - recorded per-session links.
 * @param {boolean} [input.auto] - whether the cwd rule is enabled.
 * @returns {string[]} its links, empty when it is on none.
 */
export function linksOf(input) {
  const { sessionId, cwd, auto } = input
  const recorded = overridesOf(input.overrides, sessionId)
  if (recorded.length > 0) return recorded
  if (auto === true && typeof cwd === 'string' && cwd.length > 0) return [cwdLinkId(cwd)]
  return []
}

/**
 * Deterministic link id for one working directory.
 *
 * Readable and stable across restarts: the last path segment slugified, plus a
 * short hash of the full normalized path so two `src` directories never merge.
 *
 * @param {string} cwd - absolute working directory.
 * @returns {string} the link id.
 */
export function cwdLinkId(cwd) {
  const normalized = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  const last = segments.at(-1) ?? 'root'
  const slug = last.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'root'
  return `dir-${slug}-${hash32(normalized)}`
}

/**
 * FNV-1a, base 36. Small, synchronous, and stable across processes — the only
 * requirement for a link id suffix.
 *
 * @param {string} text - input.
 * @returns {string} eight base-36 characters at most.
 */
export function hash32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** Normalize a working directory for comparison, the way `cwdLinkId` does. */
function normalizeCwd(cwd) {
  return String(cwd ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * A stable project key for one working directory.
 *
 * Two sessions belong to the same project exactly when their normalized cwd is
 * equal. An empty cwd is *not* a project: `''` is returned so cwd-less sessions
 * never merge with each other or with any real directory, matching the `auto`
 * rule in {@link linkOf}.
 *
 * @param {unknown} cwd - the working directory.
 * @returns {string} the project key, or `''` when unknown.
 */
export function projectOf(cwd) {
  const normalized = normalizeCwd(cwd)
  return normalized.length === 0 ? '' : normalized
}

/**
 * Whether two sessions may relay to each other under the `crossProject` rule.
 *
 * When `crossProject` is enabled every directory is one open scope. Otherwise a
 * relay is only allowed between sessions of the same project, where "project"
 * is the normalized working directory. Two unknown (`''`) directories count as
 * the same project so the default link keeps working for cwd-less sessions;
 * an unknown and a known directory are treated as different.
 *
 * @param {object} input - the decision.
 * @param {unknown} input.focusCwd - the asking session's working directory.
 * @param {unknown} input.peerCwd - the candidate peer's working directory.
 * @param {boolean} [input.crossProject] - whether cross-project relays are on.
 * @returns {boolean} whether the pair is allowed to talk.
 */
export function sameProject({ focusCwd, peerCwd, crossProject }) {
  if (crossProject === true) return true
  return projectOf(focusCwd) === projectOf(peerCwd)
}

/**
 * Read one config value handed to the plugin by Cordis.
 *
 * A .volatile() field is NOT a plain value. Cordis passes a live reference
 * and hot-updates that same object in place when Settings writes it (the
 * loader calls updateVolatile(ref, source), which does ref[write](source.get())
 * and does not re-run apply). So config.crossProject === true is always false
 * on such a reference, and a value cached at startup never changes. Unwrap on
 * every read - tools, the context line, and the header all call through here
 * on each request - so a saved switch takes effect without a restart.
 *
 * Volatile references expose .get(); ordinary resolved values (booleans,
 * strings, numbers) pass straight through.
 *
 * @param {unknown} value - a resolved config value or a volatile reference.
 * @returns {unknown} the current value.
 */
export function configValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * Read an optional Host service from a plugin context.
 *
 * A profile may not mount every service a plugin can use — `sessionQuery` is
 * absent in a deployment without the session-query bundle. Newer cordis
 * releases throw `cannot get property "…" without inject` on a plain property
 * read of an undeclared service, so an optional dependency has to be resolved
 * through `ctx.get()`, which answers `undefined` instead. Contexts that do not
 * expose `get()` (the test fakes, and older host versions) fall back to a plain
 * property read.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} name - the service name.
 * @returns {unknown} the service, or `undefined` when this profile lacks it.
 */
export function serviceOf(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    // strict=false answers a provided-but-not-yet-active service instead of
    // undefined, which is what a plugin reading it at apply time needs.
    try {
      return ctx.get(name, false)
    } catch {
      return ctx.get(name)
    }
  }
  return ctx[name]
}

/**
 * Read one session's recorded links from a Map or a plain object.
 *
 * A session may be on several links, so the value is either a bare string (the
 * older shape) or an array. Both are read here, because a store written by any
 * older version must keep working.
 *
 * @param {Map<string, string | string[]> | Record<string, string | string[]>} overrides - recorded assignments.
 * @param {string} sessionId - the session.
 * @returns {string[]} its links, empty when none were recorded.
 */
function overridesOf(overrides, sessionId) {
  if (overrides === undefined || overrides === null) return []
  const value = overrides instanceof Map ? overrides.get(sessionId) : overrides[sessionId]
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry.length > 0)
  return []
}

/**
 * Group sessions by link id.
 *
 * Sessions on no link are left out instead of collected under one bucket: an
 * unlinked session is not a group, and folding every unlinked session together
 * would recreate exactly the implicit shared scope this model removed.
 *
 * @param {string[]} sessionIds - the candidate sessions.
 * @param {object} input - the same inputs {@link linkOf} takes, minus the id.
 * @returns {Map<string, string[]>} link id → member ids, in stable order.
 */
export function groupByLink(sessionIds, input) {
  const groups = new Map()
  for (const sessionId of sessionIds) {
    const linkId = linkOf({ ...input, sessionId })
    if (linkId === undefined) continue
    const members = groups.get(linkId)
    if (members === undefined) groups.set(linkId, [sessionId])
    else members.push(sessionId)
  }
  return groups
}

/**
 * The peers one session may talk to.
 *
 * A link is symmetric and transitive by construction — it is one set — so the
 * answer is "every other member of my link". A session never appears in its own
 * peer list, and a member that no longer exists is filtered by the caller (this
 * function only knows ids).
 *
 * @param {string} sessionId - the asking session.
 * @param {string[]} members - every session in its link.
 * @returns {string[]} the other members.
 */
export function peersOf(sessionId, members) {
  return members.filter((member) => member !== sessionId)
}

/**
 * Resolve a user-typed target to one session id within a peer list.
 *
 * Accepts the full id or an unambiguous prefix, because a session id is long
 * enough that typing it in full is not a reasonable expectation. An ambiguous
 * prefix is an error rather than a guess: relaying a message to the wrong
 * session is worse than asking again.
 *
 * @param {string} target - what the user or agent typed.
 * @param {string[]} candidates - the peers it may name.
 * @returns {{ kind: 'exact', id: string } | { kind: 'ambiguous', matches: string[] } | { kind: 'missing' }} the resolution.
 */
export function resolveTarget(target, candidates) {
  const text = typeof target === 'string' ? target.trim() : ''
  if (text.length === 0) return /** @type {const} */ ({ kind: 'missing' })
  if (candidates.includes(text)) return /** @type {const} */ ({ kind: 'exact', id: text })
  const matches = candidates.filter((candidate) => candidate.startsWith(text))
  if (matches.length === 1) return /** @type {const} */ ({ kind: 'exact', id: matches[0] })
  if (matches.length > 1) return /** @type {const} */ ({ kind: 'ambiguous', matches })
  return /** @type {const} */ ({ kind: 'missing' })
}

/**
 * Validate an outgoing message body.
 *
 * @param {unknown} text - the candidate body.
 * @returns {{ kind: 'ok', text: string } | { kind: 'invalid', reason: string }} the verdict.
 */
export function validateMessage(text) {
  if (typeof text !== 'string') return { kind: 'invalid', reason: 'a message must be a string' }
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: 'invalid', reason: 'a message must not be empty' }
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return { kind: 'invalid', reason: `a message must be at most ${MAX_MESSAGE_CHARS} characters` }
  }
  return { kind: 'ok', text: trimmed }
}

/**
 * Whether two sessions are linked, given resolved link ids.
 *
 * An unlinked session (`undefined`) matches nothing, not even another unlinked
 * one: "on no link" is the absence of a scope, never a shared scope.
 *
 * @param {string} a - one link id, or `undefined` for no link.
 * @param {string} b - the other link id, or `undefined` for no link.
 * @returns {boolean} whether they share a link.
 */
export function sameLink(a, b) {
  return typeof a === 'string' && a.length > 0 && a === b
}

/**
 * The framing a relayed message carries into the recipient's transcript.
 *
 * Attribution is explicit and repeated: the recipient must be able to tell a
 * peer's message from its own human's input without inferring anything from
 * ordering. The body is delimited so a body that itself looks like a framing
 * line cannot pass for one.
 *
 * @param {object} input - the relay facts.
 * @param {string} input.fromId - sender session id.
 * @param {string} [input.fromTitle] - sender session title, when known.
 * @param {string} [input.fromCwd] - sender working directory, when known.
 * @param {string} input.linkId - the link the relay travelled on.
 * @param {string} input.body - the message body.
 * @param {string} [input.language] - `'en'` or `'zh'`.
 * @returns {string} the model-facing text.
 */
export function relayText(input) {
  const { fromId, fromTitle, fromCwd, linkId, body, language } = input
  const who = describePeer({ id: fromId, title: fromTitle, cwd: fromCwd }, language)
  if (language === 'zh') {
    return [
      `[会话互联] ${who}（链路 ${linkId}）发来一条消息：`,
      '<<<',
      body,
      '>>>',
      '这是一条来自另一个会话的输入。请按其中要求处理；需要回复时用 send_session_message 发回给对方。',
    ].join('\n')
  }
  return [
    `[Session Link] ${who} (link ${linkId}) sent a message:`,
    '<<<',
    body,
    '>>>',
    'This input came from another session. Act on it; reply with send_session_message if a reply is needed.',
  ].join('\n')
}

/**
 * Human-readable identity of one peer session.
 *
 * A session id alone tells a model nothing about who it is talking to, so the
 * title and the working directory ride along whenever the host knows them.
 *
 * @param {object} peer - the session facts.
 * @param {string} peer.id - session id.
 * @param {string} [peer.title] - session title.
 * @param {string} [peer.cwd] - working directory.
 * @param {string} [language] - `'en'` or `'zh'`.
 * @returns {string} the label.
 */
export function describePeer(peer, language) {
  const title = typeof peer.title === 'string' && peer.title.trim().length > 0 ? peer.title.trim() : undefined
  const parts = []
  if (title !== undefined) parts.push(title.length > 60 ? `${title.slice(0, 59)}…` : title)
  parts.push(shortId(peer.id))
  if (typeof peer.cwd === 'string' && peer.cwd.length > 0) parts.push(baseName(peer.cwd))
  return parts.join(language === 'zh' ? '，' : ', ')
}

/**
 * Last path segment, for display.
 *
 * @param {string} path - a filesystem path.
 * @returns {string} its final segment.
 */
export function baseName(path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/**
 * Build the standing runtime-context line that tells an agent who its peers are.
 *
 * It is recomputed on every prompt assembly, so a link edit takes effect on the
 * next step without any bookkeeping. It stays empty when the agent has no peer:
 * a line saying "you are alone" on every step is noise, and an isolated session
 * must not be nudged to invent recipients.
 *
 * @param {object} input - the facts.
 * @param {string} input.linkId - this session's link.
 * @param {Array<object>} input.peers - `{ id, title, cwd }` for each peer.
 * @param {string} [input.language] - `'en'` or `'zh'`.
 * @returns {string} the context line, or `''` when it should not be emitted.
 */
export function contextText(input) {
  const { linkId, peers, language } = input
  if (!Array.isArray(peers) || peers.length === 0) return ''
  if (language === 'zh') {
    return [
      `会话互联：本会话在链路 ${linkId} 上，同链路还有 ${peers.length} 个会话——${peers.map((peer) => describePeer(peer, 'zh')).join('；')}。`,
      '用 send_session_message 把消息发给其中任意一个（可以是 id、标题或 id 前缀），用 list_session_links 查看当前链路划分。',
      '对方发来的消息会以「[会话互联]」开头出现在你的输入里。',
    ].join('\n')
  }
  return [
    `Session Link: this session is on link ${linkId}, together with ${peers.length} other session(s) — ${peers.map((peer) => describePeer(peer, 'en')).join('; ')}.`,
    'Use send_session_message to message any of them (by id, title, or id prefix), and list_session_links to see the current division.',
    'Messages from a peer arrive as input starting with "[Session Link]".',
  ].join('\n')
}

/**
 * The tool description shared by both relays, so the two never drift.
 *
 * @param {string[]} linked - ids of the sessions this agent may message.
 * @param {string} linkId - this session's link.
 * @param {string} [language] - `'en'` or `'zh'`.
 * @returns {string} the description.
 */
export function sendDescription(linked, linkId, language) {
  const list = linked.length === 0 ? 'none' : linked.map(shortId).join(', ')
  if (language === 'zh') {
    return `给另一个会话发一条消息。当前链路 "${linkId}" 里可发的会话：${list}。目标可以是 id、标题或不产生歧义的 id 前缀。对方会在下一次输入里收到这条消息，并以「[会话互联]」标出来源。发完立即返回，不等对方处理完。`
  }
  return `Send a message to another session. Reachable sessions on link "${linkId}": ${list}. The target may be an id, a title, or an unambiguous id prefix. The recipient receives it as input marked "[Session Link]" and answers on its own schedule; this tool returns as soon as the message is accepted, without waiting for a reply.`
}
