/**
 * Session Link's catalogue: one answer to "which sessions exist, which link is
 * each one on, and who may message whom".
 *
 * Every surface needs the same three answers — the browser panel, the agent's
 * tools, and the standing context line — so they share this module. A
 * disagreement between them would be a scope bug: the panel would draw two
 * sessions as connected while `send_session_message` refused to relay. One
 * implementation, three consumers.
 *
 * Nothing here touches Cordis. The Host services arrive as arguments and every
 * result is plain JSON, so the whole catalogue is testable with object fakes.
 *
 * Two performance facts shape the code:
 *
 * - listing sessions is cheap (headers only), but reading each session's title
 *   is a log read per session, so titles are only read for the sessions of the
 *   links being answered about, and only for candidates that survived.
 * - the Host services are owned by the profile, not by this plugin. If the
 *   profile is torn down while an answer is in flight, the promise must settle
 *   anyway — a panel waiting on a dead service would hang forever. The caller
 *   therefore passes the answer to {@link settleLater}, which resolves it at once
 *   and abandons `undefined` if the underlying promise never settles.
 *
 * @module dsh-interlink/catalogue
 */

import { normalizeLive } from './catalogue-types.js'
import { linksOf, sameProject } from './link.js'

/** How many sessions one answer considers, so a long history stays bounded. */
export const MAX_CATALOGUE_SESSIONS = 400

/** How many sessions one answer reads titles for, bounding the per-answer log reads. */
export const MAX_TITLE_READS = 60

/**
 * Join a promise with a one-shot backstop.
 *
 * The Host services can be disposed under an in-flight call, in which case the
 * promise never settles. A UI blocked on it looks like a broken plugin, so every
 * route answer races the work against this timer and reports `fallback` instead.
 *
 * The timer is always cleared, so a fast answer costs nothing and a slow one
 * cannot leave a handle behind that keeps the process awake.
 *
 * @param {Promise<T>} work - the answer.
 * @param {T} fallback - what to report when the work does not settle in time.
 * @param {number} [ms] - the backstop delay.
 * @returns {Promise<T>} the answer or the fallback.
 * @template T
 */
export function settleLater(work, fallback, ms = 3000) {
  let timer
  const backstop = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([work, backstop]).finally(() => clearTimeout(timer))
}

/**
 * Read the session corpus: headers only, newest first.
 *
 * `listSessions()` already merges live and persisted sessions and prefers the
 * live snapshot of each one, so this is the cheap half of the answer. The live
 * Agent registry refines `running`, because the listing is a snapshot taken when
 * the durable record was written and an agent may have started or stopped since.
 *
 * @param {object} services - the Host services.
 * @param {object} [services.sessionQuery] - `ctx.sessionQuery`, when the profile has it.
 * @param {object} [services.agents] - `ctx.agents`.
 * @param {object} [options] - shaping options.
 * @param {number} [options.limit] - how many sessions to keep.
 * @param {boolean} [options.includeSubagents] - keep subagent sessions.
 * @returns {Promise<object[]>} the normalized sessions, newest first.
 */
export async function readCorpus(services, options = {}) {
  const limit = options.limit ?? MAX_CATALOGUE_SESSIONS
  const query = services.sessionQuery
  if (typeof query?.listSessions !== 'function') return []

  const records = await query.listSessions()
  const live = new Set(typeof services.agents?.list === 'function' ? services.agents.list().map((agent) => agent.id) : [])

  const sessions = []
  for (const record of Array.isArray(records) ? records : []) {
    // The corpus carries its identity on  (header.id / header.cwd); older
    // flat shapes put them straight on the record. Accept both.
    const head = record?.header ?? record
    const sessionId = typeof head?.id === 'string' ? head.id : typeof head?.sessionId === 'string' ? head.sessionId : undefined
    if (sessionId === undefined) continue
    const origin = head.origin === 'subagent' ? 'subagent' : undefined
    if (origin === 'subagent' && options.includeSubagents !== true) continue
    sessions.push(
      normalizeLive({
        id: sessionId,
        cwd: head.cwd,
        running: live.has(sessionId) || head.running === true,
        origin,
        parentSessionId: head.parentSessionId,
        updatedAt: typeof head.updatedAt === 'number' ? head.updatedAt : 0,
        blank: head.blank === true,
      }),
    )
    if (sessions.length >= limit) break
  }
  return sessions
}

/**
 * Read titles for a set of sessions, tolerating per-session failure.
 *
 * `readTitleSnapshots` returns one result per requested id and keeps operational
 * failures isolated per session, which is exactly the behaviour a listing needs:
 * one unreadable log must not blank the whole panel.
 *
 * @param {object} query - `ctx.sessionQuery`.
 * @param {string[]} sessionIds - the sessions to title.
 * @returns {Promise<Map<string, string>>} id → title, for the ones that have one.
 */
export async function readTitles(query, sessionIds) {
  const titles = new Map()
  if (typeof query?.readTitleSnapshots !== 'function' || sessionIds.length === 0) return titles
  const ids = [...new Set(sessionIds)].slice(0, MAX_TITLE_READS)
  let results
  try {
    results = await query.readTitleSnapshots(ids)
  } catch {
    return titles
  }
  for (const result of Array.isArray(results) ? results : []) {
    if (result?.status !== 'fulfilled') continue
    const title = result.value?.title
    if (typeof title === 'string' && title.trim().length > 0) titles.set(result.sessionId, title.trim())
  }
  return titles
}

/**
 * Attach titles to session rows.
 *
 * A session whose title was deliberately not read keeps the empty placeholder
 * rather than being omitted: the panel still needs its row to show which link it
 * is on, and the id is a perfectly good label until the human asks about it.
 *
 * @param {object[]} sessions - normalized rows.
 * @param {Map<string, string>} titles - from {@link readTitles}.
 * @param {string[]} [read] - the ids that were attempted; everything else is listed untitled.
 * @returns {object[]} new rows.
 */
export function withTitles(sessions, titles, read) {
  if (!Array.isArray(read)) {
    return sessions.map((session) => ({ ...session, title: titles.get(session.id) ?? session.title }))
  }
  const attempted = new Set(read)
  return sessions.map((session) => {
    const title = titles.get(session.id)
    if (title !== undefined) return { ...session, title }
    return attempted.has(session.id) ? { ...session, title: '' } : { ...session, title: '', lazy: true }
  })
}

/**
 * Resolve one session's link.
 *
 * A session the corpus does not know (a brand-new session whose first turn has
 * not been persisted yet) still has a link: the recorded assignment if the store
 * has one, otherwise the rules. It does not need to be listed to be linkable.
 *
 * @param {object} input - the lookup.
 * @param {string} input.sessionId - the session.
 * @param {object[]} [input.sessions] - the corpus, when it is already loaded.
 * @param {object} input.rules - the link rules.
 * @returns {string | undefined} the link id, or `undefined` when it is on no link.
 */
export function linksOfSession(input) {
  const known = Array.isArray(input.sessions) ? input.sessions.find((session) => session.id === input.sessionId) : undefined
  return linksOf({
    sessionId: input.sessionId,
    cwd: known?.cwd,
    overrides: input.rules?.overrides,
    auto: input.rules?.auto,
    defaultLink: input.rules?.defaultLink,
  })
}

/**
 * Group sessions by link.
 *
 * Unlinked sessions are omitted: they are not members of any scope, so there is
 * no bucket to put them in.
 *
 * @param {object[]} sessions - normalized, titled rows.
 * @param {object} rules - the link rules.
 * @returns {Map<string, object[]>} link id → member rows.
 */
export function foldLinks(sessions, rules) {
  const groups = new Map()
  for (const session of sessions) {
    // A session on several links belongs to each of them, so it is folded into
    // every group it named rather than just the first one.
    for (const linkId of linksOfSession({ sessionId: session.id, sessions, rules })) {
      const members = groups.get(linkId)
      if (members === undefined) groups.set(linkId, [session])
      else members.push(session)
    }
  }
  return groups
}

/**
 * The sessions one session may message, with its own link.
 *
 * The peer list is every other member of the same link — a link is one set, so
 * there is nothing asymmetric to compute. Members recorded in the store but
 * absent from the corpus are kept: the store is a scope declaration, and a
 * session whose log has not been written yet is still a legitimate target.
 *
 * When `crossProject` is off, sharing a link is necessary but not sufficient:
 * a peer must also share the asking session's project (normalized working
 * directory). This is the one reachability decision behind the send tool, the
 * standing context line, and the header control, so none of them can advertise
 * a peer that a relay would refuse.
 *
 * @param {object} input - the lookup.
 * @param {string} input.sessionId - the asking session.
 * @param {object[]} input.sessions - the corpus.
 * @param {object} input.rules - the link rules.
 * @param {string} [input.focusCwd] - the asking session's working directory.
 * @returns {{ linkId: string | undefined, peers: object[] }} the peers.
 */
export function peersFor(input) {
  const own = linksOfSession({ sessionId: input.sessionId, sessions: input.sessions, rules: input.rules })
  const focus = input.sessions.find((entry) => entry.id === input.sessionId)
  const focusCwd = input.focusCwd ?? focus?.cwd
  // A session on no link has no scope to be reachable in, so it has no peers at
  // all (not even other unlinked sessions).
  if (own.length === 0) return { linkId: undefined, peers: [] }
  const linkId = own[0]
  const seen = new Set()
  const peers = []
  for (const session of input.sessions) {
    if (session.id === input.sessionId) continue
    // Reachable when the two share ANY link: joining one more link widens the
    // peer set without replacing it.
    const theirs = linksOfSession({ sessionId: session.id, sessions: input.sessions, rules: input.rules })
    if (!theirs.some((entry) => own.includes(entry))) continue
    // One shared reachability decision: when crossProject is off, a session on
    // the same link but in a different project is not a peer. The send tool,
    // the standing context line, and the header control all go through here.
    if (!sameProject({ focusCwd, peerCwd: session.cwd, crossProject: input.rules.crossProject })) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)
    peers.push(session)
  }
  return { linkId, peers }
}

/**
 * The ids recorded on one link by the store, when the corpus has not caught up.
 *
 * @param {object} rules - the link rules.
 * @param {string} linkId - the link.
 * @returns {string[]} the recorded members.
 */
export function recordedMembers(rules, linkId) {
  const overrides = rules?.overrides ?? {}
  return Object.entries(overrides)
    .filter(([, value]) => value === linkId)
    .map(([sessionId]) => sessionId)
}

/**
 * Build the JSON body the browser panel and the tools both read.
 *
 * @param {object} input - the snapshot inputs.
 * @param {object[]} input.sessions - titled session rows.
 * @param {object} input.rules - the link rules.
 * @param {string} [input.focus] - the asking session, so its own link can be marked.
 * @param {object} [input.manual] - human-pinned links.
 * @param {boolean} [input.persisted] - whether the last store write reached the disk.
 * @returns {object} the serializable catalogue.
 */
export function buildCatalogue(input) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : []
  const rules = input.rules ?? {}
  const focus = typeof input.focus === 'string' && input.focus.length > 0 ? input.focus : undefined
  const groups = foldLinks(sessions, rules)
  const focusLinks = focus === undefined ? [] : linksOfSession({ sessionId: focus, sessions, rules })
  const focusLink = focusLinks[0]

  // A focus session that is not in the corpus still owns a link; make sure the
  // panel can show it rather than reporting "no link" for the session the human
  // is looking at.
  for (const linkId of focusLinks) {
    if (!groups.has(linkId)) groups.set(linkId, [])
  }

  // A link someone named exists even before anyone joins it, so it is listed with
  // zero members: that is how another session can find and join it at all.
  for (const linkId of rules.knownLinks ?? []) {
    if (typeof linkId === "string" && linkId.length > 0 && !groups.has(linkId)) groups.set(linkId, [])
  }

  // Membership counts the recorded assignments too, not just the corpus: a session
  // whose log has not been written yet is still on the link and still reachable.
  const recorded = rules.overrides ?? {}
  const links = [...groups.entries()]
    .map(([id, members]) => {
      const listed = new Set(members.map((session) => session.id))
      for (const [sessionId, value] of Object.entries(recorded)) {
        if (value === id && !listed.has(sessionId)) listed.add(sessionId)
      }
      return {
      id,
      members: listed.size,
      sessions: members.map((session) => ({
        id: session.id,
        title: session.title ?? '',
        cwd: session.cwd ?? '',
        running: session.running === true,
        updatedAt: session.updatedAt ?? 0,
      })),
      }
    })
    .sort((a, b) => (a.id === focusLink ? -1 : b.id === focusLink ? 1 : b.members - a.members || a.id.localeCompare(b.id)))

  return {
    focus: focus ?? null,
    focusLink: focusLink ?? null,
    links,
    // Threaded through so sessionView can apply the same reachability gate as
    // peersFor: the header must never show a peer the tools would refuse.
    crossProject: rules.crossProject === true,
    manual: input.manual ?? {},
    persisted: input.persisted !== false,
    // Threaded through from the live services: a profile without agents.resume
    // can only reach sessions that are already running, and the header says so
    // rather than promising a delivery it cannot make.
    resumable: input.resumable !== false,
    total: sessions.length,
  }
}

/**
 * Describe a catalogue for the model.
 *
 * Ids and titles are what a send needs; the cwd is included because two sessions
 * in one project are usually the reason to talk at all, and a truncated path is
 * enough to tell them apart.
 *
 * @param {object} catalogue - from {@link buildCatalogue}.
 * @param {string} [language] - `'en'` or `'zh'`.
 * @returns {string} the description.
 */
export function describeCatalogue(catalogue, language) {
  const links = Array.isArray(catalogue?.links) ? catalogue.links : []
  // "No link named yet" is the normal resting state now, not an empty profile:
  // say so explicitly, or a model reads an empty list and concludes the profile
  // has no sessions to talk to.
  if (links.length === 0) {
    return language === 'zh'
      ? `共 ${catalogue?.total ?? 0} 个会话，但都没有被命名到任何链路。链路必须显式设置：用 set_session_link 指定一个名称，或由人在标题栏面板里新建链路。`
      : `${catalogue?.total ?? 0} session(s) are known, but none is on a link. A link has to be named explicitly: set one with set_session_link, or create one from the header panel.`
  }

  const lines = []
  for (const link of links) {
    const marks = catalogue.focusLink === link.id ? (language === 'zh' ? '  ← 本会话所在' : '  <- this session\'s link') : ''
    lines.push(`- ${link.id} (${link.members})${marks}`)
    for (const session of link.sessions) {
      const title = session.title.length > 0 ? session.title : language === 'zh' ? '（未命名）' : '(untitled)'
      const self = session.id === catalogue.focus ? (language === 'zh' ? ' [本会话]' : ' [this session]') : ''
      const running = session.running ? (language === 'zh' ? ' ●' : ' ●') : ''
      lines.push(`  - ${session.id} · ${title}${running}${self}`)
    }
  }
  const header =
    language === 'zh'
      ? `共 ${catalogue.total} 个会话，其中 ${links.length} 条链路（● 表示该会话当前正在运行）：`
      : `${catalogue.total} session(s), with ${links.length} link(s) (● marks a running session):`
  return [header, ...lines].join('\n')
}
