/**
 * The HTTP bridge between the browser half and this plugin's Host state.
 *
 * The browser half cannot call a Host service directly: a profile-installed
 * bundle reaches the Host through same-origin routes registered on `webServer`,
 * which is how every working two-half plugin in this profile does it. This
 * module owns the routes — the guard, the body reader, and the JSON contract —
 * and nothing else, so the policy (what a link id may be, who wins between an
 * assignment and the rules) stays in one place.
 *
 * | method | path                            | purpose                                     |
 * | ------ | ------------------------------- | ------------------------------------------- |
 * | GET    | /api/session-link/catalogue     | every session, grouped by link              |
 * | GET    | /api/session-link/session       | one session's link and peers                |
 * | PUT    | /api/session-link/session       | move one session onto a link, or clear it   |
 * | PUT    | /api/session-link/settings      | the profile-wide rules (`auto`, default link) |
 *
 * The `session` route is what the header control calls on every session change,
 * so it is the hot path: it answers from one session listing plus the titles of
 * that session's own link only, not the whole profile's.
 *
 * @module dsh-interlink/routes
 */

import { DEFAULT_LINK_ID, normalizeLinkId, sameProject, shortId } from './link.js'

export { DEFAULT_LINK_ID }

/** Longest body accepted, matching the sibling plugins' bridge. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Header the browser half sends.
 *
 * A cross-site `fetch` can add simple headers but not an arbitrary one without
 * triggering a CORS preflight, which this server never answers — so requiring it
 * is what stops another origin's page from driving this state. It is a
 * preflight barrier, not authentication.
 */
const GUARD_HEADER = 'x-session-link'
const GUARD_VALUE = '1'

/** How many transcript entries one session view returns, newest kept. */
const MAX_VIEWED_RELAYS = 40

/** Absolute paths of the routes this plugin serves. */
export const ROUTE_PATH = '/api/session-link/catalogue'
export const SESSION_PATH = '/api/session-link/session'
export const SETTINGS_PATH = '/api/session-link/settings'
export const ROUTE_PATHS = Object.freeze([ROUTE_PATH, SESSION_PATH, SETTINGS_PATH])

/**
 * Decide whether a request may touch this bridge.
 *
 * Three independent signals, because each alone is bypassable: the guard header
 * blocks a cross-site document, `Sec-Fetch-Site` rejects a cross-site one that
 * somehow got the header, and the loopback peer rule keeps a LAN client out even
 * when it replays every header it observed.
 *
 * @param {object} req - a node `IncomingMessage`.
 * @param {object} [options] - test seams.
 * @param {boolean} [options.allowRemote] - accept non-loopback peers.
 * @returns {{ ok: true } | { ok: false, status: number, reason: string }} the verdict.
 */
export function guardRequest(req, options = {}) {
  const headers = req?.headers ?? {}
  if (headers[GUARD_HEADER] !== GUARD_VALUE) return { ok: false, status: 403, reason: 'missing guard header' }
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: `cross-site request (${site})` }
  }
  const origin = headers.origin
  if (origin === 'null') return { ok: false, status: 403, reason: 'opaque origin' }
  if (origin !== undefined) {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return { ok: false, status: 403, reason: 'unparsable origin' }
    }
    if (String(headers.host ?? '') !== originHost) {
      return { ok: false, status: 403, reason: `origin ${originHost} != host ${String(headers.host ?? '')}` }
    }
  }
  if (options.allowRemote !== true) {
    const remote = req?.socket?.remoteAddress
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === undefined
    if (!loopback) return { ok: false, status: 403, reason: `peer ${String(remote)} is not loopback` }
  }
  return { ok: true }
}

/**
 * Write one JSON response.
 *
 * @param {object} res - a node `ServerResponse`.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the JSON-serializable body.
 */
export function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Read and parse a JSON request body, bounded.
 *
 * @param {object} req - a node `IncomingMessage`.
 * @returns {Promise<object | undefined>} the parsed body, or `undefined` when it is absent, oversized, or not JSON.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Validate one incoming link from the browser.
 *
 * `null`, `''`, and the words `default`/`auto` all mean "clear the assignment
 * and fall back to the rules", so a user who opens a session that has a recorded
 * link and wants it back on the default has one obvious gesture.
 *
 * @param {unknown} value - the `link` field of a PUT body.
 * @returns {{ kind: 'set', linkId: string } | { kind: 'clear' } | { kind: 'invalid' }} the verdict.
 */
export function parseLinkInput(value) {
  if (value === null || value === '') return { kind: 'clear' }
  if (typeof value !== 'string') return { kind: 'invalid' }
  const text = value.trim().toLowerCase()
  if (text === 'default' || text === 'auto' || text === 'none') return { kind: 'clear' }
  const linkId = normalizeLinkId(text)
  if (linkId === undefined) return { kind: 'invalid' }
  return { kind: 'set', linkId }
}

/**
 * Build the JSON answer describing one session's link and peers.
 *
 * @param {object} input - the facts.
 * @param {string | undefined} input.sessionId - the session asked about.
 * @param {object} input.catalogue - the whole-profile catalogue.
 * @param {boolean} [input.crossProject] - allow peers in another working directory.
 * @param {string} [input.focusCwd] - the focus cwd when it is not in the catalogue.
 * @returns {object} the route body.
 */
export function sessionView(input) {
  const sessionId = input.sessionId
  const catalogue = input.catalogue
  const linkId = catalogue.focusLink ?? null
  // The session's own links as the catalogue resolved them, so the panel can draw
  // every membership instead of only the first one.
  const myLinks = (catalogue.links ?? []).filter((link) => link.sessions?.some?.((session) => session.id === sessionId)).map((link) => link.id)
  const mine = linkId === null ? undefined : catalogue.links.find((link) => link.id === linkId)
  const self = mine?.sessions.find((session) => session.id === sessionId)
  // Same reachability decision as the agent tools and the standing context
  // line: sharing a link is necessary but not sufficient when crossProject is
  // off. The header draws only peers a send could actually reach.
  const crossProject = catalogue.crossProject === true || input.crossProject === true
  const focusCwd = self?.cwd ?? input.focusCwd
  const peers = (mine?.sessions ?? []).filter(
    (session) => session.id !== sessionId && sameProject({ focusCwd, peerCwd: session.cwd, crossProject }),
  )
  return {
    sessionId: sessionId ?? null,
    linkId,
    linksJoined: myLinks,
    // "none" is a first-class answer now: the session exists but no link id was
    // ever named for it, which is different from following a rule.
    source: self === undefined ? (linkId === null ? 'none' : linkId === DEFAULT_LINK_ID ? 'default' : 'rules') : 'session',
    recorded: sessionId !== undefined && Object.hasOwn(catalogue.manual ?? {}, linkId ?? ''),
    peers,
    links: catalogue.links.map((link) => ({ id: link.id, members: link.members })),
    total: catalogue.total,
    persisted: catalogue.persisted,
    /**
     * Whether a peer that is not running can still be reached.
     *
     * The header says so instead of promising a delivery the Host cannot make: a
     * profile with `agents.resume` disabled can only reach sessions that happen
     * to be live.
     */
    resumable: catalogue.resumable !== false,
    /**
     * The AI-to-AI transcript for this session, as plain text.
     *
     * Every relay the panel would otherwise hide is here verbatim: who said what
     * to whom, on which link, and when. A human must be able to read the exchange
     * instead of trusting that two agents talked.
     */
    relays: (Array.isArray(input.relays) ? input.relays : [])
      .filter((entry) => entry.from === sessionId || entry.to === sessionId)
      .slice(-MAX_VIEWED_RELAYS),
    pending: false,
  }
}

/**
 * Build the route handlers.
 *
 * Every handler answers from one async `snapshot` callback so the routes hold no
 * state of their own: a session opened in one tab, relinked in another, sees the
 * change on its next poll.
 *
 * @param {object} deps - the live Host state and the write paths.
 * @param {object} deps.snapshot - `(focus?: string) => Promise<object>` returning the catalogue.
 * @param {object} deps.setLink - `(sessionId: string, linkId: string | null) => Promise<void>`.
 * @param {object} [deps.setSettings] - `(settings: { auto?: boolean, defaultLink?: string }) => Promise<void>`.
 * @param {object} [deps.settings] - `() => object`, the current profile-wide rules.
 * @param {object} [deps.errorOf] - `() => Error | undefined`, the last store failure.
 * @param {boolean} [deps.allowRemote] - accept non-loopback peers.
 * @returns {{ catalogueRoute: Function, session: Function, settings: Function, paths: string[] }} the handlers.
 */
export function createRoutes(deps) {
  /** Last session the bridge was asked about; a request without one reuses it. */
  let latestSessionId

  const handle = (work) => async (req, res) => {
    const verdict = guardRequest(req, { allowRemote: deps.allowRemote })
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.reason })
      return
    }
    try {
      await work(req, res)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const catalogue = handle(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const focus = url.searchParams.get('sessionId') ?? undefined
    if (typeof focus === 'string' && focus.length > 0) latestSessionId = focus
    // The human is browsing every session to pick a target, so this route titles
    // the whole listing while the header route titles only its own link.
    sendJson(res, 200, await deps.snapshot(focus ?? latestSessionId, { scoped: false }))
  })

  const session = handle(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const asked = url.searchParams.get('sessionId')
    if (asked !== null && asked.length > 0) latestSessionId = asked
    else if (asked === '') latestSessionId = undefined

    if (req.method === 'GET') {
      const body = await deps.snapshot(latestSessionId)
      sendJson(res, 200, { ...sessionView({ sessionId: latestSessionId, catalogue: body, relays: deps.relays?.() }), focus: latestSessionId ?? null })
      return
    }
    if (req.method === 'DELETE') {
      // Forget a named link itself, without moving its members off it.
      const body = await readJsonBody(req)
      if (body === undefined) {
        sendJson(res, 400, { error: 'a JSON object body is required' })
        return
      }
      const linkId = normalizeLinkId(body.link)
      if (linkId === undefined) {
        sendJson(res, 400, { error: 'link must be a usable link id' })
        return
      }
      // "leave" drops this session's membership only; anything else deletes the
      // named link itself, which is a different statement.
      if (body.mode === 'leave') {
        const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : latestSessionId
        if (sessionId === undefined) {
          sendJson(res, 400, { error: 'a sessionId is required to leave a link' })
          return
        }
        await deps.leaveLink?.(sessionId, linkId)
        const answers = await deps.snapshot(sessionId)
        sendJson(res, 200, { ...sessionView({ sessionId, catalogue: answers, relays: deps.relays?.() }), left: linkId })
        return
      }
      await deps.removeLink?.(linkId)
      const answers = await deps.snapshot(latestSessionId)
      sendJson(res, 200, { ...sessionView({ sessionId: latestSessionId, catalogue: answers, relays: deps.relays?.() }), removed: linkId })
      return
    }
    if (req.method !== 'PUT') {
      res.writeHead(405, { allow: 'GET, PUT, DELETE' })
      res.end()
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined) {
      sendJson(res, 400, { error: 'a JSON object body is required' })
      return
    }
    // A PUT that names a link also creates it, so it can be joined later.
    const named = typeof body.link === 'string' ? normalizeLinkId(body.link) : undefined
    if (named !== undefined && body.link !== null) await deps.createLink?.(named)
    // Default joins, keeping whatever links the session is already on; "replace"
    // moves it onto this one alone. The old single-link behaviour is the latter.
    const joinOnly = body.mode !== 'replace'
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : latestSessionId
    if (sessionId === undefined) {
      sendJson(res, 400, { error: 'a sessionId is required to move a session onto a link' })
      return
    }
    if (!('link' in body)) {
      sendJson(res, 400, { error: 'a link field is required; use null to fall back to the rules' })
      return
    }
    const parsed = parseLinkInput(body.link)
    if (parsed.kind === 'invalid') {
      sendJson(res, 400, { error: 'link must be lowercase letters, digits, dots, dashes or underscores, or null to clear' })
      return
    }
    if (parsed.kind === 'clear') {
      await deps.setLink(sessionId, null)
    } else if (joinOnly && typeof deps.joinLink === 'function') {
      await deps.joinLink(sessionId, parsed.linkId)
    } else {
      await deps.setLink(sessionId, parsed.linkId)
    }
    latestSessionId = sessionId
    const answers = await deps.snapshot(sessionId)
    sendJson(res, 200, {
      ...sessionView({ sessionId, catalogue: answers, relays: deps.relays?.() }),
      focus: sessionId,
      applied: parsed.kind === 'clear' ? null : parsed.linkId,
    })
  })

  const settings = handle(async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ...deps.settings?.(), persisted: deps.errorOf?.() === undefined })
      return
    }
    if (req.method !== 'PUT') {
      res.writeHead(405, { allow: 'GET, PUT' })
      res.end()
      return
    }
    if (typeof deps.setSettings !== 'function') {
      sendJson(res, 501, { error: 'this profile does not allow changing the link rules from the browser' })
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined) {
      sendJson(res, 400, { error: 'a JSON object body is required' })
      return
    }
    const patch = {}
    if ('auto' in body) {
      if (typeof body.auto !== 'boolean') {
        sendJson(res, 400, { error: 'auto must be a boolean' })
        return
      }
      patch.auto = body.auto
    }
    if ('defaultLink' in body) {
      // `null` clears the default: sessions then stay on no link until named.
      if (body.defaultLink === null) {
        patch.defaultLink = undefined
      } else {
        const linkId = normalizeLinkId(body.defaultLink)
        if (linkId === undefined) {
          sendJson(res, 400, { error: 'defaultLink must be a usable link id, or null to clear it' })
          return
        }
        patch.defaultLink = linkId
      }
    }
    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'nothing to change: send auto and/or defaultLink' })
      return
    }
    await deps.setSettings(patch)
    sendJson(res, 200, { ...deps.settings?.(), persisted: deps.errorOf?.() === undefined, applied: patch })
  })

  return { catalogueRoute: catalogue, session, settings, paths: [...ROUTE_PATHS] }
}

/**
 * Describe one link's members on a single line, for logs and diagnostics.
 *
 * @param {object[]} sessions - session rows.
 * @returns {string} the line.
 */
export function membersLine(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return '—'
  return sessions.map((session) => shortId(session.id)).join(', ')
}
