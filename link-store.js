/**
 * The durable link store: one JSON file per plugin, in `$DSH_HOME/plugin-data`.
 *
 * Two things live here, and they are different in kind:
 *
 * - **Knobs** — the profile-wide defaults the Settings page edits (`auto`,
 *   `defaultLink`). Volatile: an edit applies to the next step, no reload.
 * - **Assignments** — which session is on which link. Durable: written by the
 *   header control, by the agent's own tools, and by the HTTP bridge, so it must
 *   survive a plugin reload, a page refresh, and an application restart.
 *
 * Durability rules:
 * - a missing, unreadable, or damaged file reads as "no assignments", never as
 *   an error, so a bad write can never take the plugin down;
 * - writes are serialized through one promise chain and land by atomic rename,
 *   so a crash mid-write leaves the previous file intact;
 * - the in-memory map is the read path, so a render never waits on the disk.
 *
 * @module dsh-interlink/link-store
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { normalizeLinkId } from './link.js'

/** File format version, so a future shape can migrate instead of guessing. */
export const STORE_VERSION = 1

/** How many manual links a human may pin, so one file cannot grow without bound. */
export const MAX_MANUAL_LINKS = 50

/** How many relays are kept for the transcript, so the log stays bounded. */
export const MAX_RELAY_LOG = 200

/**
 * Where this plugin keeps its data.
 *
 * Follows the other installed plugins' convention (`$DSH_HOME/plugin-data/<id>`)
 * so an operator can find and back up one directory for every plugin. The home
 * is `$DSH_HOME` when the Host exports it; the desktop application does not, so
 * the fallbacks below walk to the same directory the application itself uses.
 *
 * @param {string} [home] - explicit `$DSH_HOME`, for tests.
 * @returns {string} the absolute file path.
 */
export function storePath(home) {
  const base = home ?? process.env.DSH_HOME ?? defaultHome()
  return join(base, 'plugin-data', 'session-link', 'config.json')
}

/** The harness home when the environment does not say: `~/.dsh`, or the desktop profile's parent. */
function defaultHome() {
  const fallback = join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE_DIR
  return typeof profile === 'string' && profile.length > 0 ? dirname(profile) : fallback
}

/**
 * Normalize one parse result into the in-memory shape.
 *
 * @param {unknown} parsed - decoded JSON.
 * @returns {{ sessions: Map<string, string>, manual: Map<string, string[]>, knobs: object }} the store contents.
 */
export function normalizeStore(parsed) {
  const sessions = new Map()
  const manual = new Map()
  /** Named links that exist even with no members: a link outlives its members. */
  const links = new Set()
  const knobs = {}
  const source = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}

  const rawSessions = source.sessions
  if (rawSessions !== null && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
    for (const [sessionId, value] of Object.entries(rawSessions)) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue
      // A session may be on several links at once. The file keeps a bare string
      // for the older single-link shape and an array for the current one.
      const ids = (Array.isArray(value) ? value : [value])
        .map((entry) => normalizeLinkId(entry))
        .filter((entry) => entry !== undefined)
      if (ids.length > 0) sessions.set(sessionId, ids)
    }
  }

  const rawManual = source.manual
  if (rawManual !== null && typeof rawManual === 'object' && !Array.isArray(rawManual)) {
    for (const [rawLinkId, members] of Object.entries(rawManual)) {
      const linkId = normalizeLinkId(rawLinkId)
      if (linkId === undefined || !Array.isArray(members) || manual.size >= MAX_MANUAL_LINKS) continue
      const unique = []
      for (const member of members) {
        if (typeof member !== 'string' || member.length === 0 || unique.includes(member)) continue
        unique.push(member)
      }
      manual.set(linkId, unique)
    }
  }

  const relays = []
  const rawRelays = source.relays
  if (Array.isArray(rawRelays)) {
    for (const entry of rawRelays) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.from !== 'string' || typeof entry.to !== 'string' || typeof entry.body !== 'string') continue
      relays.push({
        at: typeof entry.at === 'number' ? entry.at : 0,
        from: entry.from,
        to: entry.to,
        link: typeof entry.link === 'string' ? entry.link : '',
        body: entry.body,
        title: typeof entry.title === 'string' ? entry.title : '',
      })
      if (relays.length >= MAX_RELAY_LOG) break
    }
  }

  const rawLinks = source.links
  if (Array.isArray(rawLinks)) {
    for (const value of rawLinks) {
      const linkId = normalizeLinkId(value)
      if (linkId !== undefined) links.add(linkId)
    }
  }

  const rawKnobs = source.knobs
  if (rawKnobs !== null && typeof rawKnobs === 'object' && !Array.isArray(rawKnobs)) {
    if (typeof rawKnobs.auto === 'boolean') knobs.auto = rawKnobs.auto
    const defaultLink = normalizeLinkId(rawKnobs.defaultLink)
    if (defaultLink !== undefined) knobs.defaultLink = defaultLink
  }

  return { sessions, manual, links, relays, knobs }
}

/**
 * Serialize the store into the file body.
 *
 * Every map is sorted so the file is diff-friendly and a rewrite of unchanged
 * content produces identical bytes.
 *
 * @param {object} state - `{ sessions, manual, knobs }`.
 * @returns {string} the JSON text, newline-terminated.
 */
export function serializeStore(state) {
  const links = [...(state.links?.values?.() ?? [])]
  const relays = Array.isArray(state.relays) ? state.relays : []
  const sessions = {}
  for (const sessionId of [...state.sessions.keys()].sort()) sessions[sessionId] = [...(state.sessions.get(sessionId) ?? [])].sort()
  const manual = {}
  for (const linkId of [...state.manual.keys()].sort()) manual[linkId] = [...state.manual.get(linkId)]
  const knobs = {}
  if (typeof state.knobs?.auto === 'boolean') knobs.auto = state.knobs.auto
  if (typeof state.knobs?.defaultLink === 'string') knobs.defaultLink = state.knobs.defaultLink
  // links records which named links exist, so a link keeps existing between
  // the moment it is created and the moment its first member joins it.
  // `relays` is the transcript of AI-to-AI messages: the panel reads it so the
  // exchange is visible as plain text instead of an opaque side channel.
  return `${JSON.stringify({ version: STORE_VERSION, knobs, links: [...links].sort(), relays, sessions, manual }, null, 2)}\n`
}

/**
 * Create the link store.
 *
 * @param {object} [options] - test seams.
 * @param {string} [options.file] - explicit store path.
 * @param {string} [options.home] - explicit `$DSH_HOME`.
 * @returns the store: synchronous reads, queued writes.
 */
export function createLinkStore(options = {}) {
  const file = options.file ?? storePath(options.home)
  /** @type {Map<string, string>} */
  const sessions = new Map()
  /** @type {Map<string, string[]>} */
  const manual = new Map()
  /** Named links that exist independently of who is on them. */
  const links = new Set()
  /** The AI-to-AI transcript, oldest first, bounded by MAX_RELAY_LOG. */
  const relays = []
  /** @type {{ auto?: boolean, defaultLink?: string }} */
  const knobs = {}
  let loaded = false
  let loading
  /** Tail of the write chain; every write appends to it so file order is call order. */
  let queue = Promise.resolve()
  let lastError
  /** Whether the load adopted links that the file did not record yet. */
  let adoptedLinks = false

  /** Read the file once. Never throws. */
  const load = () => {
    if (loaded) return Promise.resolve()
    if (loading !== undefined) return loading
    loading = (async () => {
      try {
        const text = await readFile(file, 'utf8')
        const state = normalizeStore(JSON.parse(text))
        for (const [sessionId, ids] of state.sessions) {
          sessions.set(sessionId, ids)
          // A store written before links were recorded separately still names its
          // links through assignments; adopt them so they stay joinable.
          for (const linkId of ids) links.add(linkId)
        }
        for (const [linkId, members] of state.manual) manual.set(linkId, members)
        for (const linkId of state.links) links.add(linkId)
        for (const entry of state.relays) relays.push(entry)
        Object.assign(knobs, state.knobs)
        // An adopted registry must reach the disk, but `write` is declared below
        // and a load must never race its own store: the caller persists it once
        // the load promise settles.
        adoptedLinks = [...links].some((linkId) => !state.links.has(linkId))
      } catch (error) {
        // A corrupt file must not disable the feature: it reads as empty, and the
        // next write replaces it wholesale. `error` therefore stays undefined —
        // a store that reports a failure here would make every surface say the
        // assignments are unsaved when nothing is wrong with this run.
      } finally {
        loaded = true
        loading = undefined
      }
    })()
    return loading
  }

  /** Persist the current state, atomically, through the queue. */
  const write = () => {
    const body = serializeStore({ sessions, manual, links, relays, knobs })
    queue = queue.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, file)
        lastError = undefined
      } catch (error) {
        lastError = error
        throw error
      }
    })
    return queue
  }

  return {
    /** The file this store reads and writes. */
    file,

    /** The last write failure, or `undefined` after a successful write. */
    get error() {
      return lastError
    },

    /** Load the file if it has not been loaded yet. */
    /**
     * Load the file if it has not been loaded yet, persisting a registry adopted
     * from assignments so a later run reads the same links back.
     */
    ready: async () => {
      await load()
      if (adoptedLinks) {
        adoptedLinks = false
        await write()
      }
    },

    /**
     * The link recorded for one session.
     *
     * @param {string} sessionId - the session.
     * @returns {string | undefined} the recorded link, or `undefined` when the session follows the rules.
     */
    linkOf(sessionId) {
      // The single-value reading kept for existing callers; a session on several
      // links answers its first one. Use linksOf for the whole set.
      return [...(sessions.get(sessionId) ?? [])][0]
    },

    /**
     * Every link one session is on.
     *
     * A session may join several links at once, so this is the whole answer
     * where {@link linkOf} keeps the older single-value shape for callers that
     * only need one (the first, in store order).
     *
     * @param {string} sessionId - the session.
     * @returns {string[]} its links, empty when it is on none.
     */
    linksOf(sessionId) {
      return [...(sessions.get(sessionId) ?? [])]
    },

    /**
     * Record, or clear, one session's link.
     *
     * @param {string} sessionId - the session.
     * @param {string | null} linkId - the link, or `null` to fall back to the rules.
     * @returns {Promise<void>} completion of the write.
     */
    async setLink(sessionId, linkId) {
      await load()
      if (linkId === null || linkId === undefined) {
        // Clearing means leaving every link, which is the old behaviour and the
        // "leave all" control. To leave one link, use {@link leaveLink}.
        sessions.delete(sessionId)
      } else {
        sessions.set(sessionId, [linkId])
        // Naming a link creates it: it stays listed after this session leaves.
        links.add(linkId)
      }
      await write()
    },

    /**
     * Join one link, keeping any other links this session is already on.
     *
     * @param {string} sessionId - the session.
     * @param {string} linkId - the link to join.
     * @returns {Promise<void>} completion of the write.
     */
    async joinLink(sessionId, linkId) {
      await load()
      const current = sessions.get(sessionId) ?? []
      if (!current.includes(linkId)) {
        sessions.set(sessionId, [...current, linkId].sort())
        links.add(linkId)
        await write()
      }
    },

    /**
     * Leave one link, keeping the session on any others.
     *
     * @param {string} sessionId - the session.
     * @param {string} linkId - the link to leave.
     * @returns {Promise<void>} completion of the write.
     */
    async leaveLink(sessionId, linkId) {
      await load()
      const current = sessions.get(sessionId) ?? []
      const remaining = current.filter((entry) => entry !== linkId)
      if (remaining.length === 0) sessions.delete(sessionId)
      else sessions.set(sessionId, remaining)
      await write()
    },

    /**
     * Record, or clear, several sessions' links in one write.
     *
     * @param {Array<{ sessionId: string, linkId: string | null }>} assignments - the edits.
     * @returns {Promise<void>} completion of the one write.
     */
    async setLinks(assignments) {
      await load()
      for (const { sessionId, linkId } of assignments) {
        if (linkId === null || linkId === undefined) sessions.delete(sessionId)
        else sessions.set(sessionId, [linkId])
      }
      await write()
    },

    /** Every recorded session → link assignment, newest-write order. */
    snapshot() {
      const out = {}
      for (const sessionId of [...sessions.keys()].sort()) out[sessionId] = [...sessions.get(sessionId)]
      return out
    },

    /** Every recorded relay, oldest first. */
    relaysSnapshot() {
      return relays.map((entry) => ({ ...entry }))
    },

    /**
     * Append one relay to the transcript.
     *
     * The panel shows these as plain text so a human can read what two agents
     * actually said to each other instead of trusting an opaque transfer. The
     * log is bounded: the oldest entry is dropped once it is full.
     *
     * @param {object} entry - the relay facts.
     * @param {string} entry.from - sender session id.
     * @param {string} entry.to - recipient session id.
     * @param {string} entry.link - the link it travelled on.
     * @param {string} entry.body - the message text, verbatim.
     * @param {string} [entry.title] - sender title, when known.
     * @returns {Promise<void>} completion of the write.
     */
    async recordRelay(entry) {
      await load()
      relays.push({
        at: Date.now(),
        from: entry.from,
        to: entry.to,
        link: entry.link ?? '',
        body: entry.body ?? '',
        title: entry.title ?? '',
      })
      while (relays.length > MAX_RELAY_LOG) relays.shift()
      await write()
    },

    /** Every named link, sorted, whether or not anyone is on it. */
    linksSnapshot() {
      return [...links].sort()
    },

    /**
     * Create a named link without putting anyone on it.
     *
     * A link used to exist only while some session was on it, so creating one and
     * leaving it looked identical to doing nothing. Naming it records the link
     * itself, which is what lets another session join it later.
     *
     * @param {string} linkId - the normalized link id.
     * @returns {Promise<boolean>} whether the write created something new.
     */
    async createLink(linkId) {
      await load()
      const created = !links.has(linkId)
      links.add(linkId)
      if (created) await write()
      return created
    },

    /**
     * Delete a named link, moving nobody: members keep their assignment until they
     * are moved, and an empty link disappears.
     *
     * @param {string} linkId - the link to forget.
     * @returns {Promise<void>} completion of the write.
     */
    async removeLink(linkId) {
      await load()
      links.delete(linkId)
      manual.delete(linkId)
      await write()
    },

    manualSnapshot() {
      return Object.fromEntries([...manual.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, members]) => [id, [...members]]))
    },

    /**
     * Add one session to a human-pinned link.
     *
     * A pinned link is a hand-made grouping: it exists exactly because these
     * sessions belong together, so joining it also records the membership the
     * session would otherwise derive from the rules. Membership is one-per-session
     * across the whole store, so joining a pinned link leaves any other.
     *
     * @param {string} linkId - the pinned link.
     * @param {string} sessionId - the session to add.
     * @returns {Promise<void>} completion of the write.
     */
    async addMember(linkId, sessionId) {
      await load()
      for (const [otherId, members] of manual) {
        if (otherId === linkId) continue
        const index = members.indexOf(sessionId)
        if (index >= 0) members.splice(index, 1)
        if (members.length === 0) manual.delete(otherId)
      }
      const members = manual.get(linkId) ?? []
      if (!members.includes(sessionId)) members.push(sessionId)
      manual.set(linkId, members)
      // Joining a link by name is what brings it into existence.
      links.add(linkId)
      const current = sessions.get(sessionId) ?? []
      if (!current.includes(linkId)) sessions.set(sessionId, [...current, linkId].sort())
      await write()
    },

    /**
     * Remove one session from a human-pinned link, or from the store entirely.
     *
     * @param {string} linkId - the pinned link, or `null` for "wherever it is".
     * @param {string} sessionId - the session to remove.
     * @returns {Promise<void>} completion of the write.
     */
    async removeMember(linkId, sessionId) {
      await load()
      if (linkId === null || linkId === undefined) {
        sessions.delete(sessionId)
        for (const [otherId, members] of manual) {
          const index = members.indexOf(sessionId)
          if (index >= 0) members.splice(index, 1)
          if (members.length === 0) manual.delete(otherId)
        }
      } else {
        const members = manual.get(linkId)
        if (members !== undefined) {
          const index = members.indexOf(sessionId)
          if (index >= 0) members.splice(index, 1)
          if (members.length === 0) manual.delete(linkId)
        }
        const current = sessions.get(sessionId) ?? []
        const remaining = current.filter((entry) => entry !== linkId)
        if (remaining.length === 0) sessions.delete(sessionId)
        else sessions.set(sessionId, remaining)
      }
      await write()
    },

    /** The recorded knobs. */
    knobSnapshot() {
      return { ...knobs }
    },

    /**
     * Record one knob; `undefined` clears it back to the config default.
     *
     * @param {'auto' | 'defaultLink'} key - the knob.
     * @param {unknown} value - the value.
     * @returns {Promise<void>} completion of the write.
     */
    async setKnob(key, value) {
      await load()
      if (value === undefined || value === null) delete knobs[key]
      else knobs[key] = value
      await write()
    },

    /**
     * The default link id recorded by the rules, when one was chosen.
     *
     * There is no built-in default any more: a session nobody named is on no
     * link, so this answers `undefined` until a human sets one.
     */
    get defaultLink() {
      return knobs.defaultLink
    },
  }
}
