/**
 * The definition jump as the reader meets it: F12 in the code editor.
 *
 * The gestures themselves are pinned by `tests/nav-definition.spec.ts` and the
 * symbol resolution by `tests/symbols.spec.ts`; this file pins the middle — the
 * editor asks the host, then either jumps, offers the candidates in a picker, or
 * says quietly that it found nothing.
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

// Only `symbolsDefinition` is stubbed: the editor's other collaborators (the git
// gutter's status poller, media URLs) ride the real module so their no-ops in
// jsdom behave exactly as they do in the other editor specs.
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, symbolsDefinition: vi.fn() } }
})

const { api } = await import('../src/client/api.ts')
const definition = vi.mocked(api.symbolsDefinition)

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
}

attachLocale(new FakeLocale() as never)

const CONTENT = 'const needle = 1\n'

const base = (overrides: Partial<FileViewerProps> = {}): FileViewerProps => ({
  ctx: {} as FileViewerProps['ctx'],
  store: createSidebarStore(),
  scope: { sessionId: 's1', cwd: '/workspace' },
  path: '/workspace/a.ts',
  title: 'a.ts',
  viewerId: 'code',
  content: CONTENT,
  toolbar: 'host',
  ...overrides,
})

const hit = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: '/workspace/other.ts',
  line: 3,
  column: 7,
  name: 'needle',
  kind: 'var',
  source: 'symbol',
  score: 10,
  ...overrides,
})

let rendered: RenderedRoot | undefined

const mount = (overrides: Partial<FileViewerProps> = {}): { container: HTMLDivElement; view: EditorView } => {
  rendered = renderRoot(createElement(TextEditor, base(overrides)))
  const element = rendered.container.querySelector('.cm-editor')
  if (element === null) throw new Error('no CodeMirror surface')
  const view = EditorView.findFromDOM(element as HTMLElement)
  if (view === null) throw new Error('no CodeMirror view')
  return { container: rendered.container, view }
}

/** F12 as CodeMirror receives it: on the editor surface, from the caret. */
const pressF12 = async (view: EditorView, anchor = 6): Promise<void> => {
  act(() => { view.dispatch({ selection: { anchor } }) })
  const event = new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true })
  await act(async () => {
    view.contentDOM.dispatchEvent(event)
    await Promise.resolve()
  })
}

describe('TextEditor jumps to a definition', () => {
  beforeEach(() => {
    definition.mockReset()
  })

  afterEach(() => {
    rendered?.unmount()
    rendered = undefined
    document.querySelectorAll('[role="listbox"], [role="status"]').forEach((node) => { node.remove() })
  })

  it('opens a single hit in this window, at its line and column', async () => {
    definition.mockResolvedValue({ candidates: [hit()], truncated: false } as never)
    const onOpenLocation = vi.fn()
    const { view } = mount({ onOpenLocation })
    await pressF12(view)
    expect(definition).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', cwd: '/workspace' }),
      { path: '/workspace/a.ts', word: 'needle', line: 1, column: 7 },
    )
    expect(onOpenLocation).toHaveBeenCalledWith({ path: '/workspace/other.ts', line: 3, column: 7 }, 'default')
  })

  it('offers every candidate when a name has more than one declaration', async () => {
    definition.mockResolvedValue({ candidates: [hit(), hit({ path: '/workspace/b.ts', line: 9, column: 1 })], truncated: false } as never)
    const onOpenLocation = vi.fn()
    const { view } = mount({ onOpenLocation })
    await pressF12(view)
    expect(onOpenLocation).not.toHaveBeenCalled()
    const list = document.querySelector('[role="listbox"]')
    expect(list).not.toBeNull()
    expect(list!.querySelectorAll('[role="option"]')).toHaveLength(2)
  })

  it('moves through the picker with the arrow keys and opens with Enter', async () => {
    definition.mockResolvedValue({ candidates: [hit(), hit({ path: '/workspace/b.ts', line: 9, column: 1 })], truncated: false } as never)
    const onOpenLocation = vi.fn()
    const { view } = mount({ onOpenLocation })
    await pressF12(view)
    // Two separate flushes: the move must land in state before Enter reads it.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpenLocation).toHaveBeenCalledWith({ path: '/workspace/b.ts', line: 9, column: 1 })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('closes the picker on Escape without opening anything', async () => {
    definition.mockResolvedValue({ candidates: [hit(), hit({ path: '/workspace/b.ts', line: 9 })], truncated: false } as never)
    const onOpenLocation = vi.fn()
    const { view } = mount({ onOpenLocation })
    await pressF12(view)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onOpenLocation).not.toHaveBeenCalled()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('says so when the name has no declaration', async () => {
    definition.mockResolvedValue({ candidates: [], truncated: false } as never)
    const onOpenLocation = vi.fn()
    const { view } = mount({ onOpenLocation })
    await pressF12(view)
    expect(onOpenLocation).not.toHaveBeenCalled()
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No definition found')
  })
})
