/**
 * Alt+F7 in the code editor: "find usages" asks the host for the call sites of
 * the name under the caret. The list itself is pinned by
 * `tests/nav-palette.spec.tsx`; this file pins the gesture — the name the
 * editor reports, and that a caret on whitespace simply declines.
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

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api } }
})

setupReactAct()

class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } { return { active: this.active } }
  subscribe(_fn: () => void): () => void { return () => {} }
}

attachLocale(new FakeLocale() as never)

const base = (overrides: Partial<FileViewerProps> = {}): FileViewerProps => ({
  ctx: {} as FileViewerProps['ctx'],
  store: createSidebarStore(),
  scope: { sessionId: 's1', cwd: '/workspace' },
  path: '/workspace/a.ts',
  title: 'a.ts',
  viewerId: 'code',
  content: 'const needle = 1\n',
  toolbar: 'host',
  ...overrides,
})

let rendered: RenderedRoot | undefined

const mount = (onFindUsages: (word: string) => void, overrides: Partial<FileViewerProps> = {}): EditorView => {
  rendered = renderRoot(createElement(TextEditor, base({ onFindUsages, ...overrides })))
  const element = rendered.container.querySelector('.cm-editor')
  if (element === null) throw new Error('no CodeMirror surface')
  const view = EditorView.findFromDOM(element as HTMLElement)
  if (view === null) throw new Error('no CodeMirror view')
  return view
}

const pressAltF7 = async (view: EditorView, anchor: number): Promise<void> => {
  act(() => { view.dispatch({ selection: { anchor } }) })
  await act(async () => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', altKey: true, bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

describe('TextEditor finds usages', () => {
  beforeEach(() => { vi.clearAllMocks() })

  afterEach(() => {
    rendered?.unmount()
    rendered = undefined
  })

  it('reports the name under the caret', async () => {
    const onFindUsages = vi.fn()
    const view = mount(onFindUsages)
    await pressAltF7(view, 7)
    expect(onFindUsages).toHaveBeenCalledWith('needle')
  })

  it('does nothing when the caret is on an empty line', async () => {
    const onFindUsages = vi.fn()
    // Position 17 sits on the blank second line, which names no word.
    const view = mount(onFindUsages, { content: 'const needle = 1\n\nmore\n' })
    await pressAltF7(view, 17)
    expect(onFindUsages).not.toHaveBeenCalled()
  })
})
