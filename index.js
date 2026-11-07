/**
 * Session Link — the Harness entry point.
 *
 * The behaviour lives in `plugin.js` (no Harness imports, fully testable with a
 * stubbed context), the linking rules and wording in `link.js`, the durable
 * store in `link-store.js`, the session catalogue in `catalogue.js`, and the
 * browser bridge in `routes.js`. This module declares the config schema and
 * wires the four surfaces that need one:
 *
 * 1. the durable link store, shared by every other surface;
 * 2. the agent tools (`send_session_message`, `list_session_links`,
 *      `set_session_link`) and the standing peer line;
 * 3. the HTTP routes the header control and the settings page call;
 * 4. nothing else — the browser half is a separate module, served by the client
 *      module loader from this same package.
 *
 * Tools are registered through `ctx.tools.register` with plain definition
 * objects rather than `defineTool`: a profile-installed bundle cannot reliably
 * resolve the harness packages statically, and the registry accepts the
 * definition object directly.
 *
 * @module dsh-interlink
 */

import z from '@deepseek-ai/schemastery'
import { apply as applyBody, inject, name } from './plugin.js'
import { createLinkStore } from './link-store.js'
import { buildCatalogue, readCorpus, readTitles, settleLater, withTitles } from './catalogue.js'
import { createRoutes } from './routes.js'
import { MAX_MESSAGE_CHARS, configValue, serviceOf } from './link.js'

export { inject, name }

export const Config = z.object({
  autoLinks: z
    .boolean()
    .default(false)
    .volatile()
    .description(
      'Off by default: a session belongs to no link until someone names one, so nothing is reachable by accident. Turn this on to group sessions by working directory instead - two sessions started in the same folder then share a link without being named, and sessions in different folders stay apart.',
    ),
  linkTools: z
    .boolean()
    .default(true)
    .volatile()
    .description(
      'Register the send_session_message, list_session_links, and set_session_link tools. Turning this off leaves the human the header control and the standing context line, and removes the agent\'s own ability to send.',
    ),
  contextLine: z
    .boolean()
    .default(true)
    .volatile()
    .description('Add the standing "who can I talk to" line to the runtime context of every session that has at least one peer.'),
  crossProject: z
    .boolean()
    .default(false)
    .volatile()
    .description(
      'Allow relays between sessions whose working directories differ. Off by default: two sessions in one project usually share the same code and the same assumptions, while relaying into an unrelated project is rarely what was meant.',
    ),
  headerControl: z
    .boolean()
    .default(true)
    .volatile()
    .description('Serve the link routes and show the header control, so each session can be moved onto a link without opening Settings.'),
  allowRemoteClients: z
    .boolean()
    .default(false)
    .description('Accept the link routes from a non-loopback peer. Off by default: the bridge is a local control surface, not an authenticated API.'),
  language: z
    .union([z.const('auto'), z.const('en'), z.const('zh')])
    .default('auto')
    .description('Wording language for the context line and tool descriptions: "auto" follows the host locale, otherwise English or Chinese.'),
  maxMessageChars: z
    .number()
    .step(1)
    .min(200)
    .max(32000)
    .default(8000)
    .description('Longest single relayed message, so one message cannot flood a peer\'s context.'),
})

/**
 * Read the profile-wide link rules.
 *
 * The config is the default and the store is the override, because the header
 * panel writes the store while the Settings page edits the config: a user who
 * flips "group by folder" in the panel must see it stick, and a user who never
 * touches the panel must still get the config value.
 *
 * @param {object} config - the resolved plugin config.
 * @param {object} store - the durable link store.
 * @returns {{ auto: boolean, defaultLink: string, overrides: object, crossProject: boolean }} the rules.
 */
export function rulesOf(config, store) {
  const knobs = store.knobSnapshot()
  return {
    auto: typeof knobs.auto === 'boolean' ? knobs.auto : configValue(config.autoLinks) !== false,
    // No implicit default link: absent means every session is on no link
    // until it is named (or the folder rule groups it).
    defaultLink: typeof knobs.defaultLink === 'string' ? knobs.defaultLink : undefined,
    overrides: store.snapshot(),
    // Named links that exist even with no member, so the panel can offer them.
    knownLinks: store.linksSnapshot?.() ?? [],
    crossProject: configValue(config.crossProject) === true,
  }
}

/**
 * Read one whole-profile catalogue.
 *
 * Titles are read only for the sessions that survive the corpus filter, and only
 * up to a bounded number of log reads, so a profile with hundreds of sessions
 * still answers quickly.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the resolved plugin config.
 * @param {object} store - the durable link store.
 * @param {string} [focus] - the session whose link should be marked.
 * @param {object} [options] - shaping options.
 * @param {boolean} [options.includeSubagents] - keep subagent sessions in the listing.
 * @returns {Promise<object>} the catalogue.
 */
export async function snapshot(ctx, config, store, focus, options = {}) {
  // `sessionQuery` is optional in a profile, so it is resolved through
  // `ctx.get` (see `serviceOf`) — a property read of an undeclared service
  // throws on cordis releases that guard it instead of answering `undefined`.
  const query = serviceOf(ctx, 'sessionQuery')
  const sessions = await readCorpus(
    { sessionQuery: query, agents: ctx.agents },
    { includeSubagents: options.includeSubagents === true },
  )
  const rules = rulesOf(config, store)
  // Reading every title would be one log read per session, and the header panel
  // can poll this route: only the sessions of the link in focus get a title read
  // on that path. The catalogue route (`scoped` false) titles the whole listing,
  // because the human is choosing a target from all of it.
  const ids =
    options.scoped === false ? sessions.map((session) => session.id) : scopedIds(sessions, rules, focus)
  const titles = await readTitles(query, ids)
  return buildCatalogue({
    sessions: withTitles(sessions, titles, ids),
    rules,
    focus,
    manual: store.manualSnapshot(),
    persisted: store.error === undefined,
    resumable: typeof ctx.agents?.resume === 'function',
  })
}

/**
 * The session ids whose titles one answer needs.
 *
 * Without a focus every session is a candidate — the human is browsing the whole
 * corpus. With a focus only that session's link is shown in full, so everything
 * else is titled lazily: it is still listed (a link chip needs its member count)
 * but under an empty title, which the browser renders as the id.
 *
 * @param {object[]} sessions - the corpus.
 * @param {object} rules - the link rules.
 * @param {string} [focus] - the session in focus.
 * @returns {string[]} the ids to title.
 */
export function scopedIds(sessions, rules, focus) {
  if (typeof focus !== 'string' || focus.length === 0) return sessions.map((session) => session.id)
  const focusLink = buildCatalogue({ sessions, rules, focus }).focusLink
  const ids = [focus]
  for (const session of sessions) {
    if (session.id === focus) continue
    if (focusLink !== null && buildCatalogue({ sessions: [session], rules, focus: session.id }).focusLink === focusLink) ids.push(session.id)
  }
  return ids
}

/**
 * Serve the link routes the browser half calls.
 *
 * `webServer` mounts after plugins apply, so this waits for it instead of
 * reading it once at apply time — reading it eagerly answers `undefined` and the
 * routes are silently never registered.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the resolved plugin config.
 * @param {object} store - the durable link store.
 * @returns {object | undefined} the routes, or `undefined` when the bridge is disabled.
 */
function installRoutes(ctx, config, store) {
  if (configValue(config.headerControl) === false) return undefined
  const routes = createRoutes({
    snapshot: (focus, options) => settleLater(snapshot(ctx, config, store, focus, options), emptyAnswer(focus, store), 3000),
    setLink: (sessionId, linkId) => store.setLink(sessionId, linkId),
    joinLink: (sessionId, linkId) => store.joinLink(sessionId, linkId),
    leaveLink: (sessionId, linkId) => store.leaveLink(sessionId, linkId),
    createLink: (linkId) => store.createLink(linkId),
    removeLink: (linkId) => store.removeLink(linkId),
    setSettings: async (patch) => {
      if ('auto' in patch) await store.setKnob('auto', patch.auto)
      if ('defaultLink' in patch) await store.setKnob('defaultLink', patch.defaultLink)
    },
    settings: () => {
      const rules = rulesOf(config, store)
      return {
        auto: rules.auto,
        defaultLink: rules.defaultLink,
        maxMessageChars: configValue(config.maxMessageChars) ?? MAX_MESSAGE_CHARS,
        crossProject: rules.crossProject,
      }
    },
    errorOf: () => store.error,
    // The relay transcript the panel renders verbatim: AI-to-AI messages must be
    // readable as plain text, never an opaque side channel.
    relays: () => store.relaysSnapshot(),
    allowRemote: configValue(config.allowRemoteClients) === true,
  })
  ctx.inject(['webServer'], (scoped) => {
    for (const [label, handler, path] of [
      ['catalogue', routes.catalogueRoute, routes.paths[0]],
      ['session', routes.session, routes.paths[1]],
      ['settings', routes.settings, routes.paths[2]],
    ]) {
      scoped.effect(() => scoped.webServer.register({ kind: 'exact', path, handler }), `session-link: ${label} route`)
    }
  })
  return routes
}

/** The answer a route gives when the Host services do not respond in time. */
function emptyAnswer(focus, store) {
  return {
    focus: typeof focus === 'string' && focus.length > 0 ? focus : null,
    focusLink: null,
    links: [],
    manual: {},
    persisted: store.error === undefined,
    total: 0,
    degraded: true,
  }
}

/**
 * Install Session Link.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the resolved plugin config.
 * @returns {object} the store this plugin owns.
 */
export function apply(ctx, config) {
  const store = createLinkStore()
  // Load before the first read so a restart keeps the assignments already on disk.
  void store.ready()

  const linked = applyBody(ctx, config, { store })
  installRoutes(ctx, config, store)
  return { store, resumed: linked.resumed }
}

/**
 * The store this plugin owns, exposed so a test can point it at a temporary
 * directory without standing up a Harness.
 */
export { createLinkStore }
