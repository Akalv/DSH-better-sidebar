/**
 * The workspace indexes the navigation surfaces read from: the file list that
 * backs quick open (Ctrl+P) and the declaration table that backs go-to-symbol
 * (Ctrl+Alt+O) and the final stage of go-to-definition.
 *
 * Both are lazy and per root, and both are built ONCE per TTL window rather
 * than per keystroke — that is the whole point. Before this index existed,
 * every definition that was not in the open file, its imports or its own
 * directory had to sweep the tree with ripgrep (measured: 3.5 s on a workspace
 * with 5.3k source files). A listing built once turns the same question into
 * an in-memory filter.
 *
 * The file list prefers ripgrep's `--files` (which honours `.gitignore`, so
 * build output and dependency trees never enter the palette) and falls back to
 * the same budgeted walk the rest of the plugin uses when no engine is
 * available. The declaration table is parsed from the listed files with the
 * shared language tables in `symbols.ts`, under a hard time budget: a caller
 * would rather see part of a huge repository's symbols now than all of them
 * after a second.
 *
 * Everything here is read-only host work. The routes are thin wrappers.
 */
import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { SKIP_DIR_NAMES, usableEngines } from './search-engines.ts'
import { declarationsIn, isSourceFile, PRUNE_GLOBS, sourceGlob, type SymbolHit, type SymbolKind } from './symbols.ts'

/** The file list is reused for this long; a stale palette entry is cheap to
 *  fix (the open fails), a palette built on every keystroke is not. */
const INDEX_TTL_MS = 120_000
/** Upper bound on indexed files (the doc's 50k cap). */
const INDEX_LIMIT = 50_000
/** Same per-file ceiling the walker uses: generated bundles declare nothing
 *  a reader wants and cost the most to parse. */
const PARSE_MAX_BYTES = 512 * 1024
/** Declaration parsing stops at this budget; the palette says `truncated`. */
const PARSE_BUDGET_MS = 8_000
const SYMBOL_LIMIT = 50_000
/** `rg --files` on a monorepo must not hang the route. */
const LIST_TIMEOUT_MS = 15_000
/** Kept roots, LRU. */
const ROOT_CACHE_LIMIT = 4

export interface FileRecord {
  /** Root-relative, '/'-separated — the same contract `fs-search` uses. */
  path: string
  name: string
}

export interface RootIndex {
  root: string
  files: readonly FileRecord[]
  /** `null` until something asks for symbols; the file list is far cheaper. */
  symbols: readonly SymbolHit[] | null
  truncated: boolean
  symbolsTruncated: boolean
  builtAt: number
  source: 'rg' | 'walk'
}

export interface FileMatch {
  path: string
  score: number
  /** Present for symbol matches only. */
  line?: number
  column?: number
  name?: string
  kind?: SymbolKind
}

export interface FindResult {
  matches: FileMatch[]
  total: number
  truncated: boolean
}

const roots = new Map<string, RootIndex>()

/** Test seam. */
export function resetFileIndexCache(): void {
  roots.clear()
}

function isFresh(entry: RootIndex | undefined, root: string, at: number): boolean {
  return entry !== undefined && entry.root === root && at - entry.builtAt < INDEX_TTL_MS
}

function remember(entry: RootIndex): RootIndex {
  roots.delete(entry.root)
  roots.set(entry.root, entry)
  while (roots.size > ROOT_CACHE_LIMIT) {
    const oldest = roots.keys().next().value
    if (oldest === undefined) break
    roots.delete(oldest)
  }
  return entry
}

/** Run one listing command, capturing stdout up to a hard byte cap. */
function runList(binary: string, argv: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let out = ''
    let settled = false
    let child: ReturnType<typeof spawn> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolvePromise(value)
    }
    try {
      child = spawn(binary, [...argv], { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish(null)
      return
    }
    timer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish(null)
    }, LIST_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
      if (out.length > INDEX_LIMIT * 128) {
        child?.kill('SIGKILL')
        finish(out)
      }
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
  })
}

/** The escalation path: a budgeted breadth-first walk, same skip list as the
 *  rest of the plugin. Used only when no engine is available. */
async function walkFiles(root: string): Promise<{ files: FileRecord[]; truncated: boolean }> {
  const files: FileRecord[] = []
  const queue: string[] = [root]
  let truncated = false
  while (queue.length > 0) {
    const dir = queue.shift() as string
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.includes(entry.name)) continue
        queue.push(full)
      } else if (entry.isFile()) {
        if (files.length >= INDEX_LIMIT) {
          truncated = true
          break
        }
        files.push({ path: relative(root, full).split('\\').join('/'), name: entry.name })
      }
    }
    if (truncated) break
  }
  return { files, truncated }
}

/** The per-root file list (cached). */
export async function fileIndexOf(root: string, at = Date.now()): Promise<RootIndex> {
  const cached = roots.get(root)
  if (isFresh(cached, root, at)) return cached as RootIndex
  const probes = await usableEngines()
  const rg = probes.find(probe => probe.engine === 'rg')
  if (rg !== undefined) {
    const argv = [
      '--files', '--hidden', '--path-separator', '/',
      '--iglob', '!.git/**',
      ...SKIP_DIR_NAMES.flatMap(name => ['--iglob', `!**/${name}/**`]),
      '.',
    ]
    const out = await runList(rg.binary, argv, root)
    if (out !== null) {
      const files: FileRecord[] = []
      let truncated = false
      for (const line of out.split(/\r?\n/)) {
        const path = line.trim()
        if (path === '' || path.startsWith('.git/')) continue
        if (files.length >= INDEX_LIMIT) {
          truncated = true
          break
        }
        files.push({ path, name: basename(path) })
      }
      return remember({ root, files, symbols: null, truncated, symbolsTruncated: false, builtAt: at, source: 'rg' })
    }
  }
  const walked = await walkFiles(root)
  return remember({ root, files: walked.files, symbols: null, truncated: walked.truncated, symbolsTruncated: false, builtAt: at, source: 'walk' })
}

/**
 * The declaration table (cached with the file list it was built from). Parsing
 * is time-budgeted: a very large root yields a partial table flagged
 * `symbolsTruncated`, never a route that blocks for seconds on every call.
 *
 * Reads run through a small pool — a serial pass over a few thousand files is
 * disk-latency bound, and a single file's parse is cheap next to its read.
 */
const PARSE_CONCURRENCY = 8

export async function symbolIndexOf(root: string, at = Date.now()): Promise<RootIndex> {
  const index = await fileIndexOf(root, at)
  if (index.symbols !== null) return index
  const symbols: SymbolHit[] = []
  let truncated = false
  const started = Date.now()
  const deadline = started + PARSE_BUDGET_MS
  const queue = index.files.filter(file => isSourceFile(file.path))
  let cursor = 0

  const parseOne = async (file: FileRecord): Promise<SymbolHit[]> => {
    const full = join(root, file.path)
    try {
      const text = await readFile(full, 'utf8')
      if (text.length > PARSE_MAX_BYTES) return []
      return declarationsIn(full, text).map(hit => ({ ...hit, path: file.path }))
    } catch {
      // A file that vanished mid-index simply contributes nothing.
      return []
    }
  }

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      if (symbols.length >= SYMBOL_LIMIT || Date.now() > deadline) {
        truncated = true
        return
      }
      const file = queue[cursor]
      cursor += 1
      if (file === undefined) return
      const hits = await parseOne(file)
      for (const hit of hits) {
        if (symbols.length >= SYMBOL_LIMIT) {
          truncated = true
          break
        }
        symbols.push(hit)
      }
    }
  }

  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker))
  return remember({ ...index, symbols, symbolsTruncated: truncated || index.truncated, builtAt: at })
}

/** The declaration table when it is ALREADY built, else null. Definition
 *  lookup uses this so a cold jump never pays for a full parse. */
export function readySymbols(root: string): readonly SymbolHit[] | null {
  const cached = roots.get(root)
  if (cached === undefined || cached.symbols === null) return null
  if (Date.now() - cached.builtAt >= INDEX_TTL_MS) return null
  return cached.symbols
}

/** Declarations of one document — the outline, with no project index at all. */
export async function outlineOf(file: string): Promise<{ symbols: SymbolHit[]; truncated: boolean }> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return { symbols: [], truncated: false }
    if (info.size > PARSE_MAX_BYTES) return { symbols: [], truncated: true }
    const text = await readFile(file, 'utf8')
    return { symbols: declarationsIn(file, text), truncated: false }
  } catch {
    return { symbols: [], truncated: false }
  }
}

/**
 * Fuzzy subsequence score: -1 when `needle` is not a subsequence of
 * `candidate`, otherwise a positive score. Boundaries and runs win; long
 * gaps lose; a basename hit beats the same characters buried in directories.
 */
export function fuzzyScore(candidate: string, needle: string): number {
  if (needle === '') return 0
  const hay = candidate.toLowerCase()
  const pin = needle.toLowerCase()
  let score = 0
  let at = 0
  let run = 0
  let last = -2
  for (let i = 0; i < hay.length && at < pin.length; i += 1) {
    if (hay[i] !== pin[at]) continue
    const boundary = i === 0 || hay[i - 1] === '/' || hay[i - 1] === '-' || hay[i - 1] === '_' || hay[i - 1] === '.'
    if (i === last + 1) {
      run += 1
      score += 4 + Math.min(run, 6)
    } else {
      run = 0
      score += 2
      score -= Math.min(i - last - 1, 24) * 0.2
    }
    if (boundary) score += 6
    last = i
    at += 1
  }
  if (at < pin.length) return -1
  const name = hay.slice(hay.lastIndexOf('/') + 1)
  if (name.startsWith(pin)) score += 20
  if (name === pin) score += 40
  score -= Math.min(hay.length / 80, 6)
  return score
}

/** Rank the file list for a palette query; `total` is the pre-limit count. */
export function matchFiles(files: readonly FileRecord[], query: string, limit: number): FindResult {
  const needle = query.trim()
  const scored: FileMatch[] = []
  for (const file of files) {
    const score = fuzzyScore(file.path, needle)
    if (score < 0) continue
    scored.push({ path: file.path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { matches: scored.slice(0, limit), total: scored.length, truncated: scored.length > limit }
}

/** Rank declarations by name for the go-to-symbol palette. */
export function matchSymbols(symbols: readonly SymbolHit[], query: string, limit: number): FindResult {
  const needle = query.trim()
  const scored: FileMatch[] = []
  for (const hit of symbols) {
    const score = fuzzyScore(hit.name, needle)
    if (score < 0) continue
    scored.push({ path: hit.path, score, line: hit.line, column: hit.column, name: hit.name, kind: hit.kind })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
  return { matches: scored.slice(0, limit), total: scored.length, truncated: scored.length > limit }
}

/**
 * `nav.find`: the query normally matches paths; a leading `@` switches to the
 * declaration table (go to symbol), which is the one palette shortcut worth
 * memorising. Building the declaration table is deferred until then.
 */
export async function find(root: string, query: string, limit = 50): Promise<FindResult & { source: 'files' | 'symbols' }> {
  const needle = query.trim()
  if (needle.startsWith('@')) {
    const index = await symbolIndexOf(root)
    return { ...matchSymbols(index.symbols ?? [], needle.slice(1), limit), source: 'symbols' }
  }
  const index = await fileIndexOf(root)
  return { ...matchFiles(index.files, needle, limit), source: 'files' }
}

/** Definition answer from an already-built table, or null to keep sweeping. */
export function definitionFromIndex(root: string, file: string, word: string): { hits: SymbolHit[]; truncated: boolean } | null {
  const symbols = readySymbols(root)
  if (symbols === null) return null
  const hits: SymbolHit[] = []
  for (const hit of symbols) {
    if (hit.name !== word) continue
    const full = join(root, hit.path)
    let score = hit.score + (hit.kind === 'class' || hit.kind === 'interface' || hit.kind === 'function' ? 5 : 0)
    if (full === file) score += 100
    else if (dirnameOf(full) === dirnameOf(file)) score += 30
    score -= Math.min(relative(root, full).split(/[\\/]/).length, 12)
    hits.push({ ...hit, path: full, score })
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { hits: hits.slice(0, 5), truncated: hits.length > 5 }
}

function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? path : path.slice(0, cut)
}

/** One row of a find-usages answer. `text` is the trimmed source line. */
export interface UsageMatch {
  path: string
  line: number
  column: number
  text: string
}

export interface UsageResult {
  matches: UsageMatch[]
  truncated: boolean
}

/** Usages are capped harder than definitions: the list is for reading, not
 *  for rewriting, so the first screenful of call sites is the useful part. */
const USAGE_LIMIT = 80
const USAGE_FILE_LIMIT = 3_000
const USAGE_TEXT_MAX = 200
const USAGE_PER_FILE = 12

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function usageText(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > USAGE_TEXT_MAX ? `${trimmed.slice(0, USAGE_TEXT_MAX)}…` : trimmed
}

/** Rank call sites the way a reader looks for them: this file, its directory,
 *  then the rest of the tree; ties go to the shallower path. */
function rankUsages(matches: UsageMatch[], root: string, file: string): UsageMatch[] {
  const dir = dirnameOf(file)
  const score = (match: UsageMatch): number => {
    if (match.path === file) return 3
    if (dirnameOf(match.path) === dir) return 2
    return 1
  }
  return [...matches].sort((a, b) => {
    const delta = score(b) - score(a)
    if (delta !== 0) return delta
    const depth = relative(root, a.path).split(/[\\/]/).length - relative(root, b.path).split(/[\\/]/).length
    if (depth !== 0) return depth
    return a.path.localeCompare(b.path) || a.line - b.line
  })
}

/** ripgrep is the fast path: whole-word search over the same source-only
 *  universe the index parses. */
async function rgUsages(root: string, file: string, word: string, limit: number): Promise<UsageResult | null> {
  const probes = await usableEngines()
  const rg = probes.find(probe => probe.engine === 'rg')
  if (rg === undefined) return null
  const argv = [
    '--line-number', '--column', '--no-heading', '--color', 'never',
    '--max-count', String(USAGE_PER_FILE), '--max-filesize', '512K', '--no-messages',
    '--word-regexp', '--glob', sourceGlob(), ...PRUNE_GLOBS,
    '-e', escapeRegExp(word), '--', '.',
  ]
  const output = await runList(rg.binary, argv, root)
  if (output === null) return null
  const matches: UsageMatch[] = []
  for (const raw of output.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const parsed = /^(.*?):(\d+):(\d+):(.*)$/.exec(raw)
    if (parsed === null) continue
    const path = parsed[1] ?? ''
    if (path === '') continue
    matches.push({
      path: join(root, path.split('/').join(sepOf(root))),
      line: Number.parseInt(parsed[2] ?? '0', 10),
      column: Number.parseInt(parsed[3] ?? '0', 10),
      text: usageText(parsed[4] ?? ''),
    })
  }
  return { matches: rankUsages(matches, root, file).slice(0, limit), truncated: matches.length > limit }
}

function sepOf(root: string): string {
  return root.includes('\\') ? '\\' : '/'
}

/** The no-engine path: read the indexed source files and count whole-word
 *  hits. Slower than rg, but bounded by the same index and file ceiling. */
async function scanUsages(root: string, file: string, word: string, limit: number): Promise<UsageResult> {
  const index = await fileIndexOf(root)
  const matcher = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g')
  const queue = index.files.filter(entry => isSourceFile(entry.path)).slice(0, USAGE_FILE_LIMIT)
  const matches: UsageMatch[] = []
  let truncated = index.truncated || queue.length < index.files.length
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const entry = queue[cursor]
      cursor += 1
      if (entry === undefined) return
      if (matches.length >= limit * 2) {
        truncated = true
        return
      }
      const full = join(root, entry.path)
      let text: string
      try {
        text = await readFile(full, 'utf8')
      } catch {
        continue
      }
      if (text.length > PARSE_MAX_BYTES) continue
      const lines = text.split('\n')
      let perFile = 0
      for (let at = 0; at < lines.length; at += 1) {
        const line = lines[at] ?? ''
        matcher.lastIndex = 0
        let found: RegExpExecArray | null
        while ((found = matcher.exec(line)) !== null) {
          if (perFile >= USAGE_PER_FILE) break
          perFile += 1
          matches.push({ path: full, line: at + 1, column: found.index + 1, text: usageText(line) })
        }
        if (perFile >= USAGE_PER_FILE) break
      }
    }
  }

  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker))
  return { matches: rankUsages(matches, root, file).slice(0, limit), truncated: truncated || matches.length > limit }
}

/**
 * `symbols.usages`: every whole-word occurrence of `word`, ranked by distance
 * from the file that asked. rg first, the index walk second; either way the
 * answer is capped so a name used in a thousand places cannot flood the panel.
 */
export async function usagesOf(root: string, file: string, word: string, limit = USAGE_LIMIT): Promise<UsageResult> {
  const bounded = Math.min(Math.max(limit, 1), 200)
  if (!/^[A-Za-z_$][\w$]{0,63}$/.test(word)) return { matches: [], truncated: false }
  if (!file.startsWith(root)) return { matches: [], truncated: false }
  const fromEngine = await rgUsages(root, file, word, bounded)
  if (fromEngine !== null) return fromEngine
  return await scanUsages(root, file, word, bounded)
}
