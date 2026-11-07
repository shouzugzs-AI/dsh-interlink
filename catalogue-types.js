/**
 * The wire shape of one session row, shared by the store, the catalogue, the
 * tools, and the browser half.
 *
 * Written out once because a row crosses three boundaries (Host → HTTP JSON →
 * React state) and a mismatch in any of them would show as "a session the UI
 * lists but the tool cannot send to". Normalizing on entry means every consumer
 * sees the same keys with the same types, and a malformed record is dropped here
 * rather than surfacing as `undefined` in a render.
 *
 * @module dsh-interlink/catalogue-types
 */

/**
 * Normalize one session row.
 *
 * Unknown extra keys are dropped on purpose: this is the durable, printable
 * shape, so it must not start carrying whatever a future `SessionSummary`
 * happens to add until something here asks for it.
 *
 * @param {object} record - a partially known session.
 * @returns {object} the normalized row.
 */
export function normalizeLive(record) {
  const sessionId = typeof record?.id === 'string' ? record.id : ''
  const origin = record?.origin === 'subagent' ? 'subagent' : undefined
  const title = typeof record?.title === 'string' ? record.title.trim() : ''
  const row = {
    id: sessionId,
    title: title.length > 0 ? (title.length > 80 ? `${title.slice(0, 79)}…` : title) : '',
    cwd: typeof record?.cwd === 'string' && record.cwd.length > 0 ? record.cwd : '',
    running: record?.running === true,
    blank: record?.blank === true,
    updatedAt: typeof record?.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
  if (origin !== undefined) row.origin = origin
  if (typeof record?.parentSessionId === 'string' && record.parentSessionId.length > 0) {
    row.parentSessionId = record.parentSessionId
  }
  return row
}

/**
 * The empty catalogue.
 *
 * Returned when the Host cannot list sessions (no `sessionQuery` in this
 * profile) so every consumer reads a well-formed answer instead of branching on
 * `undefined`.
 *
 * @returns {object} an empty catalogue.
 */
export function emptyCatalogue() {
  return { focus: null, focusLink: null, links: [], manual: {}, persisted: true, total: 0 }
}

/**
 * The empty per-session view, used before the Host has answered.
 *
 * @param {string} sessionId - the session being asked about.
 * @returns {object} the empty view.
 */
export function emptySessionView(sessionId) {
  return {
    sessionId,
    linkId: null,
    source: 'default',
    peers: [],
    links: [],
    persisted: true,
    pending: true,
  }
}
