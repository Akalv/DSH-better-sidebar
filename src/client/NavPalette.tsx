/**
 * The palette behind Ctrl+P (files, and `@` for declarations), Ctrl+Alt+O
 * (the open document's outline) and Alt+F7 (where a name is used).
 *
 * One overlay, three sources: the only differences are what fills the row list
 * and what Enter does with a row. Everything the user types goes to
 * `nav.find` for files (the host owns the fuzzy ranking so the whole project
 * path list never crosses the wire), while the outline and the usage list are
 * fetched once per open and filtered locally — one document, or one name, is
 * small enough.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type NavMatch, type OutlineSymbol, type UsageMatch } from './api.ts'
import type { SessionScope } from './api.ts'
import { t } from './locales.ts'
import { baseName, relativeTo } from './paths.ts'
import css from './sidebar.module.css'

/** How long a keystroke waits before the palette asks the host. */
const QUERY_DEBOUNCE_MS = 80
const RESULT_LIMIT = 60
/** A usage list is for reading: a couple of hundred call sites is plenty. */
const USAGE_LIMIT = 200

export type PaletteMode = 'files' | 'outline' | 'usages'

export interface PaletteLocation {
  path: string
  line?: number
  column?: number
}

interface Row {
  key: string
  label: string
  detail: string
  kind?: string
  location: PaletteLocation
  symbol: boolean
}

export interface NavPaletteProps {
  mode: PaletteMode
  scope: SessionScope
  /** The document whose outline is shown (outline mode only). */
  path?: string
  /** The name whose call sites are listed (usages mode only). */
  word?: string
  onClose: () => void
  onOpenFile: (location: PaletteLocation) => void
  /** Alt+Enter (or a modifier click) opens in a split instead of in place. */
  onOpenFileSide?: (location: PaletteLocation) => void
}

/** Root-relative palette paths to something the editor can open. */
function absoluteOf(cwd: string | undefined, path: string): string {
  if (cwd === undefined || cwd === '' || /^(?:[A-Za-z]:[\\/]|\/)/.test(path)) return path
  const separator = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${separator}${separator === '\\' ? path.split('/').join('\\') : path}`
}

function fileRow(cwd: string | undefined, match: NavMatch): Row {
  const absolute = absoluteOf(cwd, match.path)
  const at = match.line ?? undefined
  return {
    key: `${absolute}:${match.line ?? 0}:${match.name ?? ''}`,
    label: match.name ?? baseName(match.path),
    detail: match.name !== undefined && at !== undefined ? `${match.path}:${at}` : match.path,
    kind: match.kind,
    location: { path: absolute, line: at, column: match.column },
    symbol: match.name !== undefined,
  }
}

function outlineRow(cwd: string | undefined, path: string, symbol: OutlineSymbol): Row {
  const absolute = absoluteOf(cwd, path)
  return {
    key: `${absolute}:${symbol.line}:${symbol.name}`,
    label: symbol.name,
    detail: `${symbol.line}`,
    kind: symbol.kind,
    location: { path: absolute, line: symbol.line, column: symbol.column },
    symbol: true,
  }
}

/** The outline filters locally: cheap, and it keeps the input responsive. */
function filterOutline(rows: Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row => row.label.toLowerCase().includes(needle) || row.kind?.toLowerCase().includes(needle) === true)
}

function usageRow(cwd: string | undefined, match: UsageMatch): Row {
  const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(match.path) ? match.path : absoluteOf(cwd, match.path)
  return {
    key: `${absolute}:${match.line}:${match.column}`,
    label: match.text === '' ? baseName(match.path) : match.text,
    detail: `${cwd === undefined ? match.path : relativeTo(cwd, absolute)}:${match.line}`,
    location: { path: absolute, line: match.line, column: match.column },
    symbol: false,
  }
}

/** A usage list is filtered locally too: it arrives in one fetch. */
function filterUsages(rows: Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row => row.label.toLowerCase().includes(needle) || row.detail.toLowerCase().includes(needle))
}

export function NavPalette(props: NavPaletteProps): React.ReactElement | null {
  const { mode, scope, path, word, onClose, onOpenFile, onOpenFileSide } = props
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [symbols, setSymbols] = useState<OutlineSymbol[]>([])
  const [usages, setUsages] = useState<UsageMatch[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const cwd = scope.cwd

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Outline: one fetch per open, then local filtering.
  useEffect(() => {
    if (mode !== 'outline' || path === undefined) return
    const controller = new AbortController()
    setLoading(true)
    api.symbolsOutline(scope, { path }, controller.signal)
      .then(result => {
        setSymbols(result.symbols)
        setTruncated(result.truncated)
        setFailed(false)
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setFailed(true)
        setLoading(false)
      })
    return () => controller.abort()
    // `scope` is recreated per render; identity-stable fields are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path, scope.sessionId, scope.cwd])

  // Usages: one fetch per open (Alt+F7), then local filtering.
  useEffect(() => {
    if (mode !== 'usages' || path === undefined || word === undefined) return
    const controller = new AbortController()
    setLoading(true)
    api.symbolsUsages(scope, { path, word, limit: USAGE_LIMIT }, controller.signal)
      .then(result => {
        setUsages(result.matches)
        setTruncated(result.truncated)
        setFailed(false)
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setFailed(true)
        setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path, word, scope.sessionId, scope.cwd])

  // Files: debounced host query (the host ranks the whole project list).
  useEffect(() => {
    if (mode !== 'files') return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      api.navFind(scope, { query, limit: RESULT_LIMIT }, controller.signal)
        .then(result => {
          setRows(result.matches.map(match => fileRow(cwd, match)))
          setTruncated(result.truncated)
          setActive(0)
          setFailed(false)
          setLoading(false)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setFailed(true)
          setLoading(false)
        })
    }, QUERY_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, scope.sessionId, scope.cwd])

  const visible = useMemo(() => {
    if (mode === 'outline') return filterOutline(symbols.map(symbol => outlineRow(cwd, path ?? '', symbol)), query)
    if (mode === 'usages') return filterUsages(usages.map(usage => usageRow(cwd, usage)), query)
    return rows
  }, [mode, rows, symbols, usages, query, cwd, path])

  const pick = useCallback((row: Row | undefined, side: boolean): void => {
    if (row === undefined) return
    const open = side ? onOpenFileSide ?? onOpenFile : onOpenFile
    open(row.location)
    onClose()
  }, [onOpenFile, onOpenFileSide, onClose])

  useEffect(() => {
    if (active >= visible.length) setActive(visible.length === 0 ? 0 : visible.length - 1)
  }, [visible.length, active])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    // jsdom (and older webviews) may not implement scrolling.
    if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (visible.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive(current => (current + delta + visible.length) % visible.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      pick(visible[active], event.altKey)
    }
  }

  const title = mode === 'outline' ? t('navOutline') : mode === 'usages' ? `${t('navUsages')} · ${word ?? ''}` : t('navQuickOpen')
  const placeholder = mode === 'outline'
    ? t('navOutlinePlaceholder')
    : mode === 'usages'
      ? t('navUsagesHint')
      : t('navQuickOpenHint')
  const empty = loading
    ? t('navSearching')
    : mode === 'outline'
      ? t('navOutlineEmpty')
      : mode === 'usages'
        ? t('navUsagesEmpty')
        : t('navNoMatches')

  return createPortal(
    <div className={css.paletteBackdrop} data-mode={mode}>
      <div className={css.palette} role="dialog" aria-label={title}>
        <input
          ref={inputRef}
          className={css.paletteInput}
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={title}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {truncated && <div className={css.paletteNote}>{t('navTruncated')}</div>}
        <div className={css.paletteList} role="listbox" ref={listRef}>
          {visible.length === 0 && (
            <div className={css.paletteEmpty} role="status">{failed ? t('navSearchFailed') : empty}</div>
          )}
          {visible.map((row, index) => (
            <button
              key={row.key}
              type="button"
              role="option"
              data-index={index}
              aria-selected={index === active}
              className={index === active ? `${css.paletteRow} ${css.paletteRowActive}` : css.paletteRow}
              onMouseEnter={() => setActive(index)}
              onClick={event => pick(row, event.altKey)}
            >
              <span className={css.paletteLabel}>{row.label}</span>
              {row.kind !== undefined && <span className={css.paletteKind}>{row.kind}</span>}
              <span className={css.paletteDetail}>{row.detail}</span>
            </button>
          ))}
        </div>
        <div className={css.paletteFooter}>{t('navPickHint')}</div>
      </div>
    </div>,
    document.body,
  )
}
