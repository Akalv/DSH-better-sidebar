/**
 * Per-session navigation history for the editor: IDEA-style back/forward.
 *
 * The history is a browser-style stack of the files the reader visited, with
 * the line a reference landed on when the visit came from a `path:line`
 * reference. It is deliberately NOT part of the sidebar state reducer: tabs
 * are pane-scoped (the same file can sit in two panes, and a tab id dies with
 * its pane), while "where was I reading" is a property of the READER, not of
 * any one tab. A flat list of locations, replayed by opening them again, also
 * survives tab closes: going back to a file the reader closed re-opens it.
 *
 * Persistence: one localStorage record per session (`dsh-sidebar:nav:v1:<id>`),
 * capped at {@link NAV_LIMIT} entries. `sanitizePersistedTab` never sees this —
 * it is reader state, not layout, and it must not be restored into tabs.
 *
 * Replay vs. new navigation: going back/forward re-opens a location, and the
 * editor that lands there RECORDS it again (that is how every open is tracked).
 * Without help that re-record would truncate the forward stack — the classic
 * "back twice, forward is gone" bug. {@link NavHistory.back}/{@link NavHistory.forward}
 * therefore leave a one-shot `pending` marker; the next `record` of exactly
 * that location is swallowed instead of pushed. Any other record (a real
 * navigation) truncates normally.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** One visited place. A location without `line` is a plain file open. */
export interface NavLocation {
  /** Absolute file path (the editor's own addressing). */
  path: string
  /** The 1-based line the visit landed on, when it came from a line reference. */
  line?: number
  /** The 1-based column a definition jump landed on (line references carry no
   *  column). Part of the replay payload but NOT of a location's identity: the
   *  same file:line read from a different column is the same place. */
  column?: number
  /** Display title remembered at visit time (tab titles are path-derived). */
  title?: string
}

export interface NavSnapshot {
  readonly entries: readonly NavLocation[]
  /** Index of the CURRENT entry; -1 when the history is empty. */
  readonly index: number
}

/** How many locations a session keeps; the oldest fall off the front. */
export const NAV_LIMIT = 60
/** A repeat of the current location inside this window updates it in place
 *  instead of pushing a duplicate (mirrors a browser's same-document visit). */
export const NAV_MERGE_MS = 1500
/** How long a replay marker stays valid for its re-record. */
const PENDING_TTL_MS = 3000
const STORAGE_PREFIX = 'dsh-sidebar:nav:v1'
/** Session histories kept in memory; older ones are evicted (persisted bytes
 *  stay, and re-entering a session reloads from localStorage). */
const CACHE_LIMIT = 8

const EMPTY_SNAPSHOT: NavSnapshot = { entries: [], index: -1 }

/** Whether two locations name the same place (line included). */
export function sameNavLocation(a: NavLocation, b: NavLocation): boolean {
  return a.path === b.path && (a.line ?? 0) === (b.line ?? 0)
}

/** Coerce an untrusted value into a location, or null when it cannot be one. */
export function sanitizeNavLocation(value: unknown): NavLocation | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as { path?: unknown; line?: unknown; column?: unknown; title?: unknown }
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (path === '') return null
  const line = typeof record.line === 'number' && Number.isInteger(record.line) && record.line > 0
    ? record.line
    : undefined
  const column = typeof record.column === 'number' && Number.isInteger(record.column) && record.column > 0
    ? record.column
    : undefined
  const title = typeof record.title === 'string' && record.title !== '' ? record.title : undefined
  return { path, line, column, title }
}

/** Parse one persisted record (an untrusted JSON blob) into a snapshot. */
export function parseNavSnapshot(value: unknown): NavSnapshot {
  if (value === null || typeof value !== 'object') return EMPTY_SNAPSHOT
  const record = value as { entries?: unknown; index?: unknown }
  if (!Array.isArray(record.entries)) return EMPTY_SNAPSHOT
  const entries: NavLocation[] = []
  for (const item of record.entries) {
    const location = sanitizeNavLocation(item)
    if (location !== null) entries.push(location)
  }
  if (entries.length === 0) return EMPTY_SNAPSHOT
  const capped = entries.slice(-NAV_LIMIT)
  const raw = typeof record.index === 'number' && Number.isInteger(record.index) ? record.index : capped.length - 1
  const index = Math.min(Math.max(raw, 0), capped.length - 1)
  return { entries: capped, index }
}

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}:${sessionId}`
}

function readSnapshot(sessionId: string): NavSnapshot {
  if (typeof localStorage === 'undefined') return EMPTY_SNAPSHOT
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    if (raw === null) return EMPTY_SNAPSHOT
    return parseNavSnapshot(JSON.parse(raw))
  } catch {
    // Corrupt or unreadable (storage disabled, private mode): start empty.
    return EMPTY_SNAPSHOT
  }
}

/**
 * One session's back/forward stack. Construct through {@link navHistoryFor} —
 * a second instance for the same session would fork the history and the
 * localStorage record.
 */
export class NavHistory {
  private snapshot: NavSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  /** Time of the last actual push (drives the merge window). */
  private lastPushAt = 0
  /** The location a back/forward just moved to, awaiting its re-record. */
  private pending: { location: NavLocation; at: number } | null = null

  constructor(private readonly sessionId: string) {
    this.snapshot = readSnapshot(sessionId)
  }

  /** Stable across renders (useSyncExternalStore's subscribe argument). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stable snapshot identity until the history actually changes. */
  readonly getSnapshot = (): NavSnapshot => this.snapshot

  /**
   * Record a visit. Consecutive visits to the same place inside
   * {@link NAV_MERGE_MS} update one entry; anything else truncates the forward
   * stack and pushes. A visit that fulfils a pending back/forward replay is
   * swallowed (the index already points at it).
   */
  record(location: NavLocation, at: number = Date.now()): void {
    const next = sanitizeNavLocation(location)
    if (next === null) return
    const pending = this.pending
    if (pending !== null) {
      this.pending = null
      if (at - pending.at <= PENDING_TTL_MS && sameNavLocation(pending.location, next)) return
    }
    const { entries, index } = this.snapshot
    const current = entries[index]
    if (current !== undefined && sameNavLocation(current, next) && at - this.lastPushAt <= NAV_MERGE_MS) {
      if (current.line === next.line && current.column === next.column && current.title === next.title) return
      const updated = entries.slice()
      updated[index] = next
      this.commit({ entries: updated, index })
      return
    }
    const kept = index >= 0 ? entries.slice(0, index + 1) : []
    kept.push(next)
    while (kept.length > NAV_LIMIT) kept.shift()
    this.lastPushAt = at
    this.commit({ entries: kept, index: kept.length - 1 })
  }

  /** Step one place back; null at the start of the history. */
  back(): NavLocation | null {
    const { entries, index } = this.snapshot
    if (index <= 0) return null
    const target = entries[index - 1]
    if (target === undefined) return null
    this.pending = { location: target, at: Date.now() }
    this.commit({ entries, index: index - 1 })
    return target
  }

  /** Step one place forward; null at the end of the history. */
  forward(): NavLocation | null {
    const { entries, index } = this.snapshot
    if (index < 0 || index >= entries.length - 1) return null
    const target = entries[index + 1]
    if (target === undefined) return null
    this.pending = { location: target, at: Date.now() }
    this.commit({ entries, index: index + 1 })
    return target
  }

  private commit(next: NavSnapshot): void {
    this.snapshot = next
    this.persist()
    for (const listener of [...this.listeners]) listener()
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return
    const { entries, index } = this.snapshot
    try {
      if (entries.length === 0) {
        localStorage.removeItem(storageKey(this.sessionId))
        return
      }
      localStorage.setItem(storageKey(this.sessionId), JSON.stringify({ entries, index }))
    } catch {
      // Quota/disabled storage: the in-memory history keeps working.
    }
  }
}

const histories = new Map<string, NavHistory>()

/** The session's singleton history (created on first use, LRU-capped). */
export function navHistoryFor(sessionId: string): NavHistory {
  const existing = histories.get(sessionId)
  if (existing !== undefined) return existing
  const created = new NavHistory(sessionId)
  histories.set(sessionId, created)
  while (histories.size > CACHE_LIMIT) {
    const oldest = histories.keys().next()
    if (oldest.done === true) break
    histories.delete(oldest.value)
  }
  return created
}

/** Drop every cached instance (tests; a session switch keeps them warm). */
export function resetNavHistoryCache(): void {
  histories.clear()
}

export interface NavHistoryHandle {
  readonly entries: readonly NavLocation[]
  readonly index: number
  readonly canBack: boolean
  readonly canForward: boolean
  readonly record: (location: NavLocation) => void
  readonly back: () => NavLocation | null
  readonly forward: () => NavLocation | null
}

/** Subscribe a component to one session's navigation history. */
export function useNavHistory(sessionId: string): NavHistoryHandle {
  const history = useMemo(() => navHistoryFor(sessionId), [sessionId])
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot)
  const record = useCallback((location: NavLocation) => { history.record(location) }, [history])
  const back = useCallback(() => history.back(), [history])
  const forward = useCallback(() => history.forward(), [history])
  return {
    entries: snapshot.entries,
    index: snapshot.index,
    canBack: snapshot.index > 0,
    canForward: snapshot.index >= 0 && snapshot.index < snapshot.entries.length - 1,
    record,
    back,
    forward,
  }
}
