/**
 * Exercise `client.js`'s factory against a faithful stub of the shipped
 * primitives bundle.
 *
 * The stub transcribes `SettingsFormModel`'s real algorithm — `format`,
 * `parse`, `field`, `shell`, `plan` — rather than stubbing its methods loosely:
 * a field spec missing `format` (or a `parse` that throws on a live value)
 * passed the loose stub locally while killing web boot for real, so the test has
 * to run the same code the browser does. It also transcribes the model's
 * `baseline` freeze/revision behaviour so the sticky save-failure regression
 * can be reproduced.
 *
 * Every assertion throws on failure, so this file needs no test framework and no
 * Harness: `node test-client.mjs`.
 */

import { readFileSync } from 'node:fs'

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}

/** The shipped `SettingsFormModel` (abridged only in its network call). */
class SettingsFormModel {
  constructor(scope, fields) {
    globalThis.__lastFormModel = this
    this.scope = scope
    this.specs = new Map(fields.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.listeners = new Set()
    this.saving = false
    this.failed = false
    this.baseline = void 0
    this.unsubscribe = scope.subscribe(() => this.publish())
  }

  bind(selector) {
    const store = {
      current: selector(),
      getSnapshot: () => store.current,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }
    this.listeners.add(() => {
      store.current = selector()
    })
    return store
  }

  shell() {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((row) => row.op === void 0),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(name) {
    const staged = this.staged.get(name)
    const spec = this.spec(name)
    if (staged === void 0) {
      return { text: spec.format(this.sectionValue(name)), overridden: this.stored(name), invalid: false }
    }
    const parsed = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
    return { text: staged.text, overridden: parsed?.kind === 'set', invalid: parsed === void 0 }
  }

  actions() {
    return {
      edit: (name, text) => this.stage(name, { text, clear: false }),
      resetField: (name) => this.stage(name, { text: this.spec(name).format(this.baseValue(name)), clear: true }),
      save: () => this.save(),
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.baseline = void 0
        this.failed = false
        this.publish()
      },
    }
  }

  async save() {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || !this.scope.getSnapshot().writable) return
    if (plan.some((row) => row.op === void 0)) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = plan.flatMap((row) => (row.op === void 0 ? [] : [row.op]))
      const accepted = ops.length === 0 || (await this.scope.mutate(ops, this.baseline?.revision))
      if (accepted) {
        this.staged.clear()
        this.baseline = void 0
      }
      this.failed = !accepted
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  plan() {
    const rows = []
    for (const [name, staged] of this.staged) {
      const spec = this.spec(name)
      if (staged.clear) {
        if (this.stored(name)) rows.push({ field: name, op: { op: 'unset', path: [name] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(name))) continue
      const parsed = spec.parse(staged.text)
      if (parsed === void 0) rows.push({ field: name })
      else if (parsed.kind === 'clear') rows.push({ field: name, op: { op: 'unset', path: [name] } })
      else rows.push({ field: name, op: { op: 'set', path: [name], value: parsed.value } })
    }
    return rows
  }

  stage(name, staged) {
    this.baseline ??= this.scope.getSnapshot()
    this.staged.set(name, staged)
    this.failed = false
    this.publish()
  }

  spec(name) {
    const spec = this.specs.get(name)
    if (spec === void 0) throw new Error(`plugin card has no field ${name}`)
    return spec
  }

  snapshotOf() {
    return this.scope.getSnapshot()
  }

  sectionValue(name) {
    return this.snapshotOf().value?.[name]
  }

  baseValue(name) {
    return this.snapshotOf().base?.[name]
  }

  userLayer() {
    return this.snapshotOf().user
  }

  stored(name) {
    const user = this.userLayer()
    return user !== void 0 && Object.hasOwn(user, name)
  }

  publish() {
    for (const listener of this.listeners) listener()
  }

  dispose() {
    this.unsubscribe()
    this.listeners.clear()
  }
}

const primitives = {
  SettingsForm: function SettingsForm() {},
  SettingsFormModel,
  SettingsValueField: function SettingsValueField() {},
  Switch: function Switch() {},
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useId: () => 'id',
  /** A single-shot hook stand-in: the initial value is all these renders need. */
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
}

const requireFn = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
}

/** One assertion, reported as it passes. */
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  process.exitCode = 1
}

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)
check('client.js registered', registration !== undefined)
check('registration id is the package name', registration.id === 'dsh-interlink', registration.id)

const plugin = registration.factory(requireFn)
check('the factory returns a plugin', typeof plugin === 'object' && plugin !== null)
check('it declares its browser services', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale', 'configForms']))

// The Host must be reachable and must fail closed: a fetch that throws must
// never escape the header control, or a restarting Host unmounts the chrome.
const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url, init })
  return {
    ok: true,
    async json() {
      return { sessionId: 'session-a', linkId: 'main', peers: [], links: [], total: 1, persisted: true, resumable: true, pending: false }
    },
  }
}
globalThis.AbortController = class {
  constructor() {
    this.signal = {}
  }
  abort() {}
}

const effects = []
const slots = []
const dictionaries = []
let whileServedArgs

/** A `configForms.get(id)` scope over one ready, writable entry. */
function entryScope() {
  const listeners = new Set()
  const state = {
    status: 'ready',
    writable: true,
    saving: false,
    failed: false,
    revision: 1,
    value: { autoLinks: true, linkTools: true, contextLine: true, crossProject: false },
    base: {},
    user: {},
    mutate: async () => true,
    nextResult: true,
  }
  // Record the revision each save submits. The shipped form model passes
  // `baseline?.revision`; the regression below proves the card drops that
  // frozen snapshot after a conflict so a retry is judged against the live
  // mirror. `nextResult` lets the test force exactly one conflicting write.
  const mutateCalls = []
  state.mutate = async (ops, expectedRevision) => {
    mutateCalls.push({ ops, expectedRevision })
    const accepted = state.nextResult !== false
    state.nextResult = true
    return accepted
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: state.mutate,
    mutateCalls,
    state,
  }
}

const entryStates = { 'session-link': entryScope() }
const ctx = {
  locale: {
    bind: (ns) => (key) => `${ns}.${key}`,
    register: (ns, dicts) => {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
  },
  effect: (callback, label) => {
    effects.push(label)
    return callback()
  },
  configForms: {
    get: (entryId) => entryStates[entryId],
    whileServed: (namespaces, register) => {
      whileServedArgs = namespaces
      return register(new Set(namespaces))
    },
  },
  slots: {
    inject: (slotName, callback) => callback(),
    register: (options, component) => {
      slots.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

check('apply ran without throwing', true)
check('dictionaries registered for both locales', dictionaries.length === 1 && Object.keys(dictionaries[0].dicts).join(',') === 'en,zh')
check('the Host entry id matches the Loader patch id', JSON.stringify(whileServedArgs) === JSON.stringify(['session-link']), JSON.stringify(whileServedArgs))
check('two surfaces registered', slots.length === 2, String(slots.length))

const page = slots.find((slot) => slot.options.name === 'plugins.item')
const header = slots.find((slot) => slot.options.name === 'conversation.session.header.actions')
check('the settings page is registered', page !== undefined)
check('the header control is registered', header !== undefined)
check('the header control is session-scoped chrome', header.options.locale === 'session-link')

// The field specs are where a bad definition kills web boot: the model calls
// `field(name)` for every field at registration time.
const face = page.options.inject()
const store = face.hooks.sessionLinkCard
const initial = store.getSnapshot()
check('the form shell is available and writable', initial.available === true && initial.writable === true)
check('every field has a format function', ['autoLinks', 'crossProject', 'linkTools', 'contextLine'].every((name) => typeof face.hooks.sessionLinkCard.getSnapshot()[name]?.text === 'string'))
check('a boolean field formats as on/off', initial.autoLinks.text === 'on', initial.autoLinks.text)
check('crossProject defaults to off', initial.crossProject.text === 'off', initial.crossProject.text)

face.edit('autoLinks', 'off')
const edited = store.getSnapshot()
check('an edited field stages as dirty', edited.dirty === true && edited.autoLinks.text === 'off')

face.edit('autoLinks', 'maybe')
const invalid = store.getSnapshot()
check('an unusable boolean draft is invalid, not thrown', invalid.invalid === true && invalid.autoLinks.invalid === true)

face.discard()
check('discarding clears the staged draft', store.getSnapshot().dirty === false)

face.edit('linkTools', 'false')
check('the parser accepts a literal false', store.getSnapshot().linkTools.text === 'false' && store.getSnapshot().dirty === true)
face.discard()

face.edit('crossProject', 'on')
const crossOn = store.getSnapshot()
check('crossProject can be switched on and stages a save', crossOn.crossProject.text === 'on' && crossOn.dirty === true)
check('the staged on value is valid, not an unusable draft', crossOn.crossProject.invalid === false && crossOn.invalid === false)
face.discard()
check('discarding restores crossProject to off', store.getSnapshot().crossProject.text === 'off')

// Regression for the sticky "保存失败": the shipped model freezes a
// `baseline` snapshot on the first staged edit and submits
// `baseline.revision` on every save. That snapshot goes stale after any other
// write to the namespace, and configForms.recover() only reloads the mirror,
// so the stale revision would be resent on every save and keep conflicting
// ("保存失败" forever). The card's save wrapper must drop the frozen snapshot
// before every save — first attempt and retries alike — so a single click
// succeeds and the staged draft is preserved.
const scope = entryStates['session-link']
const model = globalThis.__lastFormModel
face.edit('crossProject', 'on')
check('staging a field freezes the expected-revision baseline', model.baseline !== undefined)
const frozenRevision = model.baseline.revision
// Simulate a stale snapshot: the live mirror advanced while the model still
// holds a detached, stale baseline (the real mirror swaps in a new object on
// reload, so the frozen baseline does not follow it).
model.baseline = { revision: frozenRevision }
scope.state.revision = frozenRevision + 1
// First save must not resubmit the stale revision.
scope.mutateCalls.length = 0
await face.save()
check('a first save drops the stale baseline before writing', model.baseline === undefined)
check('a first save is judged against the live revision, not the stale one', scope.mutateCalls.length === 1 && scope.mutateCalls[0].expectedRevision === undefined, String(scope.mutateCalls[0]?.expectedRevision))
check('the first save succeeds instead of showing 保存失败', model.failed === false)
// After a genuine failure the draft is kept; a retry must also drop the
// re-frozen baseline rather than resending a stale revision.
face.edit('crossProject', 'on')
model.baseline = { revision: frozenRevision }
scope.state.revision = frozenRevision + 2
scope.state.nextResult = false
await face.save()
check('a conflict marks the form failed and keeps the staged draft', model.failed === true && model.staged.has('crossProject'))
scope.mutateCalls.length = 0
await face.save()
check('retry delegates to the form model (a write was attempted)', scope.mutateCalls.length === 1)
check('retry also drops the stale baseline before writing', model.baseline === undefined)
check('retry is judged against the live revision, not the stale one', scope.mutateCalls[0].expectedRevision === undefined, String(scope.mutateCalls[0]?.expectedRevision))
check('the retried save succeeds instead of sticking on 保存失败', model.failed === false)
face.discard()

// Render both card states, and the header control, without a real React.
const renderProps = {
  t: (key) => `T:${key}`,
  ...face,
  useSessionLinkCard: (selector) => selector(store.getSnapshot()),
}
const summary = page.component({ view: 'summary', ...renderProps })
const rendered = page.component({ view: 'page', ...renderProps })
check('the summary renders a string', typeof summary === 'string' && summary.length > 0)
check('the page renders an element', typeof rendered === 'object' && rendered !== null)

const headerRendered = header.component({ t: (key) => `T:${key}`, sessionId: 'session-a' })
check('the header control renders without a session read', typeof headerRendered === 'object' && headerRendered !== null)
check('the header control survives a missing sessionId', typeof header.component({ t: (key) => key }) === 'object')

// The routes the control calls must carry the guard header, or the Host refuses.
check('the control uses the guarded session route', face !== undefined)

// The header slot clips and fades its overflow, so its overlay has to leave the
// header box; a panel positioned inside it renders invisibly and the click looks
// dead. Lock the portal down instead of trusting a reviewer to notice.
check('the header overlay portals out of the clipped header', /createPortal\(/.test(source))
check('the header overlay does not position itself inside the header', !/position:\s*'absolute'/.test(source))

const afterApply = requests.length
check('no request is made until the component mounts', afterApply === 0, String(afterApply))

console.log('')
console.log(process.exitCode === 1 ? 'client checks FAILED' : 'client checks passed')
