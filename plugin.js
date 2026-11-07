/**
 * Session Link's runtime wiring, deliberately free of Harness imports so the
 * whole behaviour is testable with a stubbed context (see `test.mjs`).
 *
 * Three model-facing surfaces and one human-facing one:
 *
 * 1. **A runtime-context line** naming the other sessions on this session's
 *    link. Recomputed on every prompt assembly, so a link edit is live on the
 *    next step with no bookkeeping in between.
 * 2. **`send_session_message`** — deliver a message into a linked session.
 * 3. **`list_session_links`** / **`set_session_link`** — read the current
 *    division, and change the calling session's own link.
 * 4. **The header control and settings page** (browser half), over the HTTP
 *    bridge in `routes.js`.
 *
 * Delivery into a session that has no live agent is the interesting case. The
 * harness gives a plugin exactly one supported way to drive another session:
 * resume it through `ctx.agents.resume()` and use the handle's `followup()`.
 * That handle is a capability — its disposer kills the agent — so this module
 * disposes only the handle it created itself, and never touches an agent that
 * was already live (the user may be typing into it).
 *
 * A relayed message is recorded with the harness's own first-class source for
 * cross-session input, `{ kind: 'agent-message', form: 'relay', senderSessionId }`,
 * which the session formats already admit and the Web client already renders as
 * a relayed message rather than as the recipient's own human input.
 *
 * @module dsh-interlink/plugin
 */

import { randomUUID } from 'node:crypto'
import { buildCatalogue, describeCatalogue, linksOfSession, peersFor, readCorpus, readTitles, withTitles } from './catalogue.js'
import {
  MAX_MESSAGE_CHARS,
  contextText,
  describePeer,
  normalizeLinkId,
  relaySummary,
  relayText,
  resolveTarget,
  sendDescription,
  shortId,
} from './link.js'
import { configValue, serviceOf } from './link.js'


/** Loader entry id this plugin registers as. */
export const name = 'session-link'

/** Services this plugin needs before it activates; a profile without them stays inert. */
export const inject = ['agents', 'tools']

/** Placement fallback when the harness does not publish the delegation context order. */
const DELEGATION_CONTEXT_ORDER = 120

/**
 * How long a computed peer line stays valid.
 *
 * The line is built off the prompt path, so a stale one is only ever a few
 * seconds behind a relink; the bound keeps a long-running session from reading a
 * peer set that changed an hour ago.
 */
export const PEER_CACHE_TTL_MS = 30_000

/** Resolve the wording language from configuration and the host locale. */
export function resolveLanguage(configured) {
  if (configured === 'en' || configured === 'zh') return configured
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Build one identified user-role message carrying a relay from another session.
 *
 * The id is a real UUID rather than a plugin-private token because the message
 * is committed to the recipient's log like any other inbox entry; two relays
 * from the same sender must stay distinct rows.
 *
 * @param {object} input - the relay facts.
 * @param {string} input.fromId - sender session id.
 * @param {string} [input.fromTitle] - sender title, when known.
 * @param {string} [input.fromCwd] - sender working directory, when known.
 * @param {string} input.linkId - the link the relay travelled on.
 * @param {string} input.toId - recipient session id.
 * @param {string} input.body - the message text.
 * @param {string} [input.language] - `'en'` or `'zh'`.
 * @returns {object} the message.
 */
export function relayMessage(input) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: relayText(input) }],
    source: {
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: input.fromId,
      summary: relaySummary(input.fromId, input.toId, input.linkId),
    },
  }
}

/**
 * Read the current link rules from configuration and the durable store.
 *
 * @param {object} config - the resolved plugin config.
 * @param {object} [store] - the durable link store, when one is installed.
 * @returns {{ auto: boolean, defaultLink: string, overrides: object, crossProject: boolean }} the rules.
 */
export function rulesOf(config, store) {
  const knobAuto = store?.knobSnapshot?.().auto
  const knobDefault = store?.knobSnapshot?.().defaultLink
  return {
    auto: typeof knobAuto === 'boolean' ? knobAuto : configValue(config.autoLinks) !== false,
    // No implicit default link: absent means a session is on no link at all.
    defaultLink: typeof knobDefault === 'string' ? knobDefault : undefined,
    overrides: store?.snapshot?.() ?? {},
    // Named links that exist even with no member, so the panel can offer them.
    knownLinks: store?.linksSnapshot?.() ?? [],
    crossProject: configValue(config.crossProject) === true,
  }
}

/**
 * Resolve the session a tool call came from.
 *
 * @param {object} exec - the tool execution.
 * @returns {string | undefined} the calling session id.
 */
/**
 * The arguments of one tool call.
 *
 * The tools API passes them as the first positional argument
 * (`execute(args, exec)`); older releases carried them on `exec.arguments`.
 * Read both so one definition works across Host versions.
 *
 * @param {object} args - the declared arguments, when the Host passes them.
 * @param {object} exec - the execution context.
 * @returns {object} the arguments object.
 */
export function argsOf(args, exec) {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) return args
  if (exec !== null && typeof exec === 'object' && typeof exec.arguments === 'object' && exec.arguments !== null) {
    return exec.arguments
  }
  return {}
}

export function callerOf(exec) {
  const sessionId = exec?.agent?.session?.id ?? exec?.session?.id
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

/**
 * Find a peer by what the caller typed.
 *
 * @param {string} target - a session id, a title, or an unambiguous id prefix.
 * @param {object[]} peers - the reachable peers.
 * @returns {{ kind: 'found', peer: object } | { kind: 'ambiguous', matches: object[] } | { kind: 'missing' }} the resolution.
 */
export function findPeer(target, peers) {
  const text = typeof target === 'string' ? target.trim() : ''
  if (text.length === 0) return { kind: 'missing' }
  const exact = peers.find((peer) => peer.id === text)
  if (exact !== undefined) return { kind: 'found', peer: exact }
  const byTitle = peers.filter((peer) => peer.title === text)
  if (byTitle.length === 1) return { kind: 'found', peer: byTitle[0] }
  const byPrefix = resolveTarget(text, peers.map((peer) => peer.id))
  if (byPrefix.kind === 'exact') {
    const peer = peers.find((candidate) => candidate.id === byPrefix.id)
    if (peer !== undefined) return { kind: 'found', peer }
  }
  if (byPrefix.kind === 'ambiguous') {
    const matches = peers.filter((peer) => byPrefix.matches.includes(peer.id))
    return { kind: 'ambiguous', matches }
  }
  const looseTitle = peers.filter((peer) => peer.title.toLowerCase().includes(text.toLowerCase()))
  if (looseTitle.length === 1) return { kind: 'found', peer: looseTitle[0] }
  if (looseTitle.length > 1) return { kind: 'ambiguous', matches: looseTitle }
  return { kind: 'missing' }
}

/**
 * Deliver one message into another session.
 *
 * Three cases, in order of preference:
 *
 * 1. **The target is already live** — hand the message to that agent and leave
 *    it running; the plugin does not own it and must not dispose it.
 * 2. **The target is not live** — resume it, deliver, and keep the handle for a
 *    while so a reply can reuse the same agent, then let it go.
 * 3. **Neither works** — report the failure, with the reason, to the caller.
 *
 * A resumed handle is kept in `resumed` keyed by session id. Two relays to the
 * same idle session therefore share one agent instead of fighting over the
 * session lock, and the handle is disposed when the plugin unloads or when the
 * map is trimmed.
 *
 * @param {object} deps - the Host services and knobs.
 * @param {object} deps.agents - `ctx.agents`.
 * @param {Map<string, object>} deps.resumed - handles this plugin resumed.
 * @param {object} input - the delivery.
 * @param {string} input.toId - recipient session id.
 * @param {object} input.message - the message to accept.
 * @param {object} [input.sender] - sender facts for the agent's first prompt.
 * @returns {Promise<{ kind: 'delivered', agent: string } | { kind: 'failed', reason: string }>} the outcome.
 */
export async function deliver(deps, input) {
  const { agents, resumed } = deps
  const { toId, message } = input

  const live = typeof agents.get === 'function' ? agents.get(toId) : undefined
  if (live !== undefined) {
    try {
      // An agent that is mid-turn would otherwise queue the relay behind the turn
      // it is producing; steering puts it in front of the model at the next step,
      // which is what a message between two working sessions is for. An idle
      // agent is simply woken.
      const busy = live.status === 'running' && typeof live.steer === 'function'
      await steer(live, message, busy)
      return { kind: 'delivered', agent: 'live' }
    } catch (error) {
      return { kind: 'failed', reason: `the live agent refused the message: ${messageOf(error)}` }
    }
  }

  const existing = resumed.get(toId)
  if (existing !== undefined) {
    try {
      await steer(existing.agent, message, false)
      return { kind: 'delivered', agent: 'resumed' }
    } catch {
      // The kept handle is stale (its agent settled or was disposed elsewhere):
      // drop it and fall through to a fresh resume.
      resumed.delete(toId)
      try {
        await existing.dispose()
      } catch {
        /* a handle that cannot be disposed is already gone */
      }
    }
  }

  if (typeof agents.resume !== 'function') {
    return { kind: 'failed', reason: 'this profile cannot resume a session, so an idle recipient cannot be reached' }
  }

  let handle
  try {
    handle = await agents.resume({ resumeSessionId: toId })
  } catch (error) {
    return { kind: 'failed', reason: `could not resume the recipient session: ${messageOf(error)}` }
  }

  try {
    await steer(handle.agent, message, false)
  } catch (error) {
    try {
      await handle.dispose()
    } catch {
      /* the resume already failed; a failed teardown adds nothing */
    }
    return { kind: 'failed', reason: `the resumed agent refused the message: ${messageOf(error)}` }
  }

  resumed.set(toId, handle)
  return { kind: 'delivered', agent: 'resumed' }
}

/**
 * Hand one message to an agent's inbox.
 *
 * A user message is a frozen value: source and content are detached from the
 * caller so a later edit cannot reach into the recipient's log.
 *
 * @param {object} agent - the recipient agent.
 * @param {object} message - the relayed message.
 * @param {boolean} steer - put it in front of a busy agent instead of after it.
 * @returns {Promise<void>} settles once the inbox accepts it.
 */
function steer(agent, message, steer) {
  const input = { content: structuredClone(message.content), source: structuredClone(message.source) }
  return Promise.resolve(steer ? agent.steer(input) : agent.followup(input))
}

/** Read an error's message without assuming it is an `Error`. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the corpus with titles attached.
 *
 * The session listing deliberately carries no title — titles live in the session
 * log and cost a read each — so anything that lets a human or a model *name* a
 * peer has to fetch them. Every surface that does is bounded: the links an agent
 * can actually reach, never the whole profile.
 *
 * @param {object} ctx - the plugin context.
 * @param {object[]} [sessions] - an already-read corpus, to avoid a second listing.
 * @returns {Promise<object[]>} the rows, titled where a title could be read.
 */
async function titledCorpus(ctx, sessions) {
  // `sessionQuery` is optional, so resolve it through `ctx.get` (see
  // `serviceOf`): a property read of an undeclared service throws on cordis
  // releases that guard it instead of answering `undefined`.
  const query = serviceOf(ctx, 'sessionQuery')
  const rows = sessions ?? (await readCorpus({ sessionQuery: query, agents: ctx.agents }))
  const titles = await readTitles(
    query,
    rows.map((row) => row.id),
  )
  return withTitles(rows, titles)
}

/**
 * The facts one session needs about another, for a relay or a listing.
 *
 * @param {object} session - a normalized session row.
 * @returns {object} the peer facts.
 */
export function peerOf(session) {
  return { id: session.id, title: session.title, cwd: session.cwd }
}

/**
 * Register `send_session_message`.
 *
 * The recipient list is recomputed per call rather than frozen at registration,
 * so relinking a session takes effect on the very next message.
 *
 * @param {object} deps - the Host services and knobs.
 * @param {object} deps.ctx - the plugin context.
 * @param {object} deps.store - the durable link store.
 * @param {object} deps.config - the resolved plugin config.
 * @param {Map<string, object>} deps.resumed - handles this plugin resumed.
 * @param {string} deps.language - the resolved language.
 */
export function installSendTool(deps) {
  const { ctx, store, config, resumed, language } = deps

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'send_session_message',
      description:
        'Send a message to another session on the same link. Use it to hand work over, ask a question of a peer session, or report a result back to the session that asked you to do something. The message is delivered into the recipient session as input marked as coming from this session. Returns as soon as the recipient accepts the message; it does not wait for, or return, a reply.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'The recipient: a session id, a session title, or an unambiguous id prefix. Use list_session_links to see what is reachable.',
          },
          message: {
            type: 'string',
            description: `The message body, at most ${MAX_MESSAGE_CHARS} characters. Write it as the instruction or question the recipient should act on; it does not carry this conversation's history.`,
          },
        },
        required: ['target', 'message'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            delivered: { type: 'boolean', description: 'Whether the recipient accepted the message.' },
            target: { type: 'string', description: 'The session id the message was addressed to.' },
            linkId: { type: 'string', description: 'The link the message travelled on.' },
            mode: { type: 'string', description: 'How it was delivered: "live" for a running recipient, "resumed" for one this call started.' },
            reason: { type: 'string', description: 'Why delivery failed, when it did.' },
          },
          required: ['delivered'],
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.delivered
              ? `Delivered to ${shortId(value.target)} on link ${value.linkId} (${value.mode === 'live' ? 'already running' : 'started for this message'}).`
              : `Not delivered: ${value.reason}`,
          },
        ],
      },
      async execute(args, exec) {
        const fromId = callerOf(exec)
        if (fromId === undefined) throw new Error('send_session_message: no calling session to send from')
        const body = typeof exec.arguments.message === 'string' ? exec.arguments.message.trim() : ''
        if (body.length === 0) throw new Error('send_session_message: message must not be empty')
        if (body.length > MAX_MESSAGE_CHARS) {
          throw new Error(`send_session_message: message must be at most ${MAX_MESSAGE_CHARS} characters`)
        }

        const sessions = await titledCorpus(ctx)
        const rules = rulesOf(config, store)
        const { linkId, peers } = peersFor({ sessionId: fromId, sessions, rules })
        const found = findPeer(argsOf(args, exec).target, peers)
        if (found.kind === 'missing') {
          const names = peers.length === 0 ? 'none' : peers.map((peer) => describePeer(peer, language)).join('; ')
          throw new Error(`send_session_message: no linked session matches "${String(argsOf(args, exec).target)}". Reachable: ${names}.`)
        }
        if (found.kind === 'ambiguous') {
          const names = found.matches.map((peer) => describePeer(peer, language)).join('; ')
          throw new Error(`send_session_message: "${String(argsOf(args, exec).target)}" matches more than one session: ${names}. Use the full id.`)
        }

        const sender = sessions.find((session) => session.id === fromId)
        const message = relayMessage({
          fromId,
          fromTitle: sender?.title,
          fromCwd: sender?.cwd,
          linkId,
          toId: found.peer.id,
          body,
          language,
        })
        const outcome = await deliver({ agents: ctx.agents, resumed }, { toId: found.peer.id, message })
        if (outcome.kind === 'failed') {
          return { delivered: false, target: found.peer.id, linkId, reason: outcome.reason }
        }
        // Record the exchange so the transcript can be read as plain text: an
        // AI-to-AI message must not be an opaque transfer the human cannot audit.
        await store?.recordRelay?.({ from: fromId, to: found.peer.id, link: linkId, body, title: sender?.title })
        return { delivered: true, target: found.peer.id, linkId, mode: outcome.agent }
      },
    })
  })
}

/**
 * Register `list_session_links`.
 *
 * Read-only. It exists because a model cannot pick a recipient it cannot see,
 * and because the scope is a human-editable thing the model should be able to
 * report accurately instead of guessing from its own transcript.
 *
 * @param {object} deps - the Host services and knobs.
 * @param {object} deps.ctx - the plugin context.
 * @param {object} deps.store - the durable link store.
 * @param {object} deps.config - the resolved plugin config.
 * @param {string} deps.language - the resolved language.
 */
export function installListTool(deps) {
  const { ctx, store, config, language } = deps

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'list_session_links',
      description:
        'List every session in this profile grouped by link, and say which link this session is on. A link is the unit of cross-session communication: sessions on the same link may message each other with send_session_message. Use this before sending, or to answer the human about which sessions are currently connected.',
      parameters: {
        type: 'object',
        properties: {
          onlyMine: {
            type: 'boolean',
            description: 'List only the sessions on this session\'s own link, instead of the whole profile. Defaults to false.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            linkId: { type: 'string', description: 'The link this session is on.' },
            peers: {
              type: 'array',
              description: 'The sessions this session may message.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                },
                required: ['id'],
                additionalProperties: true,
              },
            },
            report: { type: 'string', description: 'The full listing, as text.' },
          },
          required: ['linkId', 'peers', 'report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args, exec) {
        const fromId = callerOf(exec)
        const sessions = await titledCorpus(ctx)
        const rules = rulesOf(config, store)
        const focus = fromId ?? undefined
        const catalogue = buildCatalogue({
          sessions,
          rules,
          focus,
          manual: store?.manualSnapshot?.() ?? {},
          persisted: store?.error === undefined,
        })
        const ownLinks = focus === undefined ? [] : linksOfSession({ sessionId: focus, sessions, rules })
        const linkId = ownLinks[0]
        const peers = focus === undefined ? [] : peersFor({ sessionId: focus, sessions, rules }).peers

        if (argsOf(args, exec).onlyMine === true) {
          const report =
            linkId === undefined
              ? language === 'zh'
                ? '本会话当前不在任何链路上，因此没有可发消息的会话。用 set_session_link 指定一个链路名称即可加入。'
                : 'This session is on no link, so it has no peer to message. Name a link with set_session_link to join one.'
              : peers.length === 0
                ? language === 'zh'
                  ? `本会话在链路 ${linkId} 上，目前没有其他会话。`
                  : `This session is on link ${linkId}, with no other sessions.`
                : `${language === 'zh' ? '本会话链路' : "This session's link"} ${linkId}:\n` +
                  peers.map((peer) => `  - ${peer.id} · ${peer.title.length === 0 ? '—' : peer.title}`).join('\n')
          return { linkId: linkId ?? '', peers: peers.map(peerOf), report }
        }

        return {
          linkId: linkId ?? '',
          peers: peers.map(peerOf),
          report: describeCatalogue(catalogue, language),
        }
      },
    })
  })
}

/**
 * Register `set_session_link`.
 *
 * A session may move itself — never another session, and never the profile-wide
 * rules. The human's own control surface is the header panel; this tool exists
 * so an agent asked to "connect these sessions" can do it without the human
 * having to find the button.
 *
 * @param {object} deps - the Host services and knobs.
 * @param {object} deps.ctx - the plugin context.
 * @param {object} deps.store - the durable link store.
 * @param {object} deps.config - the resolved plugin config.
 * @param {string} deps.language - the resolved language.
 */
export function installLinkTool(deps) {
  const { ctx, store, config, language } = deps

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'set_session_link',
      description:
        'Put this session on a named link, keeping any links it is already on, or take it off every link (use "default" / "none"). Joining several links is allowed: each one widens who this session can reach. Sessions sharing any link can message each other; a session on no link has no peers at all. This only ever moves the calling session — another session has to move itself, or the human moves it from the session header.',
      parameters: {
        type: 'object',
        properties: {
          link: {
            type: 'string',
            description: 'The link to join, e.g. "review", "dir-src-1a2b3c". Use "default" or "none" to leave every link.',
          },
        },
        required: ['link'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            linkId: { type: 'string', description: 'The first link now in force for this session; an empty string means it is on no link.' },
            links: { type: 'array', items: { type: 'string' }, description: 'Every link this session is on now.' },
            joined: { type: 'boolean', description: 'Whether the session is now on an explicitly assigned link rather than the rules.' },
            peers: {
              type: 'array',
              description: 'The sessions this session may now message.',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, title: { type: 'string' } },
                required: ['id'],
                additionalProperties: true,
              },
            },
          },
          required: ['linkId', 'joined', 'peers'],
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.peers.length === 0
                ? `This session is now on link ${value.linkId}, with no other sessions on it.`
                : `This session is now on link ${value.linkId}, with ${value.peers.length} peer session(s): ${value.peers.map((peer) => shortId(peer.id)).join(', ')}.`,
          },
        ],
      },
      async execute(args, exec) {
        const fromId = callerOf(exec)
        if (fromId === undefined) throw new Error('set_session_link: no calling session to move')
        const raw = argsOf(args, exec).link
        // Clearing means leaving every link; there is no implicit default any more.
        const clear = typeof raw === 'string' && ['default', 'auto', 'none', ''].includes(raw.trim().toLowerCase())
        const linkId = clear ? null : normalizeLinkId(raw)
        if (!clear && linkId === undefined) {
          throw new Error(`set_session_link: "${String(raw)}" is not a usable link id; use lowercase letters, digits, dots, dashes, or underscores.`)
        }
        if (store === undefined) throw new Error('set_session_link: no link store is installed in this profile')
        await store.setLink(fromId, linkId)

        const sessions = await titledCorpus(ctx)
        const rules = rulesOf(config, store)
        const effective = linksOfSession({ sessionId: fromId, sessions, rules })
        const effectiveId = effective[0]
        const peers = peersFor({ sessionId: fromId, sessions, rules }).peers
        void language
        return {
          linkId: effectiveId ?? '',
          links: effective,
          joined: effective.length > 0,
          peers: peers.map(peerOf),
        }
      },
    })
  })
}

/**
 * Install the standing context line.
 *
 * Empty when the session has no peer — an isolated session must not be told on
 * every step that it is alone, and the line must never be a reason for a model
 * to look for a recipient that does not exist.
 *
 * @param {object} deps - the wiring.
 * @param {object} deps.ctx - the plugin context.
 * @param {object} deps.store - the durable link store.
 * @param {object} deps.config - the resolved plugin config.
 * @param {string} deps.language - the resolved language.
 */
export function installContext(deps) {
  const { ctx, store, config, language } = deps
  /** Peer line per session, filled asynchronously and read synchronously. */
  const cache = new Map()

  /**
   * Recompute one session's peer line.
   *
   * This runs on the microtask queue rather than inside prompt assembly: the
   * harness calls a context provider's `text` **synchronously** and never awaits
   * it, so an async text would either inject a Promise into the system prompt or
   * be dropped entirely. The work therefore happens here, and `text` only ever
   * reads the finished answer — at worst one step behind, which for a standing
   * "who can I talk to" line is imperceptible and is never wrong about who is
   * actually reachable.
   *
   * @param {string} sessionId - the session to describe.
   */
  const refresh = async (sessionId) => {
    try {
      const sessions = await titledCorpus(ctx)
      const rules = rulesOf(config, store)
      const { linkId, peers } = peersFor({ sessionId, sessions, rules })
      cache.set(sessionId, { text: contextText({ linkId, peers: peers.map(peerOf), language }), at: Date.now() })
    } catch {
      // A context line is an optimization: a failed refresh must never break
      // prompt assembly, so the previous answer, or none, simply stays.
    }
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    let order = DELEGATION_CONTEXT_ORDER + 2
    try {
      order = promptCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 2
    } catch {
      /* A harness without that placement keeps the documented fallback order. */
    }
    promptCtx.systemPrompt.context({
      name: 'session-link:peers',
      order,
      text: (context) => {
        const agent = context.agent ?? context.scope
        const sessionId = agent?.session?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
        const known = cache.get(sessionId)
        // A first step, or a stale line: refresh behind the scenes and answer
        // with what is known. An isolated session is never told on every step
        // that it is alone.
        if (known === undefined || Date.now() - known.at > PEER_CACHE_TTL_MS) void refresh(sessionId)
        return known?.text ?? ''
      },
    })
  })
  return { refresh, cache }
}

/**
 * Install the whole plugin.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the resolved plugin config.
 * @param {object} [options] - test seams.
 * @param {object} [options.store] - an explicit link store.
 * @returns the store this plugin owns.
 */
export function apply(ctx, config, options = {}) {
  const language = resolveLanguage(configValue(config.language))
  const store = options.store
  /** Handles this plugin resumed, so a reply can reuse one agent rather than racing for the session. */
  const resumed = new Map()

  ctx.effect(
    () => () => {
      for (const handle of resumed.values()) {
        try {
          void handle.dispose()
        } catch {
          /* a handle that cannot be disposed is already gone */
        }
      }
      resumed.clear()
    },
    'session-link: resumed agents',
  )

  if (configValue(config.contextLine) !== false) installContext({ ctx, store, config, language })
  if (configValue(config.linkTools) !== false) {
    installSendTool({ ctx, store, config, resumed, language })
    installListTool({ ctx, store, config, language })
    installLinkTool({ ctx, store, config, language })
  }
  return { store, resumed }
}

export { sendDescription }
