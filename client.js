/**
 * Session Link — the browser half.
 *
 * Two surfaces, both about the same question: *which sessions can this one talk
 * to, and how do I change that?*
 *
 * 1. **The session header control** — the link this session is on, the peers on
 *    it, and the moves that change them: join an existing link, name a new one,
 *    or drop back to the automatic rules. Every click writes immediately; there
 *    is no Save button to forget.
 * 2. **Settings → Plugins → Session Link** — the profile-wide rules
 *    (`autoLinks`, the tool switch, the context line) through `ctx.configForms`,
 *    plus a whole-profile link overview so a human can see the division without
 *    opening every session in turn.
 *
 * The header control is a `scope: "session"` slot occupant, so it receives the
 * live `sessionId` prop: the answer to "who am I" is never guessed from a URL.
 *
 * Field-spec contract (verified against the shipped primitives bundle): every
 * spec carries `field`, `format(value) -> string`, and
 * `parse(text) -> {kind:'set',value}|{kind:'clear'}|undefined`, where
 * `undefined` marks the staged text as invalid. The model's `bind` selector
 * calls `field(name)` for every field at registration time, so a spec missing
 * `format` fails activation — the specs here are total.
 *
 * @module dsh-interlink/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-interlink',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Dictionary namespace owned by this page. */
    const NS = 'session-link'
    /** Host settings namespace: the bundle's Loader patch id, which is what `configForms` addresses. */
    const ENTRY_ID = 'session-link'
    /** Longest link id the Host accepts, mirrored so a bad draft is caught before the write. */
    const MAX_LINK_ID = 40

    /**
     * This plugin's routes, resolved against `document.baseURI`.
     *
     * Relative on purpose: an origin-absolute `/api/...` drops a reverse-proxy
     * prefix, and this GUI is also served under one.
     */
    const api = (path) => {
      try {
        return new URL(`api/session-link/${path}`, document.baseURI).pathname
      } catch {
        return `/api/session-link/${path}`
      }
    }

    /**
     * Header the Host routes require.
     *
     * A cross-site page can send a simple header but cannot send an arbitrary one
     * without a CORS preflight the Host never answers, so this is what keeps
     * another origin from relinking this profile. It is a barrier, not a secret.
     */
    const GUARD = { 'x-session-link': '1' }

    /** Shorten a session id the way the Host does, so the two never disagree about a label. */
    const shortId = (id) => (typeof id === 'string' && id.length > 14 ? id.slice(0, 14) : String(id))

    /** Last path segment of a working directory, for a dense peer row. */
    const baseName = (path) => {
      if (typeof path !== 'string' || path.length === 0) return ''
      const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
      const index = normalized.lastIndexOf('/')
      return index < 0 ? normalized : normalized.slice(index + 1)
    }

    const en = {
      title: 'Session Link',
      description:
        'Lets sessions talk to each other. Sessions on the same link can send each other messages; sessions on different links cannot. You choose the links.',
      autoLinks: 'Group sessions by folder',
      autoLinksHelp:
        'On, sessions opened in the same working directory are grouped onto one link automatically. Off, a session is on no link until someone names one.',
      crossProject: 'Allow cross-project relays',
      crossProjectHelp:
        'Off, sessions on one link can only message each other when their working directories match. On, an explicit link reaches any session on it, whatever folder it was opened in.',
      linkTools: 'Let agents send messages',
      linkToolsHelp:
        'Registers send_session_message, list_session_links, and set_session_link. Off keeps the context line and this panel, and removes the tools.',
      contextLine: 'Tell each agent who its peers are',
      contextLineHelp: 'Adds a line to the runtime context naming the other sessions on this session\'s link. Without it an agent cannot know a peer exists.',
      overview: 'Current links',
      overviewHelp: 'Every session in this profile, grouped by link. Everything here is edited from a session header, not from this page.',
      overviewEmpty: 'No sessions yet.',
      headerAria: 'Session link',
      headerTitle: 'Sessions this one can talk to',
      headerHint: 'Sessions on the same link may message each other. Changes apply immediately.',
      headerLoading: 'Loading…',
      followingDefault: 'no link yet — name one to join',
      noLink: 'not on any link',
      unlinked: 'on no link',
      createHint: 'A link only exists once you name it: sessions on no link cannot see or message anyone.',
      onLink: 'link',
      noPeers: 'no other session on this link yet',
      peersCount: (count) => `${count} peer ${count === 1 ? 'session' : 'sessions'}`,
      join: 'Join a link',
      joinHelp: 'Join a link another session is already on, so the two can talk.',
      newLink: 'New link',
      newLinkPlaceholder: 'name, e.g. review',
      create: 'Create',
      clear: 'Leave every link',
      deleteLink: 'Delete this link',
      joined: 'On these links',
      transcript: 'Messages between agents (verbatim)',
      you: 'this session',
      leaveThis: 'Leave this link',
      moveOthers: 'Other sessions move themselves, or are moved from their own header.',
      running: 'running',
      failed: 'Could not save the change.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'Could not save. Check the value and try again.',
      save: 'Save',
      saving: 'Saving…',
      sessionOnly: 'recorded for this session',
      peers: 'Peers',
    }

    const zh = {
      title: '会话互联',
      description: '让不同会话互相通信：同一条链路上的会话可以互发消息，不同链路之间不通。链路范围由你决定。',
      autoLinks: '按文件夹自动分组',
      autoLinksHelp:
        '开启时，在同一工作目录下打开的会话会自动归到同一条链路；关闭时，会话不在任何链路上，直到有人显式指定名称。',
      crossProject: '允许跨项目转发',
      crossProjectHelp:
        '关闭时，同一链路上的会话只有工作目录一致才能互发消息；开启时，显式链路可以到达其上的任意会话，不论它在哪个目录打开。',
      linkTools: '允许智能体互发消息',
      linkToolsHelp:
        '注册 send_session_message、list_session_links、set_session_link 三个工具。关闭后仍保留常驻上下文行和标题栏面板，只去掉工具。',
      contextLine: '告诉智能体它的对端是谁',
      contextLineHelp: '在运行时上下文里加一行，列出本会话链路上的其他会话。没有这一行，智能体不知道对端存在。',
      overview: '当前链路',
      overviewHelp: '本配置里的所有会话，按链路分组。这里的划分要在各会话标题栏里修改，本页只做总览。',
      overviewEmpty: '还没有会话。',
      headerAria: '会话互联',
      headerTitle: '本会话可以通信的会话',
      headerHint: '同一链路上的会话可以互发消息，改动立即生效。',
      headerLoading: '读取中…',
      followingDefault: '尚未命名链路 — 指定名称即可加入',
      noLink: '不在任何链路上',
      unlinked: '不在任何链路',
      createHint: '链路需要显式指定才有：不在链路上的会话互相看不到，也无法通信。',
      onLink: '链路',
      noPeers: '这条链路上还没有其他会话',
      peersCount: (count) => `${count} 个对端会话`,
      join: '加入已有链路',
      joinHelp: '加入其他会话所在的链路，之后两者即可互发消息。',
      newLink: '新建链路',
      newLinkPlaceholder: '名称，例如 review',
      create: '创建',
      clear: '离开所有链路',
      deleteLink: '删除这条链路',
      joined: '已加入的链路',
      transcript: '智能体之间的消息（原文）',
      you: '本会话',
      leaveThis: '离开这条链路',
      moveOthers: '其他会话由它们自己的标题栏移动。',
      running: '运行中',
      failed: '保存失败。',
      unavailable: '该插件当前未加载，无法配置。',
      readOnly: '当前部署以只读方式保存设置。',
      saveFailed: '保存失败，请检查取值后重试。',
      save: '保存',
      saving: '保存中…',
      sessionOnly: '本会话单独设置',
      peers: '对端',
    }

    /** The form frame's copy, read from this page's dictionary. */
    function formLabels(t) {
      return {
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * A boolean field: booleans are edited as text here because the shared model
     * stages every field as text and parses on read-back. `'on'`/`'off'` keep the
     * staged text human-readable in the model's internal state.
     */
    function switchSpec(field) {
      return {
        field,
        format: (value) => (value === false ? 'off' : 'on'),
        parse: (text) => {
          const normalized = text.trim().toLowerCase()
          if (normalized === 'on' || normalized === 'true' || normalized === '1') return { kind: 'set', value: true }
          if (normalized === 'off' || normalized === 'false' || normalized === '0') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    /**
     * Call one of this plugin's routes.
     *
     * A failed call is reported as `undefined` rather than thrown: the header is
     * chrome, and a Host that is restarting must not unmount it.
     */
    async function request(path, init) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const response = await fetch(api(path), {
          ...init,
          headers: { ...GUARD, ...(init?.headers ?? {}) },
          redirect: 'error',
          signal: controller.signal,
        })
        const body = await response.json().catch(() => undefined)
        return response.ok && body !== undefined ? body : undefined
      } catch {
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Read one session's link and peers.
     *
     * @param {string} sessionId - the session to ask about.
     * @returns the route body, or `undefined` when the call failed.
     */
    function readSession(sessionId) {
      return request(`session?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' })
    }

    /**
     * Move one session onto a link, or back onto the rules.
     *
     * @param {string} sessionId - the session to move.
     * @param {string | null} link - the link, or `null` to clear the assignment.
     * @returns the route body after the write, or `undefined` when it failed.
     */
    function writeSession(sessionId, link, mode) {
      return request('session', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'replace' ? { sessionId, link, mode } : { sessionId, link }),
      })
    }

    /**
     * Forget one named link itself. Members keep their assignment until moved.
     *
     * @param {string} linkId - the link to delete.
     * @returns the route body, or `undefined` when the call failed.
     */
    function deleteLink(linkId) {
      return request('session', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: linkId }) })
    }

    /**
     * Leave one link, keeping the session on any other links it is on.
     *
     * @param {string} sessionId - the session to move.
     * @param {string} linkId - the link to leave.
     * @returns the route body, or `undefined` when the call failed.
     */
    function leaveLink(sessionId, linkId) {
      return request('session', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, link: linkId, mode: 'leave' }),
      })
    }

    /** Read the whole-profile catalogue, for the Settings overview. */
    function readCatalogue() {
      return request('catalogue', { method: 'GET' })
    }

    /** Staged editor over this plugin's Host entry: the profile-wide rules. */
    class LinkCardController {
      constructor(scope) {
        this.form = new primitives.SettingsFormModel(scope, [
          switchSpec('autoLinks'),
          switchSpec('crossProject'),
          switchSpec('linkTools'),
          switchSpec('contextLine'),
        ])
        this.store = this.form.bind(() => ({
          ...this.form.shell(),
          autoLinks: this.form.field('autoLinks'),
          crossProject: this.form.field('crossProject'),
          linkTools: this.form.field('linkTools'),
          contextLine: this.form.field('contextLine'),
        }))
      }

      /** Bind the editor to the slot renderer. */
      inject() {
        const actions = this.form.actions()
        return {
          hooks: { sessionLinkCard: this.store },
          ...actions,
          // The shared form model freezes the expected settings revision when
          // the first field is staged, but that snapshot goes stale as soon as
          // anything else writes this namespace (a Host restart, another tab,
          // an external config edit). configForms.recover() only reloads its
          // mirror on a failed write, so the frozen revision would be
          // resubmitted on every retry and keep conflicting ("保存失败"
          // forever). Drop it before each save: the staged draft is preserved,
          // and configForms still serializes writes against its live mirror
          // revision / pendingRevision. For these local switches, an explicit
          // write should land rather than be blocked by a stale optimistic
          // lock, so the first click succeeds too.
          save: () => {
            this.form.baseline = undefined
            return actions.save()
          },
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    /** One labelled switch row. */
    function SwitchRow({ label, help, disabled, checked, onChange }) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
        h(primitives.Switch, { checked, label, disabled, onChange }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          h('span', { style: { fontSize: '13px', fontWeight: 500 } }, label),
          h('span', { style: { fontSize: '12px', opacity: 0.7 } }, help),
        ),
      )
    }

    /**
     * The link overview: every session, grouped by link.
     *
     * Read-only by design. Moving a session from here would mean editing another
     * conversation's scope from a settings page that has no idea which one is
     * open; the header control is where "this session" is unambiguous.
     */
    function LinkOverview({ t }) {
      const { useState, useEffect } = React
      const [catalogue, setCatalogue] = useState(null)

      useEffect(() => {
        let alive = true
        readCatalogue().then((body) => {
          if (alive && body !== undefined) setCatalogue(body)
        })
        return () => {
          alive = false
        }
      }, [])

      if (catalogue === null) {
        return h('p', { style: { fontSize: '12px', opacity: 0.7, margin: 0 } }, t('headerLoading'))
      }
      if (catalogue.links.length === 0) {
        return h('p', { style: { fontSize: '12px', opacity: 0.7, margin: 0 } }, t('overviewEmpty'))
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 } },
        h('span', { style: { fontSize: '13px', fontWeight: 500 } }, t('overview')),
        h('span', { style: { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 } }, t('overviewHelp')),
        ...catalogue.links.map((link) =>
          h(
            'div',
            { key: link.id, style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            h(
              'span',
              { style: { fontSize: '12px', fontWeight: 600, fontFamily: 'var(--dsw-font-mono, monospace)' } },
              `${link.id} · ${link.members}`,
            ),
            ...link.sessions.map((session) =>
              h(
                'span',
                { key: session.id, style: { fontSize: '12px', opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                `${session.title.length > 0 ? session.title : shortId(session.id)} · ${baseName(session.cwd)}${session.running ? ' ●' : ''}`,
              ),
            ),
          ),
        ),
      )
    }

    /** One settings card: the rules, plus the read-only overview. */
    function LinkCard(props) {
      const { t } = props
      const state = props.useSessionLinkCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      if (!state.available) {
        return h('p', { role: 'status', style: { margin: 0 } }, t('unavailable'))
      }

      const disabled = !state.writable || state.saving
      return h(
        primitives.SettingsForm,
        {
          labels: formLabels(t),
          state,
          onSave: props.save,
          onDiscard: props.discard,
          children: [
            h(
              'div',
              { key: 'fields', style: { display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 } },
              h(SwitchRow, {
                label: t('autoLinks'),
                help: t('autoLinksHelp'),
                disabled,
                checked: state.autoLinks.text !== 'off',
                onChange: (next) => props.edit('autoLinks', next === false ? 'off' : 'on'),
              }),
              h(SwitchRow, {
                label: t('crossProject'),
                help: t('crossProjectHelp'),
                disabled,
                checked: state.crossProject.text !== 'off',
                onChange: (next) => props.edit('crossProject', next === false ? 'off' : 'on'),
              }),
              h(SwitchRow, {
                label: t('linkTools'),
                help: t('linkToolsHelp'),
                disabled,
                checked: state.linkTools.text !== 'off',
                onChange: (next) => props.edit('linkTools', next === false ? 'off' : 'on'),
              }),
              h(SwitchRow, {
                label: t('contextLine'),
                help: t('contextLineHelp'),
                disabled,
                checked: state.contextLine.text !== 'off',
                onChange: (next) => props.edit('contextLine', next === false ? 'off' : 'on'),
              }),
              h(LinkOverview, { key: 'overview', t }),
            ),
          ],
        },
      )
    }

    /**
     * The header control: this session's link, its peers, and the moves.
     *
     * It re-reads on every session change, and every click writes then adopts the
     * Host's answer, so the panel can never show a link the Host did not accept.
     * The slot is a strict `scope: "session"` one, so the renderer never mounts
     * this without a `sessionId`; the guard below is a defensive stop.
     */
    function LinkHeaderControl(props) {
      const { t, sessionId } = props
      const { useState, useEffect, useCallback, useRef } = React
      const [state, setState] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const [draft, setDraft] = useState('')
      const [position, setPosition] = useState(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)

      useEffect(() => {
        if (sessionId === undefined) return undefined
        let alive = true
        setState(null)
        readSession(sessionId).then((body) => {
          if (alive && body !== undefined) setState(body)
        })
        return () => {
          alive = false
        }
      }, [sessionId])

      const commit = useCallback(
        async (link) => {
          if (sessionId === undefined || busy) return
          setBusy(true)
          setFailed(false)
          const body = await writeSession(sessionId, link)
          if (body === undefined) {
            setFailed(true)
            // A refused write leaves the old link in place; re-read so the panel
            // never shows a value the Host did not accept.
            const fresh = await readSession(sessionId)
            if (fresh !== undefined) setState(fresh)
          } else {
            setState(body)
            setDraft('')
          }
          setBusy(false)
        },
        [sessionId, busy],
      )

      const leaveOne = useCallback(
        async (target) => {
          if (typeof target !== 'string' || sessionId === undefined || busy) return
          setBusy(true)
          setFailed(false)
          const body = await leaveLink(sessionId, target)
          if (body === undefined) setFailed(true)
          else setState(body)
          setBusy(false)
        },
        [sessionId, busy],
      )

      const removeLink = useCallback(
        async (target) => {
          if (typeof target !== 'string' || busy) return
          setBusy(true)
          setFailed(false)
          const body = await deleteLink(target)
          if (body === undefined) setFailed(true)
          else setState(body)
          setBusy(false)
        },
        [busy],
      )

      // Every link this session is on: joining one more does not replace the
      // others, so the panel lists the whole set.
      const joined = Array.isArray(state?.linksJoined)
        ? state.linksJoined.filter((entry) => typeof entry === 'string')
        : typeof state?.linkId === 'string'
          ? [state.linkId]
          : []
      const linkId = joined[0]
      const peers = Array.isArray(state?.peers) ? state.peers : []
      // The AI-to-AI transcript, rendered verbatim so the exchange is never a
      // black box: who said what to whom, on which link, at what time.
      const relays = Array.isArray(state?.relays) ? state.relays : []
      const recorded = state?.source === 'session'
      const known = state !== null && state.pending !== true
      const disabled = busy

      // The header slot clips and fades its overflow (its contract says overlays
      // must portal), so this menu renders into `document.body` and is placed
      // from the trigger's own box; a panel inside the header would be clipped
      // to invisibility and the click would look like it did nothing.
      const place = useCallback(() => {
        const rect = triggerRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        const width = 300
        const margin = 8
        const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
        const below = window.innerHeight - rect.bottom
        const openUpward = below < 260 && rect.top > below
        setPosition({
          position: 'fixed',
          left: `${Math.round(left)}px`,
          width: `${width}px`,
          maxHeight: '60vh',
          ...(openUpward
            ? { bottom: `${Math.round(window.innerHeight - rect.top + 6)}px` }
            : { top: `${Math.round(rect.bottom + 6)}px` }),
        })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        place()
        const onPointerDown = (event) => {
          const target = event.target
          if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onResize = () => place()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onResize, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onResize)
          window.removeEventListener('scroll', onResize, true)
        }
      }, [open, place])

      const buttonStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '24px',
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
        background: 'transparent',
        color: recorded ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit',
        fontSize: '12px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !known ? 0.5 : 1,
      }
      const rowButtonStyle = {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '3px 6px',
        borderRadius: 'var(--dsw-radius-sm, 4px)',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: disabled ? 'default' : 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }

      // Links this session could join: every link in the profile except its own,
      // deduplicated, so a human picks an existing grouping instead of retyping
      // the id another session already uses.
      // Every named link is joinable, including one nobody has joined yet: that is
      // the whole point of creating a link by name before its members arrive.
      // Offer only links this session is not already on: with several memberships,
    // "join" must not re-list the ones it holds.
      const others = (Array.isArray(state?.links) ? state.links : []).filter((entry) => !joined.includes(entry.id))

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            style: buttonStyle,
            disabled,
            'aria-label': t('headerAria'),
            'aria-expanded': open,
            title: `${t('headerTitle')} — ${t('headerHint')}`,
            onClick: () => setOpen((value) => !value),
          },
          // A dot marks a session that was moved by hand rather than following
          // the rules, so the header reads at a glance whether this is automatic.
          recorded ? h('span', { 'aria-hidden': 'true', style: { opacity: 0.6 } }, '•') : null,
          t('headerAria'),
          h(
            'span',
            { style: { fontFamily: 'var(--dsw-font-mono, monospace)', fontWeight: 600, maxWidth: '12ch', overflow: 'hidden', textOverflow: 'ellipsis' } },
            known ? (linkId ?? '—') : '–',
          ),
          // Several memberships are one badge, because the trigger has one slot.
          known && joined.length > 1 ? h('span', { style: { opacity: 0.7 } }, `+${joined.length - 1}`) : null,
          known && peers.length > 0 ? h('span', { style: { opacity: 0.7, fontVariantNumeric: 'tabular-nums' } }, String(peers.length)) : null,
        ),
        open && position !== null
          ? createPortal(
              h(
                'div',
                {
                  ref: menuRef,
                  role: 'dialog',
                  'aria-label': t('headerTitle'),
                  style: {
                    ...position,
                    zIndex: 1200,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    padding: '10px',
                    overflowY: 'auto',
                    borderRadius: 'var(--dsw-radius-lg, 8px)',
                    border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
                    background: 'var(--dsw-alias-bg-layer-2, Canvas)',
                    boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.24))',
                    color: 'var(--dsw-alias-label-primary, inherit)',
                  },
                },
              h('span', { style: { fontSize: '12px', fontWeight: 600 } }, t('headerTitle')),
              h(
                'span',
                { style: { fontSize: '11px', opacity: 0.7 } },
                `${t('onLink')} ${known ? (joined.length === 0 ? t('noLink') : joined.join(', ')) : '…'} · ${recorded ? t('sessionOnly') : t('followingDefault')}`,
              ),

              // The peers: the whole reason the panel exists.
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', { style: { fontSize: '11px', fontWeight: 600, opacity: 0.8 } }, t('peers')),
                !known
                  ? h('span', { style: { fontSize: '11px', opacity: 0.7 } }, t('headerLoading'))
                  : peers.length === 0
                    ? h('span', { style: { fontSize: '11px', opacity: 0.7 } }, t('noPeers'))
                    : peers.map((peer) =>
                        h(
                          'span',
                          {
                            key: peer.id,
                            title: peer.id,
                            style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                          },
                          `${peer.title.length > 0 ? peer.title : shortId(peer.id)}${peer.running ? ' ●' : ''} · ${baseName(peer.cwd)}`,
                        ),
                      ),
              ),

              // The plain-text transcript of AI-to-AI messages. Bodies are shown
              // whole, not summarised: the point is to remove the black box.
              known && relays.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    h('span', { style: { fontSize: '11px', fontWeight: 600, opacity: 0.8 } }, t('transcript')),
                    ...relays.slice(-8).map((entry, index) =>
                      h(
                        'div',
                        {
                          key: `${entry.at}-${index}`,
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '1px',
                            padding: '4px 6px',
                            borderRadius: 'var(--dsw-radius-sm, 4px)',
                            border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3))',
                          },
                        },
                        h(
                          'span',
                          { style: { fontSize: '10px', opacity: 0.7, fontFamily: 'var(--dsw-font-mono, monospace)' } },
                          `${entry.from === sessionId ? t('you') : shortId(entry.from)} → ${entry.to === sessionId ? t('you') : shortId(entry.to)} @ ${entry.link || '—'}`,
                        ),
                        h(
                          'span',
                          { style: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                          entry.body,
                        ),
                      ),
                    ),
                  )
                : null,

              // Current memberships: a session may hold several, so each is its
              // own row with its own way out.
              known && joined.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    h('span', { style: { fontSize: '11px', fontWeight: 600, opacity: 0.8 } }, t('joined')),
                    ...joined.map((id) =>
                      h(
                        'div',
                        { key: id, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                        h(
                          'span',
                          { style: { flex: 1, fontSize: '12px', fontFamily: 'var(--dsw-font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: id },
                          id,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            disabled,
                            title: t('leaveThis'),
                            'aria-label': `${t('leaveThis')}: ${id}`,
                            style: { ...rowButtonStyle, width: 'auto', padding: '0 6px' },
                            onClick: () => leaveOne(id),
                          },
                          '×',
                        ),
                      ),
                    ),
                  )
                : null,

              known && others.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    h('span', { style: { fontSize: '11px', fontWeight: 600, opacity: 0.8 } }, t('join')),
                    ...others.slice(0, 8).map((entry) =>
                      h(
                        'div',
                        { key: entry.id, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            disabled,
                            style: { ...rowButtonStyle, flex: 1 },
                            title: entry.id,
                            onClick: () => commit(entry.id),
                          },
                          `${entry.id} · ${entry.members}`,
                        ),
                        entry.members === 0
                          ? h(
                              'button',
                              {
                                type: 'button',
                                disabled,
                                title: t('deleteLink'),
                                'aria-label': `${t('deleteLink')}: ${entry.id}`,
                                style: { ...rowButtonStyle, width: 'auto', padding: '0 6px' },
                                onClick: () => removeLink(entry.id),
                              },
                              '×',
                            )
                          : null,
                      ),
                    ),
                  )
                : null,

              // A brand-new link, so a human can carve out a group that does not
              // exist yet without first moving some other session.
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                h('span', { style: { fontSize: '11px', fontWeight: 600, opacity: 0.8 } }, t('newLink')),
                h(
                  'div',
                  { style: { display: 'flex', gap: '4px' } },
                  h('input', {
                    type: 'text',
                    value: draft,
                    maxLength: MAX_LINK_ID,
                    placeholder: t('newLinkPlaceholder'),
                    disabled,
                    'aria-label': t('newLink'),
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && draft.trim().length > 0) commit(draft.trim().toLowerCase())
                    },
                    style: {
                      flex: 1,
                      minWidth: 0,
                      height: '22px',
                      padding: '0 6px',
                      borderRadius: 'var(--dsw-radius-sm, 4px)',
                      border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '12px',
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: disabled || draft.trim().length === 0,
                      style: { ...rowButtonStyle, width: 'auto', padding: '0 8px' },
                      onClick: () => commit(draft.trim().toLowerCase()),
                    },
                    t('create'),
                  ),
                ),
              ),

              // Leaving is offered whenever the session is on a link at all, not only
              // when the assignment was recorded by hand: a rules-derived link must be
              // escapable too.
              linkId !== undefined && !disabled
                ? h(
                    'button',
                    { type: 'button', style: { ...rowButtonStyle, textAlign: 'center' }, onClick: () => commit(null) },
                    t('clear'),
                  )
                : null,

              h('span', { style: { fontSize: '11px', opacity: 0.7, lineHeight: 1.4 } }, t('headerHint')),
              h('span', { style: { fontSize: '11px', opacity: 0.6, lineHeight: 1.4 } }, t('moveOthers')),
              failed ? h('span', { role: 'alert', style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #c00)' } }, t('failed')) : null,
            )
              ,
              document.body,
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-link: dictionaries')

        const card = new LinkCardController(ctx.configForms.get(ENTRY_ID))
        ctx.effect(() => () => {
          card.dispose()
        }, 'session-link: form subscription')
        const face = card.inject()

        ctx.effect(
          () =>
            ctx.configForms.whileServed([ENTRY_ID], () =>
              ctx.slots.inject('plugins.item', () =>
                ctx.slots.register(
                  {
                    name: 'plugins.item',
                    id: 'session-link',
                    order: 16,
                    label: () => t('title'),
                    locale: NS,
                    inject: () => face,
                  },
                  LinkCard,
                ),
              ),
            ),
          'session-link: page',
        )

        // Header control: this session's link, written through the plugin's own
        // routes. It does not depend on `configForms`, so it keeps working while
        // the settings document is unavailable.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.session.header.actions', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.actions',
                  id: 'session-link',
                  order: 6,
                  locale: NS,
                  inject: () => ({}),
                },
                LinkHeaderControl,
              ),
            ),
          'session-link: header control',
        )
      },
    }
  },
})
