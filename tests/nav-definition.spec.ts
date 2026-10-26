/**
 * The definition GESTURES: what Ctrl/Cmd+Click, Alt+Click and F12 mean, and
 * which of them the editor claims.
 *
 * The word under a click is resolved host-side, so what matters here is only
 * the hand-off: which offset the pointer names, what line/column that offset
 * maps to, and that a modified click on prose (or on punctuation) is left to
 * the browser so it can still start a selection.
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { definitionGestures, definitionTargetAt, type DefinitionDisposition, type DefinitionTarget } from '../src/client/nav-definition.ts'

const DOC = 'alpha.beta(gamma)\nnext one\n'

const stateOf = (doc: string = DOC): EditorState => EditorState.create({ doc })

const at = (pos: number, state: EditorState = stateOf()): DefinitionTarget | null => definitionTargetAt(state, pos)

describe('definitionTargetAt', () => {
  it('names the identifier under the offset with 1-based line and column', () => {
    expect(at(0)).toEqual({ word: 'alpha', line: 1, column: 1, at: { x: 0, y: 0 } })
    // "alpha." is 6 chars, so offset 6 is the "b" of beta (column 7).
    expect(at(6)).toEqual({ word: 'beta', line: 1, column: 7, at: { x: 0, y: 0 } })
    // "alpha.beta(" is 11 chars, so offset 11 is the "g" of gamma (column 12).
    expect(at(11)).toEqual({ word: 'gamma', line: 1, column: 12, at: { x: 0, y: 0 } })
    // Second line: "next" starts at 18 (16 chars + the line break).
    expect(at(18)).toEqual({ word: 'next', line: 2, column: 1, at: { x: 0, y: 0 } })
  })

  it('names nothing in whitespace or at a line break', () => {
    // wordAt is lenient at a word's edges (the dot after alpha still reads as
    // alpha), so a non-word position has to be real whitespace.
    expect(at(17)).toBeNull() // the newline between the lines
    expect(at(27)).toBeNull() // the trailing newline
  })

  it('carries the anchor through untouched', () => {
    expect(at(0, stateOf())?.at).toEqual({ x: 0, y: 0 })
    const anchored = definitionTargetAt(stateOf(), 0, { x: 40, y: 12 })
    expect(anchored?.at).toEqual({ x: 40, y: 12 })
  })

  it('agrees with wordAt about the word boundaries', () => {
    const state = stateOf('const camelCase = camelCaseOf(x)')
    const first = state.wordAt(6)
    expect(first).not.toBeNull()
    expect(definitionTargetAt(state, 6)?.word).toBe('camelCase')
    // A suffix must never be mistaken for the prefix: "camelCaseOf" is its own word.
    expect(definitionTargetAt(state, 27)?.word).toBe('camelCaseOf')
  })
})

describe('definitionGestures', () => {
  let view: EditorView | undefined
  const requested: Array<{ target: DefinitionTarget; disposition: DefinitionDisposition }> = []

  const onRequest = (target: DefinitionTarget, disposition: DefinitionDisposition): void => {
    requested.push({ target, disposition })
  }

  const mount = (): EditorView => {
    const element = document.createElement('div')
    document.body.append(element)
    view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [definitionGestures(onRequest)] }),
      parent: element,
    })
    return view
  }

  const click = (init: MouseEventInit, view: EditorView): boolean => {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init })
    view.contentDOM.dispatchEvent(event)
    return event.defaultPrevented
  }

  const key = (name: string, view: EditorView): boolean => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(event)
    return event.defaultPrevented
  }

  beforeEach(() => {
    requested.length = 0
    // jsdom lays nothing out, so pointer positions are mapped to offsets by hand.
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(0)
  })

  afterEach(() => {
    view?.destroy()
    view = undefined
    vi.restoreAllMocks()
  })

  it('claims Ctrl+Click on an identifier and asks for the default window', () => {
    const editor = mount()
    expect(click({ ctrlKey: true, clientX: 3, clientY: 4 }, editor)).toBe(true)
    expect(requested).toHaveLength(1)
    expect(requested[0]?.target.word).toBe('alpha')
    expect(requested[0]?.target.at).toEqual({ x: 3, y: 4 })
    expect(requested[0]?.disposition).toBe('default')
  })

  it('treats Alt+Click as a request for the side split', () => {
    const editor = mount()
    expect(click({ altKey: true }, editor)).toBe(true)
    expect(requested[0]?.disposition).toBe('side')
  })

  it('lets a plain click through so it can still start a selection', () => {
    const editor = mount()
    click({}, editor)
    // CodeMirror handles the press itself; the point is that no navigation ran.
    expect(requested).toHaveLength(0)
  })

  it('claims nothing when the pointer is not on an identifier', () => {
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(17) // the line break
    const editor = mount()
    click({ ctrlKey: true }, editor)
    expect(requested).toHaveLength(0)
  })

  it('claims nothing for a right or middle press', () => {
    const editor = mount()
    click({ button: 2, ctrlKey: true }, editor)
    click({ button: 1, ctrlKey: true }, editor)
    expect(requested).toHaveLength(0)
  })

  it('runs F12 on the identifier under the caret', () => {
    const editor = mount()
    editor.dispatch({ selection: { anchor: 18 } })
    key('F12', editor)
    expect(requested).toHaveLength(1)
    expect(requested[0]?.target.word).toBe('next')
    expect(requested[0]?.target.line).toBe(2)
  })

  it('leaves F12 alone when the caret is not on a word', () => {
    const editor = mount()
    editor.dispatch({ selection: { anchor: 17 } })
    key('F12', editor)
    expect(requested).toHaveLength(0)
  })
})
