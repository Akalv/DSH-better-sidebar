/**
 * Unit tests for the per-session navigation history (src/client/nav-history.ts).
 *
 * The rules pinned here are the ones a back/forward stack gets wrong:
 * - a new navigation TRUNCATES the forward stack, but a replay (back, then
 *   forward) must not — the editor that lands on a replayed location records
 *   it again, and that re-record is what used to eat the forward stack;
 * - a repeat of the same place inside the merge window updates one entry
 *   instead of pushing a duplicate;
 * - the stack is capped (oldest fall off the front, the index follows);
 * - a persisted record round-trips, and a corrupt one starts empty instead of
 *   throwing.
 *
 * `localStorage` is provided by the jsdom environment; each test clears it so
 * the module-level session cache cannot leak state across cases.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NAV_LIMIT,
  NAV_MERGE_MS,
  NavHistory,
  navHistoryFor,
  parseNavSnapshot,
  resetNavHistoryCache,
  sameNavLocation,
  sanitizeNavLocation,
} from '../src/client/nav-history.ts'

const A = { path: '/w/a.ts' }
const B = { path: '/w/b.ts' }
const C = { path: '/w/c.ts', line: 42 }

beforeEach(() => {
  localStorage.clear()
  resetNavHistoryCache()
})

describe('record', () => {
  it('pushes distinct locations and moves the index to the newest', () => {
    const history = new NavHistory('s1')
    history.record(A, 1000)
    history.record(B, 2000)
    expect(history.getSnapshot()).toEqual({ entries: [A, B], index: 1 })
  })

  it('truncates the forward stack when a new location is recorded after going back', () => {
    const history = new NavHistory('s1')
    history.record(A, 1000)
    history.record(B, 2000)
    history.record(C, 3000)
    expect(history.back()).toEqual(B)
    expect(history.getSnapshot().index).toBe(1)
    history.record({ path: '/w/d.ts' }, 10_000)
    expect(history.getSnapshot().entries.map(entry => entry.path)).toEqual(['/w/a.ts', '/w/b.ts', '/w/d.ts'])
    expect(history.getSnapshot().index).toBe(2)
  })

  it('merges a repeat of the current place inside the merge window', () => {
    const history = new NavHistory('s1')
    history.record(A, 1000)
    history.record({ path: '/w/a.ts', title: 'A' }, 1000 + NAV_MERGE_MS)
    expect(history.getSnapshot().entries).toEqual([{ path: '/w/a.ts', title: 'A' }])
  })

  it('pushes a repeat of the current place after the merge window', () => {
    const history = new NavHistory('s1')
    history.record(A, 1000)
    history.record(A, 1000 + NAV_MERGE_MS + 1)
    expect(history.getSnapshot().entries).toHaveLength(2)
  })

  it('caps the stack and keeps the index on the newest entry', () => {
    const history = new NavHistory('s1')
    for (let index = 0; index < NAV_LIMIT + 5; index += 1) {
      history.record({ path: `/w/f${index}.ts` }, index * 10_000)
    }
    const snapshot = history.getSnapshot()
    expect(snapshot.entries).toHaveLength(NAV_LIMIT)
    expect(snapshot.entries[0]?.path).toBe('/w/f5.ts')
    expect(snapshot.index).toBe(NAV_LIMIT - 1)
  })

  it('ignores a location that cannot name a file', () => {
    const history = new NavHistory('s1')
    history.record({ path: '   ' })
    expect(history.getSnapshot().index).toBe(-1)
  })
})

describe('back / forward', () => {
  it('walks the stack and stops at both ends', () => {
    const history = new NavHistory('s1')
    history.record(A, 1000)
    history.record(B, 2000)
    expect(history.back()).toEqual(A)
    expect(history.back()).toBeNull()
    expect(history.forward()).toEqual(B)
    expect(history.forward()).toBeNull()
  })

  it('survives the re-record that replaying a location triggers', () => {
    const history = new NavHistory('s1')
    history.record(A, 1000)
    history.record(B, 2000)
    history.record(C, 3000)
    const target = history.back()
    expect(target).toEqual(B)
    // The editor lands on B and records it: the forward stack MUST survive.
    history.record(B, 3100)
    expect(history.getSnapshot().entries.map(entry => entry.path)).toEqual(['/w/a.ts', '/w/b.ts', '/w/c.ts'])
    expect(history.forward()).toEqual(C)
  })

  it('keeps a same-file:line revisit as its own entry', () => {
    const history = new NavHistory('s1')
    history.record(C, 1000)
    history.record(A, 2000)
    // Far enough apart to be a new visit, not a merge.
    history.record(C, 5000)
    expect(history.getSnapshot().entries).toEqual([C, A, C])
    expect(history.back()).toEqual(A)
    expect(history.back()).toEqual(C)
  })
})

describe('persistence', () => {
  it('round-trips through localStorage', () => {
    const first = new NavHistory('s2')
    first.record(A, 1000)
    first.record(C, 2000)
    first.back()
    const second = new NavHistory('s2')
    expect(second.getSnapshot()).toEqual({ entries: [A, C], index: 0 })
  })

  it('starts empty on a corrupt record', () => {
    localStorage.setItem('dsh-sidebar:nav:v1:s3', '{not json')
    expect(new NavHistory('s3').getSnapshot().index).toBe(-1)
  })

  it('shares one instance per session', () => {
    expect(navHistoryFor('s4')).toBe(navHistoryFor('s4'))
    expect(navHistoryFor('s4')).not.toBe(navHistoryFor('s5'))
  })
})

describe('parsing', () => {
  it('clamps an out-of-range index and drops malformed entries', () => {
    const parsed = parseNavSnapshot({
      entries: [A, { path: '' }, 'nope', C],
      index: 99,
    })
    expect(parsed).toEqual({ entries: [A, C], index: 1 })
  })

  it('compares locations by path and line', () => {
    expect(sameNavLocation({ path: '/w/a.ts' }, { path: '/w/a.ts', line: undefined })).toBe(true)
    expect(sameNavLocation({ path: '/w/a.ts', line: 1 }, { path: '/w/a.ts', line: 2 })).toBe(false)
  })

  it('rejects non-positive or fractional line numbers', () => {
    expect(sanitizeNavLocation({ path: '/w/a.ts', line: 0 })).toEqual({ path: '/w/a.ts', line: undefined, title: undefined })
    expect(sanitizeNavLocation({ path: '/w/a.ts', line: 1.5 })).toEqual({ path: '/w/a.ts', line: undefined, title: undefined })
  })
})
