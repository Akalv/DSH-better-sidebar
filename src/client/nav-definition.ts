/**
 * The editor's "navigate" gestures: Ctrl/Cmd+Click and F12 both mean "where is
 * this name declared?", Alt+Click means "show it in a split".
 *
 * The gesture layer is deliberately thin: it finds the identifier under the
 * pointer/caret and hands the host a `{ word, line, column }`. Word and symbol
 * resolution stay host-side (`/sidebar/api/symbols.definition`) and opening
 * stays with the editor host (`FileViewerProps.onOpenLocation`), so this file
 * has no opinion about files, tabs or the workspace at all.
 *
 * ⌘/Ctrl+Click is also the browser's own selection gesture on some platforms;
 * the handler claims the event only when it actually names a word, and lets
 * every other click through untouched.
 */
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

/** Where a definition gesture points. Line and column are 1-based. */
export interface DefinitionTarget {
  word: string
  line: number
  column: number
  /** Viewport coordinates of the gesture, used to anchor the result picker. */
  at: { x: number; y: number }
}

/** `default` lands in this window; `side` asks for a rightward split. */
export type DefinitionDisposition = 'default' | 'side'

/** Identifiers only: a click on punctuation or a number names nothing. */
const WORD_SHAPE = /^[A-Za-z_$][\w$]*$/

/**
 * The identifier at one document position.
 *
 * @param state - the editor state to read.
 * @param pos - a document offset (a click position or the caret).
 * @param at - where to anchor a result picker (view coordinates).
 * @returns the word with its 1-based line/column, or null when the position
 *   does not name an identifier.
 */
export function definitionTargetAt(state: EditorState, pos: number, at: { x: number; y: number } = { x: 0, y: 0 }): DefinitionTarget | null {
  const range = state.wordAt(pos)
  if (range === null) return null
  const word = state.sliceDoc(range.from, range.to)
  if (!WORD_SHAPE.test(word)) return null
  const line = state.doc.lineAt(range.from)
  return { word, line: line.number, column: range.from - line.from + 1, at }
}

/**
 * Build the gesture extension for one editor instance.
 *
 * @param onRequest - called once per accepted gesture; the caller resolves the
 *   definition and decides where it opens.
 */
export function definitionGestures(onRequest: (target: DefinitionTarget, disposition: DefinitionDisposition) => void): Extension {
  return [
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (event.button !== 0) return false
        const navigation = event.ctrlKey || event.metaKey || event.altKey
        if (!navigation) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        const target = definitionTargetAt(view.state, pos, { x: event.clientX, y: event.clientY })
        if (target === null) return false
        // Claim the press: it is a navigation, not the start of a selection.
        event.preventDefault()
        onRequest(target, event.altKey && !event.ctrlKey && !event.metaKey ? 'side' : 'default')
        return true
      },
    }),
    keymap.of([{
      key: 'F12',
      preventDefault: true,
      run: (view) => {
        const target = definitionTargetAt(view.state, view.state.selection.main.head)
        if (target === null) return false
        onRequest(target, 'default')
        return true
      },
    }]),
  ]
}
