/**
 * Behavioural tests for Session Link with a stubbed Cordis context.
 *
 * The plugin entry point is imported for `apply` only; the tests build plain
 * config objects (the shape a resolved Cordis config has: volatile fields are
 * getters) so this file needs no Harness packages.
 *
 * The store tests use a real file inside a temporary directory — the store's
 * whole job is durability, so a fake filesystem would test the wrong thing. The
 * route tests use plain object fakes for `req`/`res` instead of a live HTTP
 * server, because the handlers only read a handful of fields and write two.
 *
 * Run with: node test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, deliver, rulesOf as pluginRulesOf } from './plugin.js'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_LINK_ID,
  MAX_LINK_ID,
  MAX_MESSAGE_CHARS,
  cwdLinkId,
  configValue,
  contextText,
  describePeer,
  hash32,
  linkOf,
  normalizeLinkId,
  peersOf,
  relaySummary,
  relayText,
  resolveTarget,
  sameProject,
  validateMessage,
} from './link.js'
import {
  MAX_MANUAL_LINKS,
  STORE_VERSION,
  createLinkStore,
  normalizeStore,
  serializeStore,
  storePath,
} from './link-store.js'
import {
  buildCatalogue,
  describeCatalogue,
  foldLinks,
  linksOfSession,
  peersFor,
  readTitles,
  settleLater,
  withTitles,
} from './catalogue.js'
import { createRoutes, guardRequest, parseLinkInput, sessionView } from './routes.js'

let failures = 0
let passes = 0

/** One test case, reported as it settles. */
async function test(label, body) {
  try {
    await body()
    passes += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}`)
    console.log(`     ${error instanceof Error ? error.stack : String(error)}`)
  }
}

/**
 * A store that puts every listed session on one named link.
 *
 * A session nobody named is on no link now (linkOf returns undefined), so a test
 * about relaying between peers has to say which link they share. The store is
 * temporary and removed by the registry teardown below.
 */
async function linkedStore(sessionIds, linkId = 'review') {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-linked-'))
  const store = createLinkStore({ file: join(dir, 'config.json') })
  await store.ready()
  for (const sessionId of sessionIds) await store.setLink(sessionId, linkId)
  return store
}

/** A temporary store file, cleaned up after the test. */
async function withStore(body) {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-'))
  try {
    const store = createLinkStore({ file: join(dir, 'config.json') })
    await store.ready()
    await body(store, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A resolved-config stand-in with plain values.
 *
 * Cordis hands a plugin a plain resolved value for ordinary fields, but wraps
 * a .volatile() field in a live reference that it hot-updates in place when
 * Settings writes it (see configValue and volatileRef). Most tests use plain
 * values; the reference regression feeds volatileRef so it matches the shape
 * the Host really passes for a Settings-editable switch.
 */
function configOf(values = {}) {
  const resolved = {
    autoLinks: true,
    linkTools: true,
    contextLine: true,
    crossProject: false,
    headerControl: true,
    allowRemoteClients: false,
    language: 'en',
    maxMessageChars: 8000,
    ...values,
  }
  return resolved
}

/** A stand-in for Cordis's live volatile reference, updated in place. */
function volatileRef(initial) {
  const box = { value: initial }
  return { get: () => box.value, box }
}

/**
 * One `listSessions()` record, in the shape the Host actually returns.
 *
 * `sessionId` is the DTO's field name — not `id` — which is why every record
 * built here carries it: a fixture that had to be hand-mapped would stop
 * catching the day the Host renames the field back.
 */
function sessionRecord(id, extra = {}) {
  const { title, ...rest } = extra
  return { sessionId: id, title, createdAt: 0, updatedAt: 0, running: false, blank: false, cwd: '', ...rest }
}

/** A session row as the catalogue sees it, for assertions on its output. */
function session(id, extra = {}) {
  return { id, title: extra.title ?? '', cwd: extra.cwd ?? '', running: extra.running ?? false, blank: false, updatedAt: 0, ...extra }
}

/** A `sessionQuery` fake over a fixed list. */
function queryOf(records, titles = {}) {
  return {
    async listSessions() {
      return records
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => {
        const title = titles[sessionId]
        return title === undefined ? { sessionId, status: 'rejected', reason: new Error('no title') } : { sessionId, status: 'fulfilled', value: { title } }
      })
    },
  }
}

/** An Agent fake with an inbox. */
function agent(id, inbox = []) {
  return {
    id,
    session: { id },
    async followup(input) {
      inbox.push(input)
    },
  }
}

// ---------------------------------------------------------------------------
// link.js — the rules
// ---------------------------------------------------------------------------

await test('an unconfigured session is on no link at all', () => {
  assert.equal(linkOf({ sessionId: 'session-a' }), undefined)
})

await test('a named link is the only way onto one', () => {
  assert.equal(linkOf({ sessionId: 'session-a', overrides: { 'session-a': 'review' } }), 'review')
  // and the folder rule stops being consulted when nobody enables it
  assert.equal(linkOf({ sessionId: 'session-a', cwd: 'E:/yy/one', auto: false }), undefined)
})

await test('a recorded assignment beats the cwd rule', () => {
  const overrides = new Map([['session-a', 'review']])
  assert.equal(linkOf({ sessionId: 'session-a', cwd: 'E:/yy/project', overrides, auto: true }), 'review')
})

await test('the cwd rule groups sessions that share a directory', () => {
  const a = linkOf({ sessionId: 'session-a', cwd: 'E:/yy/project', auto: true })
  const b = linkOf({ sessionId: 'session-b', cwd: 'E:/yy/project/', auto: true })
  assert.equal(a, b)
  assert.match(a, /^dir-project-/)
})

await test('the cwd rule keeps different directories apart', () => {
  const a = linkOf({ sessionId: 'session-a', cwd: 'E:/yy/one', auto: true })
  const b = linkOf({ sessionId: 'session-b', cwd: 'E:/yy/two', auto: true })
  assert.notEqual(a, b)
})

await test('the cwd rule never merges sessions with no directory', () => {
  const a = linkOf({ sessionId: 'session-a', auto: true })
  const b = linkOf({ sessionId: 'session-b', cwd: '', auto: true })
  // With no directory there is no project to group, so neither session is linked.
  assert.equal(a, undefined)
  assert.equal(b, undefined)
})

await test('cwdLinkId is stable and case-insensitive', () => {
  assert.equal(cwdLinkId('E:\\yy\\Project'), cwdLinkId('e:/yy/project'))
  assert.equal(cwdLinkId('E:\\yy\\Project'), cwdLinkId('e:/yy/project/'))
  assert.notEqual(cwdLinkId('E:/a/src'), cwdLinkId('E:/b/src'))
})

await test('hash32 is deterministic', () => {
  assert.equal(hash32('abc'), hash32('abc'))
  assert.notEqual(hash32('abc'), hash32('abd'))
})

await test('normalizeLinkId accepts readable ids and rejects the rest', () => {
  assert.equal(normalizeLinkId('  Review '), 'review')
  assert.equal(normalizeLinkId('dir-a-1b2c'), 'dir-a-1b2c')
  assert.equal(normalizeLinkId('a_b.c-d'), 'a_b.c-d')
  assert.equal(normalizeLinkId(''), undefined)
  assert.equal(normalizeLinkId('has space'), undefined)
  assert.equal(normalizeLinkId('-leading'), undefined)
  assert.equal(normalizeLinkId('../escape'), undefined)
  assert.equal(normalizeLinkId('x'.repeat(MAX_LINK_ID + 1)), undefined)
  assert.equal(normalizeLinkId(42), undefined)
})

await test('peersOf excludes the asking session', () => {
  assert.deepEqual(peersOf('session-b', ['session-a', 'session-b', 'session-c']), ['session-a', 'session-c'])
})

await test('resolveTarget accepts an exact id, a unique prefix, and refuses ambiguity', () => {
  const candidates = ['session-aaaa', 'session-abbb']
  assert.deepEqual(resolveTarget('session-abbb', candidates), { kind: 'exact', id: 'session-abbb' })
  assert.deepEqual(resolveTarget('session-aa', candidates), { kind: 'exact', id: 'session-aaaa' })
  assert.deepEqual(resolveTarget('session-a', candidates), { kind: 'ambiguous', matches: candidates })
  assert.deepEqual(resolveTarget('session-z', candidates), { kind: 'missing' })
  assert.deepEqual(resolveTarget('', candidates), { kind: 'missing' })
})

await test('validateMessage rejects empty and oversized bodies', () => {
  assert.deepEqual(validateMessage('  hi  '), { kind: 'ok', text: 'hi' })
  assert.equal(validateMessage('').kind, 'invalid')
  assert.equal(validateMessage('   ').kind, 'invalid')
  assert.equal(validateMessage(7).kind, 'invalid')
  assert.equal(validateMessage('x'.repeat(MAX_MESSAGE_CHARS)).kind, 'ok')
  assert.equal(validateMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)).kind, 'invalid')
})

await test('relaySummary is clipped and names both ends', () => {
  const summary = relaySummary('session-aaaaaaaaaaaa', 'session-bbbbbbbbbbbb', 'main')
  assert.match(summary, /^link main: /)
  assert.ok(summary.length <= 120)
})

await test('describePeer prefers the title and falls back to the id', () => {
  assert.equal(describePeer({ id: 'session-abcdefghijklmnop' }, 'en'), 'session-abcdef')
  assert.equal(describePeer({ id: 'session-abcdefghijklmnop', title: 'Refactor' }, 'en'), 'Refactor, session-abcdef')
  assert.equal(describePeer({ id: 'session-abcdefghijklmnop', title: 'Refactor', cwd: 'E:/yy/one' }, 'zh'), 'Refactor，session-abcdef，one')
})

await test('relayText frames the body and attributes the sender', () => {
  const text = relayText({ fromId: 'session-abcdefghijklmnop', fromTitle: 'Planner', linkId: 'main', body: 'ping', language: 'en' })
  assert.match(text, /\[Session Link\] Planner, session-abcdef \(link main\) sent a message:/)
  assert.match(text, /<<<\nping\n>>>/)
  assert.match(text, /send_session_message/)
  const zh = relayText({ fromId: 'session-abcdefghijklmnop', linkId: 'main', body: 'ping', language: 'zh' })
  assert.match(zh, /\[会话互联\]/)
})

await test('contextText is empty without peers and names them with', () => {
  assert.equal(contextText({ linkId: 'main', peers: [], language: 'en' }), '')
  const text = contextText({ linkId: 'main', peers: [{ id: 'session-b', title: 'Review' }], language: 'en' })
  assert.match(text, /link main, together with 1 other session/)
  assert.match(text, /Review/)
  assert.match(contextText({ linkId: 'main', peers: [{ id: 'session-b' }], language: 'zh' }), /会话互联/)
})

// ---------------------------------------------------------------------------
// link-store.js — durability
// ---------------------------------------------------------------------------

await test('storePath follows the plugin-data convention', () => {
  assert.match(storePath('/tmp/home'), /plugin-data[\\/]session-link[\\/]config.json$/)
})

await test('parse rejects damage without throwing', () => {
  assert.equal(normalizeStore(null).sessions.size, 0)
  assert.equal(normalizeStore([]).sessions.size, 0)
  assert.equal(normalizeStore({ sessions: 'nope' }).sessions.size, 0)
  const parsed = normalizeStore({ sessions: { 'session-a': 'review', 'session-b': 'BAD ID' }, manual: { ok: ['session-c', 'session-c', 7] } })
  assert.deepEqual([...parsed.sessions.entries()], [['session-a', ['review']]])
  assert.deepEqual(parsed.manual.get('ok'), ['session-c'])
})

await test('serializeStore is sorted and stable', () => {
  const state = {
    sessions: new Map([
      ['session-b', 'two'],
      ['session-a', 'one'],
    ]),
    manual: new Map([['two', ['session-b']]]),
    knobs: { auto: false },
  }
  const text = serializeStore(state)
  assert.equal(text, serializeStore(state))
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, STORE_VERSION)
  assert.deepEqual(Object.keys(parsed.sessions), ['session-a', 'session-b'])
  assert.equal(parsed.knobs.auto, false)
})

await withStore(async (store, dir) => {
  await test('a recorded link survives a reload', async () => {
    await store.setLink('session-a', 'review')
    const reopened = createLinkStore({ file: join(dir, 'config.json') })
    await reopened.ready()
    assert.equal(reopened.linkOf('session-a'), 'review')
  })

  await test('clearing a link removes the key rather than writing a null', async () => {
    await store.setLink('session-b', 'review')
    await store.setLink('session-b', null)
    const parsed = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    assert.equal(Object.hasOwn(parsed.sessions ?? {}, 'session-b'), false)
  })

  await test('setLinks writes a batch in one pass', async () => {
    await store.setLinks([
      { sessionId: 'session-c', linkId: 'trio' },
      { sessionId: 'session-d', linkId: 'trio' },
    ])
    assert.deepEqual(store.snapshot()['session-c'], ['trio'])
    assert.deepEqual(store.snapshot()['session-d'], ['trio'])
  })

  await test('a pinned link keeps its members and moves them off other pinned links', async () => {
    await store.addMember('pair', 'session-e')
    await store.addMember('pair', 'session-f')
    await store.addMember('other', 'session-f')
    assert.deepEqual(store.manualSnapshot().pair, ['session-e'])
    assert.deepEqual(store.manualSnapshot().other, ['session-f'])
    assert.equal(store.linkOf('session-f'), 'other')
  })

  await test('removing a member empties the pinned link', async () => {
    await store.addMember('solo', 'session-g')
    await store.removeMember('solo', 'session-g')
    assert.equal(store.manualSnapshot().solo, undefined)
    assert.equal(store.linkOf('session-g'), undefined)
  })

  await test('a damaged file reads as empty, not as an error', async () => {
    await writeFile(join(dir, 'config.json'), '{ this is not json', 'utf8')
    const reopened = createLinkStore({ file: join(dir, 'config.json') })
    await reopened.ready()
    assert.deepEqual(reopened.snapshot(), {})
    assert.equal(reopened.error, undefined)
  })

  await test('a write after damage repairs the file', async () => {
    const reopened = createLinkStore({ file: join(dir, 'config.json') })
    await reopened.ready()
    await reopened.setLink('session-h', 'repaired')
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).sessions['session-h'], ['repaired'])
  })

  await test('knobs round-trip and fall back when cleared', async () => {
    await store.setKnob('auto', false)
    assert.equal(store.knobSnapshot().auto, false)
    await store.setKnob('auto', undefined)
    assert.deepEqual(store.knobSnapshot(), {})
  })
})

await test('MAX_MANUAL_LINKS bounds the pinned-link map', () => {
  const manual = {}
  for (let index = 0; index < MAX_MANUAL_LINKS + 5; index += 1) manual[`link-${index}`] = ['session-x']
  assert.equal(normalizeStore({ manual }).manual.size, MAX_MANUAL_LINKS)
})

// ---------------------------------------------------------------------------
// catalogue.js — the answer every surface reads
// ---------------------------------------------------------------------------

await test('subagent sessions are filtered out of the corpus listing', async () => {
  const query = queryOf([
    { sessionId: 'session-root', createdAt: 3 },
    { sessionId: 'session-kid', createdAt: 2, origin: 'subagent' },
    { sessionId: 'session-old', createdAt: 1 },
  ])
  const { readCorpus } = await import('./catalogue.js')
  const sessions = await readCorpus({ sessionQuery: query })
  assert.deepEqual(sessions.map((row) => row.id), ['session-root', 'session-old'])
  const all = await readCorpus({ sessionQuery: query }, { includeSubagents: true })
  assert.equal(all.length, 3)
})

await test('readTitles isolates a failed title read', async () => {
  const query = queryOf([], { 'session-a': 'Alpha' })
  const titles = await readTitles(query, ['session-a', 'session-b'])
  assert.equal(titles.get('session-a'), 'Alpha')
  assert.equal(titles.has('session-b'), false)
})

await test('readTitles survives a throwing query', async () => {
  const titles = await readTitles(
    {
      async readTitleSnapshots() {
        throw new Error('boom')
      },
    },
    ['session-a'],
  )
  assert.equal(titles.size, 0)
})

await test('withTitles marks sessions whose title was not read', () => {
  const rows = withTitles([session('session-a'), session('session-b')], new Map([['session-a', 'Alpha']]), ['session-a'])
  assert.equal(rows[0].title, 'Alpha')
  assert.equal(rows[1].lazy, true)
})

await test('foldLinks groups named links and leaves unlinked sessions out', () => {
  const rows = [session('session-a', { cwd: 'E:/yy/one' }), session('session-b', { cwd: 'E:/yy/one' }), session('session-c')]
  const groups = foldLinks(rows, { auto: true, overrides: {} })
  // Only the two sessions that share a directory form a link; session-c is on none.
  assert.equal(groups.size, 1)
  assert.equal(groups.get(cwdLinkId('E:/yy/one')).length, 2)
})

await test('a session absent from the corpus still has a link', () => {
  const linkIds = linksOfSession({ sessionId: 'session-new', sessions: [], rules: { auto: true, overrides: { 'session-new': 'review' } } })
  assert.deepEqual(linkIds, ['review'])
})

await test('peersFor returns the other members of the same link only', () => {
  const rows = [session('session-a', { cwd: 'E:/yy/one' }), session('session-b', { cwd: 'E:/yy/one' }), session('session-c')]
  const { linkId, peers } = peersFor({ sessionId: 'session-a', sessions: rows, rules: { auto: true, overrides: {} } })
  assert.equal(linkId, cwdLinkId('E:/yy/one'))
  assert.deepEqual(peers.map((row) => row.id), ['session-b'])
})

await test('peersFor is symmetric once a link is named', () => {
  const rows = [session('session-a'), session('session-b')]
  const rules = { auto: false, overrides: { 'session-a': 'review', 'session-b': 'review' } }
  assert.deepEqual(peersFor({ sessionId: 'session-a', sessions: rows, rules }).peers.map((r) => r.id), ['session-b'])
  assert.deepEqual(peersFor({ sessionId: 'session-b', sessions: rows, rules }).peers.map((r) => r.id), ['session-a'])
})

await test('a named link exists even after its last member leaves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-registry-'))
  try {
    const store = createLinkStore({ file: join(dir, 'config.json') })
    await store.ready()
    await store.setLink('session-a', 'review')
    // Leaving does not erase the name: another session can still join it.
    await store.setLink('session-a', null)
    assert.deepEqual(store.linksSnapshot(), ['review'])
    await store.setLink('session-b', 'review')
    assert.deepEqual(store.linksSnapshot(), ['review'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('several named links coexist, members or not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-multi-'))
  try {
    const store = createLinkStore({ file: join(dir, 'config.json') })
    await store.ready()
    await store.createLink('alpha')
    await store.createLink('beta')
    await store.setLink('session-a', 'alpha')
    assert.deepEqual(store.linksSnapshot(), ['alpha', 'beta'])
    // A created-but-empty link still shows up in a catalogue, so it is joinable.
    const rows = [session('session-a')]
    const catalogue = buildCatalogue({ sessions: rows, rules: { auto: false, overrides: store.snapshot(), knownLinks: store.linksSnapshot() } })
    assert.deepEqual(catalogue.links.map((link) => link.id).sort(), ['alpha', 'beta'])
    await store.removeLink('beta')
    assert.deepEqual(store.linksSnapshot(), ['alpha'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('a relay is recorded verbatim so the exchange is auditable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-transcript-'))
  try {
    const store = createLinkStore({ file: join(dir, 'config.json') })
    await store.ready()
    await store.recordRelay({ from: 'session-a', to: 'session-b', link: 'review', body: 'ping from A', title: 'Alpha' })
    const logged = store.relaysSnapshot()
    assert.equal(logged.length, 1)
    // The body is kept whole: a summary would reintroduce the black box.
    assert.equal(logged[0].body, 'ping from A')
    assert.equal(logged[0].from, 'session-a')
    assert.equal(logged[0].to, 'session-b')
    assert.equal(logged[0].link, 'review')
    // and it survives a reload
    const reopened = createLinkStore({ file: join(dir, 'config.json') })
    await reopened.ready()
    assert.equal(reopened.relaysSnapshot()[0].body, 'ping from A')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('the transcript is bounded and drops the oldest entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-transcript-bound-'))
  try {
    const store = createLinkStore({ file: join(dir, 'config.json') })
    await store.ready()
    for (let index = 0; index < 205; index += 1) {
      await store.recordRelay({ from: 'session-a', to: 'session-b', link: 'review', body: `m${index}` })
    }
    const logged = store.relaysSnapshot()
    assert.equal(logged.length, 200)
    assert.equal(logged.at(-1).body, 'm204')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('a session view carries its own relays as plain text', () => {
  const rows = [session('session-a'), session('session-b')]
  const rules = { auto: false, overrides: { 'session-a': 'review', 'session-b': 'review' } }
  const catalogue = buildCatalogue({ sessions: rows, rules, focus: 'session-a' })
  const relays = [
    { at: 1, from: 'session-a', to: 'session-b', link: 'review', body: 'hello' },
    { at: 2, from: 'session-c', to: 'session-d', link: 'other', body: 'unrelated' },
  ]
  const view = sessionView({ sessionId: 'session-a', catalogue, relays })
  // Only exchanges this session took part in, and the body travels intact.
  assert.deepEqual(view.relays.map((entry) => entry.body), ['hello'])
})

await test('a session can join several links at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-multi-join-'))
  try {
    const store = createLinkStore({ file: join(dir, 'config.json') })
    await store.ready()
    await store.joinLink('session-a', 'alpha')
    await store.joinLink('session-a', 'beta')
    // Both memberships stand: joining one link never silently drops another.
    assert.deepEqual(store.linksOf('session-a'), ['alpha', 'beta'])
    assert.deepEqual(store.snapshot()['session-a'], ['alpha', 'beta'])
    await store.leaveLink('session-a', 'alpha')
    assert.deepEqual(store.linksOf('session-a'), ['beta'])
    await store.leaveLink('session-a', 'beta')
    assert.deepEqual(store.linksOf('session-a'), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('a multi-link session is a peer through any shared link', () => {
  const rows = [session('session-a'), session('session-b'), session('session-c')]
  const rules = { auto: false, overrides: { 'session-a': ['alpha', 'beta'], 'session-b': ['beta'], 'session-c': ['gamma'] } }
  const { peers } = peersFor({ sessionId: 'session-a', sessions: rows, rules })
  // session-b shares "beta"; session-c shares nothing.
  assert.deepEqual(peers.map((peer) => peer.id), ['session-b'])
})

await test('foldLinks puts a multi-link session in every group it named', () => {
  const rows = [session('session-a'), session('session-b')]
  const rules = { auto: false, overrides: { 'session-a': ['alpha', 'beta'], 'session-b': ['beta'] } }
  const groups = foldLinks(rows, rules)
  assert.deepEqual(groups.get('alpha').map((row) => row.id), ['session-a'])
  assert.deepEqual(groups.get('beta').map((row) => row.id).sort(), ['session-a', 'session-b'])
})

await test('a profile with no named link reports that, not an empty profile', () => {
  // The resting state now: sessions exist, none of them is on a link. A model
  // must be told to name one, or it reads "nothing here" and gives up.
  const rows = [session('session-a'), session('session-b')]
  const catalogue = buildCatalogue({ sessions: rows, rules: { auto: false, overrides: {} } })
  assert.equal(catalogue.total, 2)
  assert.equal(catalogue.links.length, 0)
  const text = describeCatalogue(catalogue, 'en')
  assert.match(text, /2 session\(s\) are known, but none is on a link/)
  assert.match(text, /set_session_link/)
})

await test('a named link is the only thing that creates a link', () => {
  const rows = [session('session-a'), session('session-b')]
  const bare = buildCatalogue({ sessions: rows, rules: { auto: false, overrides: {} } })
  assert.equal(bare.links.length, 0)
  const named = buildCatalogue({ sessions: rows, rules: { auto: true, overrides: { 'session-a': 'review' } } })
  assert.deepEqual(named.links.map((link) => link.id), ['review'])
  assert.deepEqual(named.links[0].sessions.map((row) => row.id), ['session-a'])
})

await test('peersFor gives an unlinked session no peers', () => {
  const rows = [session('session-a'), session('session-b')]
  const rules = { auto: false, overrides: {} }
  const { linkId, peers } = peersFor({ sessionId: 'session-a', sessions: rows, rules })
  // Absence of a link is the absence of a scope: not even other unlinked sessions match.
  assert.equal(linkId, undefined)
  assert.deepEqual(peers, [])
})

await test('buildCatalogue marks the focus link first', () => {
  const rows = [session('session-a'), session('session-b'), session('session-c')]
  const rules = { auto: false, overrides: { 'session-c': 'review' } }
  const catalogue = buildCatalogue({ sessions: rows, rules, focus: 'session-c' })
  assert.equal(catalogue.focusLink, 'review')
  assert.equal(catalogue.links[0].id, 'review')
  assert.equal(catalogue.total, 3)
})

await test('describeCatalogue lists every session and marks the focus link', () => {
  const rows = [session('session-a', { title: 'Alpha' }), session('session-b')]
  const rules = { auto: false, overrides: { 'session-a': 'review', 'session-b': 'review' } }
  const catalogue = buildCatalogue({ sessions: rows, rules, focus: 'session-a' })
  const text = describeCatalogue(catalogue, 'en')
  assert.match(text, /2 session\(s\), with 1 link\(s\)/)
  assert.match(text, /Alpha/)
  assert.match(text, /<- this session/s)
  assert.match(describeCatalogue(catalogue, 'zh'), /当前/)
})

await test('settleLater answers immediately when the work settles', async () => {
  assert.equal(await settleLater(Promise.resolve('done'), 'fallback', 50), 'done')
})

await test('settleLater answers the fallback when the work never settles', async () => {
  const started = Date.now()
  // Raced against a real timer: the backstop is unref'd so a torn-down Host can
  // exit, which also means only a pending unrelated promise keeps this test alive.
  const value = await Promise.race([settleLater(new Promise(() => {}), 'fallback', 20), new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))])
  assert.equal(value, 'fallback')
  assert.ok(Date.now() - started >= 15)
})

// ---------------------------------------------------------------------------
// routes.js — the browser bridge
// ---------------------------------------------------------------------------

/** A `req` fake carrying the guard header and a loopback peer. */
function reqOf(method, url, extra = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:9982', 'x-session-link': '1', ...(extra.headers ?? {}) },
    socket: { remoteAddress: extra.remote ?? '127.0.0.1' },
  }
}

/** A `res` fake that records the status and body. */
function resOf() {
  const recorded = { status: 0, body: undefined, ended: false }
  return {
    recorded,
    writeHead(status) {
      recorded.status = status
    },
    end(text) {
      recorded.ended = true
      if (typeof text === 'string' && text.length > 0) recorded.body = JSON.parse(text)
    },
  }
}

/** Call one route handler and read its answer. */
async function call(handler, req) {
  const res = resOf()
  await handler(req, res)
  return res.recorded
}

await test('the bridge refuses a request without its guard header', () => {
  assert.equal(guardRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }).ok, false)
  assert.equal(guardRequest({ headers: { 'x-session-link': '1' }, socket: { remoteAddress: '10.0.0.2' } }).ok, false)
  assert.equal(
    guardRequest({ headers: { 'x-session-link': '1' }, socket: { remoteAddress: '10.0.0.2' } }, { allowRemote: true }).ok,
    true,
  )
})

await test('the bridge refuses a cross-site request and a mismatched origin', () => {
  const base = { 'x-session-link': '1', host: '127.0.0.1:9982' }
  assert.equal(guardRequest({ headers: { ...base, 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '127.0.0.1' } }).ok, false)
  assert.equal(guardRequest({ headers: { ...base, origin: 'http://evil.test' }, socket: { remoteAddress: '127.0.0.1' } }).ok, false)
  assert.equal(guardRequest({ headers: { ...base, origin: 'http://127.0.0.1:9982' }, socket: { remoteAddress: '127.0.0.1' } }).ok, true)
})

await test('parseLinkInput maps null, empty, and the default words to a clear', () => {
  assert.deepEqual(parseLinkInput(null), { kind: 'clear' })
  assert.deepEqual(parseLinkInput(''), { kind: 'clear' })
  assert.deepEqual(parseLinkInput(' default '), { kind: 'clear' })
  assert.deepEqual(parseLinkInput('Review'), { kind: 'set', linkId: 'review' })
  assert.deepEqual(parseLinkInput('bad id'), { kind: 'invalid' })
  assert.deepEqual(parseLinkInput(3), { kind: 'invalid' })
})

await test('sessionView reports the peers of one session', () => {
  const rows = [session('session-a'), session('session-b')]
  const rules = { auto: false, overrides: { 'session-a': 'review', 'session-b': 'review' } }
  const catalogue = buildCatalogue({ sessions: rows, rules, focus: 'session-a' })
  const view = sessionView({ sessionId: 'session-a', catalogue })
  assert.equal(view.linkId, 'review')
  assert.deepEqual(view.peers.map((peer) => peer.id), ['session-b'])
  assert.equal(view.pending, false)
  // A Host that cannot resume an idle session must say so, not promise a delivery.
  assert.equal(view.resumable, true)
  assert.equal(sessionView({ sessionId: 'session-a', catalogue: { ...catalogue, resumable: false } }).resumable, false)
})

/** A route harness over a fixed catalogue and a recording store. */
function routesOf(rows = [session('session-a'), session('session-b')]) {
  const writes = []
  const snapshots = []
  // Both sessions start on one named link: a shared implicit default no longer exists.
  const rules = { auto: false, overrides: { 'session-a': 'main', 'session-b': 'main' } }
  const routes = createRoutes({
    snapshot: async (focus, options) => {
      snapshots.push({ focus, options })
      return buildCatalogue({ sessions: rows, rules, focus })
    },
    setLink: async (sessionId, linkId) => {
      writes.push({ sessionId, linkId })
      if (linkId === null) delete rules.overrides[sessionId]
      else rules.overrides[sessionId] = linkId
    },
    setSettings: async (patch) => {
      writes.push({ patch })
      Object.assign(rules, patch)
    },
    settings: () => ({ auto: rules.auto ?? false, defaultLink: 'main' }),
    errorOf: () => undefined,
  })
  return { routes, writes, snapshots, rules }
}

await test('GET session answers one session view', async () => {
  const { routes } = routesOf()
  const answer = await call(routes.session, reqOf('GET', '/api/session-link/session?sessionId=session-a'))
  assert.equal(answer.status, 200)
  assert.equal(answer.body.focus, 'session-a')
  assert.deepEqual(answer.body.peers.map((peer) => peer.id), ['session-b'])
})

await test('PUT session records the link and answers the new view', async () => {
  const { routes, writes } = routesOf()
  const req = reqOf('PUT', '/api/session-link/session')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ sessionId: 'session-a', link: 'Review' }))
  }
  const answer = await call(routes.session, req)
  assert.equal(answer.status, 200)
  assert.deepEqual(writes, [{ sessionId: 'session-a', linkId: 'review' }])
  assert.equal(answer.body.applied, 'review')
})

await test('PUT session rejects an unusable link id', async () => {
  const { routes, writes } = routesOf()
  const req = reqOf('PUT', '/api/session-link/session')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ sessionId: 'session-a', link: 'bad id' }))
  }
  const answer = await call(routes.session, req)
  assert.equal(answer.status, 400)
  assert.equal(writes.length, 0)
})

await test('PUT session rejects a body without a link field', async () => {
  const { routes } = routesOf()
  const req = reqOf('PUT', '/api/session-link/session')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ sessionId: 'session-a' }))
  }
  assert.equal((await call(routes.session, req)).status, 400)
})

await test('PUT session needs a session to move', async () => {
  const { routes } = routesOf()
  const req = reqOf('PUT', '/api/session-link/session')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ link: 'review' }))
  }
  assert.equal((await call(routes.session, req)).status, 400)
})

await test('a guarded route refuses an unguarded request', async () => {
  const { routes } = routesOf()
  const answer = await call(routes.session, { method: 'GET', url: '/api/session-link/session', headers: {}, socket: { remoteAddress: '127.0.0.1' } })
  assert.equal(answer.status, 403)
})

await test('the catalogue route titles the whole listing', async () => {
  const { routes, snapshots } = routesOf()
  const answer = await call(routes.catalogueRoute, reqOf('GET', '/api/session-link/catalogue?sessionId=session-a'))
  assert.equal(answer.status, 200)
  assert.deepEqual(snapshots.at(-1), { focus: 'session-a', options: { scoped: false } })
})

await test('a method other than GET is refused on the catalogue route', async () => {
  const { routes } = routesOf()
  const answer = await call(routes.catalogueRoute, reqOf('POST', '/api/session-link/catalogue'))
  assert.equal(answer.status, 405)
})

await test('the settings route reads and writes the rules', async () => {
  const { routes, writes } = routesOf()
  assert.equal((await call(routes.settings, reqOf('GET', '/api/session-link/settings'))).body.auto, false)
  const req = reqOf('PUT', '/api/session-link/settings')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ auto: true }))
  }
  const answer = await call(routes.settings, req)
  assert.equal(answer.status, 200)
  assert.deepEqual(writes, [{ patch: { auto: true } }])
})

await test('the settings route refuses a non-boolean auto', async () => {
  const { routes } = routesOf()
  const req = reqOf('PUT', '/api/session-link/settings')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ auto: 'yes' }))
  }
  assert.equal((await call(routes.settings, req)).status, 400)
})

// ---------------------------------------------------------------------------
// plugin.js — the model-facing surfaces
// ---------------------------------------------------------------------------

/** A Cordis context fake that records tools, prompt contexts, and effects. */
function makeCtx(services = {}) {
  const tools = new Map()
  const contexts = []
  const effects = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    inject(names, body) {
      const scoped = {
        tools: ctx.tools,
        systemPrompt: ctx.systemPrompt,
        effect(factory, label) {
          effects.push(label)
          return factory()
        },
      }
      body(scoped)
    },
    systemPrompt: {
      getContextOrder() {
        return 120
      },
      context(entry) {
        contexts.push(entry)
        return () => {}
      },
    },
    effect(factory, label) {
      effects.push(label)
      return factory()
    },
    ...services,
  }
  return { ctx, tools, contexts, effects }
}

/** The services a tool call needs. */
function servicesOf(rows, titles = {}) {
  return { sessionQuery: queryOf(rows.map((row) => sessionRecord(row.id, { title: row.title, cwd: row.cwd })), titles) }
}

/** A tool execution fake. */
/**
 * The two arguments a tool call receives: declared arguments, then the execution.
 *
 * The tools API invokes `execute(args, exec)`; older releases put the arguments on
 * `exec.arguments`. Tests spread this into `.execute(...)` so both shapes are covered.
 */
function execOf(agentId, args) {
  return [args, { agent: { id: agentId, session: { id: agentId } }, arguments: args }]
}

await test('apply registers the three tools and the context line', async () => {
  const { ctx, tools, contexts } = makeCtx(servicesOf([session('session-a'), session('session-b')]))
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  assert.deepEqual([...tools.keys()].sort(), ['list_session_links', 'send_session_message', 'set_session_link'])
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'session-link:peers')
})

await test('linkTools: false leaves only the context line', () => {
  const { ctx, tools } = makeCtx(servicesOf([]))
  apply(ctx, configOf({ linkTools: false }), { store: createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') }) })
  assert.equal(tools.size, 0)
})

await test('the context line is synchronous, and filled in behind the scene', async () => {
  const rows = [session('session-a', { title: 'One' }), session('session-b', { title: 'Two' })]
  // Titles come from the per-session title read, not from the listing DTO, which
  // carries no title at all.
  const { ctx, contexts } = makeCtx(servicesOf(rows.map((row) => ({ ...row, title: '' })), { 'session-a': 'One', 'session-b': 'Two' }))
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })

  // The harness never awaits a context provider: a Promise here would be
  // stringified into the system prompt, so the first call must return a string.
  const first = contexts[0].text({ agent: { session: { id: 'session-a' } } })
  assert.equal(typeof first, 'string')
  assert.equal(first, '')

  // The refresh it started answers the next call.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = contexts[0].text({ agent: { session: { id: 'session-a' } } })
  assert.equal(typeof second, 'string')
  assert.match(second, /together with 1 other session/)
  assert.match(second, /Two/)
})

await test('an isolated session is never told on every step that it is alone', async () => {
  const { ctx, contexts } = makeCtx(servicesOf([session('session-a')]))
  apply(ctx, configOf(), { store: createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') }) })
  contexts[0].text({ agent: { session: { id: 'session-a' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(contexts[0].text({ agent: { session: { id: 'session-a' } } }), '')
})

await test('the context line swallows a service failure', async () => {
  const { ctx, contexts } = makeCtx({
    sessionQuery: {
      async listSessions() {
        throw new Error('query down')
      },
    },
  })
  apply(ctx, configOf(), { store: createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') }) })
  assert.equal(contexts[0].text({ agent: { session: { id: 'session-a' } } }), '')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(contexts[0].text({ agent: { session: { id: 'session-a' } } }), '')
})

await test('send_session_message delivers into a live peer', async () => {
  const inbox = []
  const peer = agent('session-b', inbox)
  const rows = [session('session-a'), session('session-b')]
  const { ctx, tools } = makeCtx({ ...servicesOf(rows), agents: { list: () => [peer], get: (id) => (id === 'session-b' ? peer : undefined) } })
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  const result = await tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: '  ping  ' }))
  assert.equal(result.delivered, true)
  assert.equal(result.mode, 'live')
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].source.kind, 'agent-message')
  assert.equal(inbox[0].source.form, 'relay')
  assert.equal(inbox[0].source.senderSessionId, 'session-a')
  assert.match(inbox[0].content[0].text, /ping/)
})

await test('a busy peer is steered rather than queued behind its turn', async () => {
  const inbox = []
  const peer = agent('session-b', inbox)
  peer.status = 'running'
  peer.steer = (message) => inbox.push({ ...message, steered: true })
  const rows = [session('session-a'), session('session-b')]
  const { ctx, tools } = makeCtx({ ...servicesOf(rows), agents: { list: () => [peer], get: (id) => (id === 'session-b' ? peer : undefined) } })
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  const result = await tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: 'now' }))
  assert.equal(result.delivered, true)
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].steered, true)
})

await test('a delivered relay is detached from the sender', async () => {
  const inbox = []
  const live = agent('session-b', inbox)
  const { resumed } = { resumed: new Map() }
  const outcome = await deliver({ agents: { get: () => live, resume: undefined }, resumed }, {
    toId: 'session-b',
    message: { content: [{ type: 'text', text: 'frozen' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-a', summary: 'x' } },
  })
  assert.equal(outcome.kind, 'delivered')
  // A copy, not the caller's array: mutating the caller's message afterwards
  // must not reach into what the recipient already accepted.
  inbox[0].content.push({ type: 'text', text: 'injected' })
  assert.equal(inbox[0].content.length, 2)
})

await test('send_session_message refuses an unlinked target', async () => {
  const rows = [session('session-a'), session('session-c', { cwd: '' })]
  const store = createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') })
  const { ctx, tools } = makeCtx({ ...servicesOf(rows), agents: { list: () => [], get: () => undefined } })
  apply(ctx, configOf(), { store })
  await assert.rejects(
    () => tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-c-wrong', message: 'ping' })),
    /no linked session matches/,
  )
})

await test('send_session_message refuses an empty body', async () => {
  const rows = [session('session-a'), session('session-b')]
  const { ctx, tools } = makeCtx({ ...servicesOf(rows), agents: { list: () => [], get: () => undefined } })
  apply(ctx, configOf(), { store: createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') }) })
  await assert.rejects(() => tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: '   ' })), /must not be empty/)
})

await test('send_session_message resumes an idle peer and disposes what it started', async () => {
  const inbox = []
  const disposed = []
  const handle = {
    agent: agent('session-b', inbox),
    async dispose() {
      disposed.push('session-b')
    },
  }
  const rows = [session('session-a'), session('session-b')]
  const { ctx, tools } = makeCtx({
    ...servicesOf(rows),
    agents: {
      list: () => [],
      get: () => undefined,
      async resume(options) {
        assert.equal(options.resumeSessionId, 'session-b')
        return handle
      },
    },
  })
  const { resumed } = apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  const result = await tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: 'ping' }))
  assert.equal(result.mode, 'resumed')
  assert.equal(inbox.length, 1)
  assert.equal(resumed.has('session-b'), true)
})

await test('a failed resume is reported, not thrown', async () => {
  const rows = [session('session-a'), session('session-b')]
  const { ctx, tools } = makeCtx({
    ...servicesOf(rows),
    agents: {
      list: () => [],
      get: () => undefined,
      async resume() {
        throw new Error('locked')
      },
    },
  })
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  const result = await tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: 'ping' }))
  assert.equal(result.delivered, false)
  assert.match(result.reason, /locked/)
})

await test('a tool reads its arguments from the positional argument, not exec', async () => {
  // The tools API calls execute(args, exec). Older releases carried the arguments
  // on exec.arguments; both must work or every tool breaks on one of them.
  const { ctx, tools } = makeCtx(servicesOf([session('session-a')]))
  const store = await linkedStore(['session-a'])
  apply(ctx, configOf(), { store })
  const modern = await tools.get('list_session_links').execute({}, { agent: { id: 'session-a', session: { id: 'session-a' } } })
  assert.equal(typeof modern.report, 'string')
  const legacy = await tools.get('list_session_links').execute(undefined, { agent: { id: 'session-a', session: { id: 'session-a' } }, arguments: {} })
  assert.equal(typeof legacy.report, 'string')
})

await test('list_session_links reports the division', async () => {
  const rows = [session('session-a', { title: 'Alpha' }), session('session-b', { title: 'Beta' })]
  const { ctx, tools } = makeCtx(servicesOf(rows.map((row) => ({ ...row, title: '' })), { 'session-a': 'Alpha', 'session-b': 'Beta' }))
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  const all = await tools.get('list_session_links').execute(...execOf('session-a', {}))
  // The shared link those two sessions were put on, not a built-in default.
  assert.equal(all.linkId, 'review')
  assert.deepEqual(all.peers.map((peer) => peer.id), ['session-b'])
  assert.match(all.report, /Alpha/)
  const mine = await tools.get('list_session_links').execute(...execOf('session-a', { onlyMine: true }))
  assert.match(mine.report, /session-b/)
})

await test('set_session_link moves the calling session only', async () => {
  const rows = [session('session-a'), session('session-b')]
  const { ctx, tools } = makeCtx(servicesOf(rows))
  // Only session-a starts on a link: this test is about moving one session.
  const { store } = apply(ctx, configOf(), { store: await linkedStore(['session-a']) })
  const joined = await tools.get('set_session_link').execute(...execOf('session-a', { link: 'Review' }))
  assert.equal(joined.linkId, 'review')
  assert.equal(joined.joined, true)
  assert.equal(store.linkOf('session-a'), 'review')
  assert.equal(store.linkOf('session-b'), undefined)
  const cleared = await tools.get('set_session_link').execute(...execOf('session-a', { link: 'default' }))
  assert.equal(cleared.joined, false)
  assert.equal(store.linkOf('session-a'), undefined)
})

await test('set_session_link refuses an unusable link id', async () => {
  const { ctx, tools } = makeCtx(servicesOf([session('session-a')]))
  apply(ctx, configOf(), { store: await linkedStore(['session-a', 'session-b']) })
  await assert.rejects(() => tools.get('set_session_link').execute(...execOf('session-a', { link: 'not a link' })), /not a usable link id/)
})

await test('every tool carries a render for its result', () => {
  const { ctx, tools } = makeCtx(servicesOf([]))
  apply(ctx, configOf(), { store: createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') }) })
  for (const [name, definition] of tools) {
    assert.equal(typeof definition.output.render, 'function', `${name} has no render`)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${name} description is too thin`)
  }
})

await test('apply disposes resumed handles when the plugin unloads', async () => {
  const disposed = []
  const effects = []
  const rows = [session('session-a'), session('session-b')]
  const handle = {
    agent: agent('session-b'),
    async dispose() {
      disposed.push('session-b')
    },
  }
  const ctx = {
    tools: { register: () => () => {}, get: () => undefined },
    systemPrompt: { getContextOrder: () => 120, context: () => () => {} },
    inject(names, body) {
      body({ tools: ctx.tools, systemPrompt: ctx.systemPrompt, effect: (factory) => effects.push(factory) })
    },
    effect(factory) {
      const teardown = factory()
      if (typeof teardown === 'function') effects.push(teardown)
      return teardown
    },
    sessionQuery: queryOf(rows.map((row) => sessionRecord(row.id, { title: row.title, cwd: row.cwd }))),
    agents: {
      list: () => [],
      get: () => undefined,
      async resume() {
        return handle
      },
    },
  }
  const { resumed } = apply(ctx, configOf({ linkTools: false }), { store: createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') }) })
  resumed.set('session-b', handle)
  for (const entry of effects) if (typeof entry === 'function') await entry()
  assert.deepEqual(disposed, ['session-b'])
  assert.equal(resumed.size, 0)
})

// ---------------------------------------------------------------------------
// crossProject — one reachability decision shared by every consumer
// ---------------------------------------------------------------------------

await test('sameProject gates peers by working directory', () => {
  // Same project: normalized equality (case, slashes, trailing slash).
  assert.equal(sameProject({ focusCwd: 'E:/yy/One', peerCwd: 'e:\\yy\\one\\', crossProject: false }), true)
  // Empty/empty is allowed; empty/non-empty is not.
  assert.equal(sameProject({ focusCwd: '', peerCwd: '', crossProject: false }), true)
  assert.equal(sameProject({ focusCwd: '', peerCwd: 'E:/yy/one', crossProject: false }), false)
  assert.equal(sameProject({ focusCwd: 'E:/yy/one', peerCwd: '', crossProject: false }), false)
  // Different projects are blocked unless crossProject is on.
  assert.equal(sameProject({ focusCwd: 'E:/yy/one', peerCwd: 'E:/yy/two', crossProject: false }), false)
  assert.equal(sameProject({ focusCwd: 'E:/yy/one', peerCwd: 'E:/yy/two', crossProject: true }), true)
})

await test('peersFor hides cross-project link-mates when crossProject is off', () => {
  // An explicit override puts both sessions on one link; the directory rule is
  // deliberately bypassed so only the project gate can decide reachability.
  const rows = [
    session('session-a', { cwd: 'E:/yy/one' }),
    session('session-b', { cwd: 'E:/yy/two' }),
  ]
  const rules = { auto: false, overrides: { 'session-a': 'review', 'session-b': 'review' } }
  assert.deepEqual(
    peersFor({ sessionId: 'session-a', sessions: rows, rules }).peers.map((row) => row.id),
    [],
  )
  assert.deepEqual(
    peersFor({ sessionId: 'session-a', sessions: rows, rules: { ...rules, crossProject: true } }).peers.map((row) => row.id),
    ['session-b'],
  )
  // Same project on the shared link stays reachable either way.
  const sameDir = [session('session-a', { cwd: 'E:/yy/one' }), session('session-b', { cwd: 'E:/yy/one' })]
  assert.deepEqual(peersFor({ sessionId: 'session-a', sessions: sameDir, rules }).peers.map((row) => row.id), ['session-b'])
})

await test('buildCatalogue threads crossProject through to sessionView', () => {
  const rows = [session('session-a', { cwd: 'E:/yy/one' }), session('session-b', { cwd: 'E:/yy/two' })]
  const rules = { auto: false, overrides: { 'session-a': 'review', 'session-b': 'review' }, crossProject: false }
  const off = buildCatalogue({ sessions: rows, rules, focus: 'session-a' })
  assert.equal(off.crossProject, false)
  assert.deepEqual(sessionView({ sessionId: 'session-a', catalogue: off }).peers.map((row) => row.id), [])
  const on = buildCatalogue({ sessions: rows, rules: { ...rules, crossProject: true }, focus: 'session-a' })
  assert.equal(on.crossProject, true)
  assert.deepEqual(sessionView({ sessionId: 'session-a', catalogue: on }).peers.map((row) => row.id), ['session-b'])
  // The link grouping itself is untouched: id and member count are stable.
  assert.deepEqual(off.links.map((link) => link.id), on.links.map((link) => link.id))
  assert.deepEqual(off.links.map((link) => link.members), on.links.map((link) => link.members))
})

await test('rulesOf unwraps live volatile config references on every read', () => {
  const store = createLinkStore({ file: join(tmpdir(), 'session-link-unused.json') })
  assert.equal(configValue(7), 7)
  assert.equal(configValue(volatileRef('main')), 'main')
  // Plain resolved values still work.
  assert.equal(pluginRulesOf(configOf({ crossProject: false }), store).crossProject, false)
  assert.equal(pluginRulesOf(configOf({ crossProject: true }), store).crossProject, true)
  // Cordis hands .volatile() fields to the plugin as live references, not
  // plain booleans, and hot-updates that SAME object in place when Settings
  // writes it. rulesOf must unwrap on each read (never cache), so a toggle
  // reaches the tools, the context line, and the header without a restart.
  const crossProject = volatileRef(false)
  const autoLinks = volatileRef(true)
  const config = configOf({ crossProject, autoLinks })
  assert.equal(pluginRulesOf(config, store).crossProject, false)
  assert.equal(pluginRulesOf(config, store).auto, true)
  crossProject.box.value = true
  autoLinks.box.value = false
  assert.equal(pluginRulesOf(config, store).crossProject, true)
  assert.equal(pluginRulesOf(config, store).auto, false)
  // index.js declares the schema (schemastery), which this plain-node suite
  // deliberately does not import. Assert its rulesOf unwraps the field too,
  // and that the schema field is volatile so the settings switch can edit it.
  const indexSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(indexSource, /crossProject:\s*configValue\(config\.crossProject\) === true/)
  assert.match(indexSource, /crossProject: z[\s\S]*?\.volatile\(\)/)
})

await test('send_session_message refuses a cross-project peer unless enabled', async () => {
  await withStore(async (store) => {
    const inbox = []
    const peer = agent('session-b', inbox)
    const rows = [session('session-a', { cwd: 'E:/yy/one' }), session('session-b', { cwd: 'E:/yy/two' })]
    await store.setLink('session-a', 'review')
    await store.setLink('session-b', 'review')
    const services = { ...servicesOf(rows), agents: { list: () => [peer], get: (id) => (id === 'session-b' ? peer : undefined) } }

    const off = makeCtx(services)
    apply(off.ctx, configOf({ crossProject: false }), { store })
    await assert.rejects(
      () => off.tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: 'ping' })),
      /no linked session matches/,
    )
    assert.equal(inbox.length, 0)

    const on = makeCtx(services)
    apply(on.ctx, configOf({ crossProject: true }), { store })
    const result = await on.tools.get('send_session_message').execute(...execOf('session-a', { target: 'session-b', message: 'ping' }))
    assert.equal(result.delivered, true)
    assert.equal(inbox.length, 1)
  })
})

await test('the context line hides cross-project peers when crossProject is off', async () => {
  await withStore(async (store) => {
    const rows = [session('session-a', { cwd: 'E:/yy/one' }), session('session-b', { cwd: 'E:/yy/two' })]
    await store.setLink('session-a', 'review')
    await store.setLink('session-b', 'review')

    const off = makeCtx(servicesOf(rows))
    apply(off.ctx, configOf({ crossProject: false }), { store })
    off.contexts[0].text({ agent: { session: { id: 'session-a' } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(off.contexts[0].text({ agent: { session: { id: 'session-a' } } }), '')

    const on = makeCtx(servicesOf(rows))
    apply(on.ctx, configOf({ crossProject: true }), { store })
    on.contexts[0].text({ agent: { session: { id: 'session-a' } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.match(on.contexts[0].text({ agent: { session: { id: 'session-a' } } }), /together with 1 other session/)
  })
})

// ---------------------------------------------------------------------------

console.log('')
console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
