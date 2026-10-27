/**
 * The Ctrl+P / Ctrl+Alt+O palette as the reader meets it: type, arrow, Enter.
 *
 * The host's ranking is pinned by `tests/file-index.spec.ts`; this file pins
 * the overlay — debounced querying, row rendering, keyboard selection, and the
 * two ways a row can be opened (in place, or in a split with Alt).
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { NavPalette } from '../src/client/NavPalette.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { setupReactAct, renderRoot, type RenderedRoot } from './test-utils.ts'

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      navFind: vi.fn(),
      symbolsOutline: vi.fn(),
    },
  }
})

const { api } = await import('../src/client/api.ts')
const navFind = vi.mocked(api.navFind)
const symbolsOutline = vi.mocked(api.symbolsOutline)

setupReactAct()

class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } { return { active: this.active } }
  subscribe(_fn: () => void): () => void { return () => {} }
}

attachLocale(new FakeLocale() as never)

const scope = { sessionId: 's1', cwd: '/work' }

/** The palette renders through a portal, so rows live outside the root. */
const dialog = (): HTMLElement => {
  const node = document.querySelector('[role="dialog"]')
  if (node === null) throw new Error('palette did not open')
  return node as HTMLElement
}
const input = (): HTMLInputElement => dialog().querySelector('input') as HTMLInputElement
const rows = (): HTMLElement[] => Array.from(dialog().querySelectorAll('[role="option"]'))

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
}

async function typeInto(text: string): Promise<void> {
  await act(async () => {
    const node = input()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, text)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

let rendered: RenderedRoot | undefined
const onClose = vi.fn()
const onOpenFile = vi.fn()
const onOpenFileSide = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  rendered?.unmount()
  rendered = undefined
  for (const node of Array.from(document.body.children)) node.remove()
})

function mount(mode: 'files' | 'outline', path = '/work/src/a.ts'): void {
  rendered = renderRoot(createElement(NavPalette, { mode, scope, path, onClose, onOpenFile, onOpenFileSide }))
}

describe('NavPalette files mode', () => {
  it('asks the host for an empty query on open and renders the rows', async () => {
    navFind.mockResolvedValue({
      matches: [
        { path: 'src/a.ts', score: 12 },
        { path: 'docs/a-guide.md', score: 3 },
      ],
      total: 2,
      truncated: false,
      source: 'files',
    })
    mount('files')
    await settle()
    expect(navFind).toHaveBeenCalledWith(scope, { query: '', limit: 60 }, expect.anything())
    expect(rows().map(row => row.textContent)).toEqual(['a.tssrc/a.ts', 'a-guide.mddocs/a-guide.md'])
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('debounces typing into one host query', async () => {
    navFind.mockResolvedValue({ matches: [], total: 0, truncated: false, source: 'files' })
    mount('files')
    await settle()
    navFind.mockClear()
    await typeInto('ed')
    expect(navFind).toHaveBeenCalledTimes(1)
    expect(navFind).toHaveBeenCalledWith(scope, { query: 'ed', limit: 60 }, expect.anything())
    expect(dialog().textContent).toContain('No matches')
  })

  it('moves the selection with the arrow keys and opens with Enter', async () => {
    navFind.mockResolvedValue({
      matches: [
        { path: 'src/a.ts', score: 12 },
        { path: 'src/b.ts', score: 8 },
      ],
      total: 2,
      truncated: false,
      source: 'files',
    })
    mount('files')
    await settle()
    await press('ArrowDown')
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    await press('ArrowDown')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
    await press('ArrowDown')
    await press('Enter')
    // Root-relative paths resolve against the session cwd before opening.
    expect(onOpenFile).toHaveBeenCalledWith({ path: '/work/src/b.ts', line: undefined, column: undefined })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens in a split when Enter is pressed with Alt', async () => {
    navFind.mockResolvedValue({ matches: [{ path: 'src/a.ts', score: 12 }], total: 1, truncated: false, source: 'files' })
    mount('files')
    await settle()
    await press('Enter', { altKey: true })
    expect(onOpenFileSide).toHaveBeenCalledWith({ path: '/work/src/a.ts', line: undefined, column: undefined })
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('closes on Escape without opening anything', async () => {
    navFind.mockResolvedValue({ matches: [{ path: 'src/a.ts', score: 12 }], total: 1, truncated: false, source: 'files' })
    mount('files')
    await settle()
    await press('Escape')
    expect(onClose).toHaveBeenCalled()
    expect(onOpenFile).not.toHaveBeenCalled()
  })
})

describe('NavPalette outline mode', () => {
  const outline = {
    symbols: [
      { path: '/work/src/a.ts', line: 1, column: 1, name: 'Shape', kind: 'interface', source: 'export interface Shape {' },
      { path: '/work/src/a.ts', line: 6, column: 1, name: 'areaOf', kind: 'function', source: 'export function areaOf(shape: Shape) {' },
    ],
    truncated: false,
  }

  it('lists the document declarations and opens one at its line', async () => {
    symbolsOutline.mockResolvedValue(outline)
    mount('outline')
    await settle()
    expect(symbolsOutline).toHaveBeenCalledWith(scope, { path: '/work/src/a.ts' }, expect.anything())
    expect(rows().map(row => row.textContent)).toEqual(['Shapeinterface1', 'areaOffunction6'])
    await press('ArrowDown')
    await press('Enter')
    expect(onOpenFile).toHaveBeenCalledWith({ path: '/work/src/a.ts', line: 6, column: 1 })
  })

  it('filters locally without another host call', async () => {
    symbolsOutline.mockResolvedValue(outline)
    mount('outline')
    await settle()
    await typeInto('area')
    expect(symbolsOutline).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain('areaOf')
  })

  it('says so when the document declares nothing', async () => {
    symbolsOutline.mockResolvedValue({ symbols: [], truncated: false })
    mount('outline')
    await settle()
    expect(dialog().textContent).toContain('No declarations found in this file')
  })
})
