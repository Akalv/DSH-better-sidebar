/**
 * Definition lookup for the editor's Ctrl+Click / F12 gesture (P1, step 4 of
 * `docs/plans/2026-10-26-navigation-bar-design.md`).
 *
 * This is NOT a language server: there is no type checker, no project model
 * and no persistent index. It answers one question well enough for reading
 * code — "where is the declaration of this name?" — with three cheap sources,
 * merged and ranked:
 *
 *  1. the file being read (the most common answer, and the cheapest);
 *  2. files the current file imports / requires / includes (resolved through
 *     the usual relative-import rules);
 *  3. a whole-root declaration scan (ripgrep when the workspace ships one,
 *     otherwise a budgeted directory walk).
 *
 * Everything in here is pure host-side work behind a read-only route: the
 * client only sends `{ path, word, line, column }` and renders what comes back.
 * Ranking is deliberately explainable (same file > imported > same directory >
 * nearer root) so a wrong answer is diagnosable from the score breakdown.
 *
 * Budgets: at most `MAX_CANDIDATES` hits kept, at most `MAX_MATCHES_PER_FILE`
 * per file, a 5 s engine timeout, and a 4000-file / 512 KiB walker fallback.
 * Results are cached per (root, word) for 60 s, LRU-capped at 200 entries.
 */
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { SKIP_DIR_NAMES, usableEngines } from './search-engines.ts'

/** How a hit was declared, for display and for ranking. */
export type SymbolKind =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'type'
  | 'enum'
  | 'var'
  | 'module'
  | 'unknown'

/** One candidate declaration. `source` is the whole trimmed line, so the
 *  client can show it in a picker without a second read. */
export interface SymbolHit {
  path: string
  line: number
  column: number
  name: string
  kind: SymbolKind
  source: string
  score: number
}

export interface DefinitionResult {
  candidates: SymbolHit[]
  truncated: boolean
}

export interface DefinitionRequest {
  root: string
  file: string
  word: string
  line?: number
  column?: number
  limit?: number
}

/** How many hits survive `findDefinitions` (the rest are ranked away). */
const MAX_CANDIDATES = 5
/** Per-file cap inside the engine/walker scan. */
const MAX_MATCHES_PER_FILE = 8
/** `ripgrep` gets this long before the scan is abandoned (a huge monorepo
 *  must not hang the editor). */
const ENGINE_TIMEOUT_MS = 5_000
/** Walker fallback: files visited and the per-file size ceiling. */
const WALK_MAX_FILES = 4_000
/** Cache lifetime + size (the doc's `(root, word)` TTL/LRU). */
const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 200

/** Extensions the walker will read (the declaration-table keys plus a few
 *  common neighbours whose regexes fall back to GENERIC). */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.cs', '.fs', '.vb',
  '.py', '.pyi', '.rb', '.php', '.pl', '.lua', '.r',
  '.go', '.rs', '.swift', '.dart',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm',
  '.vue', '.svelte', '.astro',
  '.sh', '.bash', '.zsh', '.ps1',
])

/** Files larger than this are skipped by the walker (generated bundles). */
const WALK_SKIP_BYTES = 512 * 1024

interface Rule {
  kind: SymbolKind
  /** Source with `%W%` standing for the escaped word. */
  pattern: string
}

/** One row per language family: `%W%` is replaced by the escaped word. Order
 *  matters — the first rule that matches a line decides its kind. */
const FAMILIES: Record<string, readonly Rule[]> = {
  js: [
    { kind: 'function', pattern: '\\bfunction\\s+%W%\\b' },
    { kind: 'function', pattern: '\\b(?:const|let)\\s+%W%\\s*=\\s*(?:async\\s*)?(?:function|\\([^)]*\\)\\s*=>|%W%\\s*=>)' },
    { kind: 'class', pattern: '\\bclass\\s+%W%\\b' },
    { kind: 'interface', pattern: '\\binterface\\s+%W%\\b' },
    { kind: 'type', pattern: '\\btype\\s+%W%\\s*=' },
    { kind: 'enum', pattern: '\\benum\\s+%W%\\b' },
    { kind: 'module', pattern: '\\b(?:namespace|module)\\s+%W%\\b' },
    { kind: 'var', pattern: '\\b(?:const|let|var)\\s+%W%\\s*(?::|=)' },
    { kind: 'var', pattern: '^\\s*%W%\\s*[:=]' },
  ],
  python: [
    { kind: 'function', pattern: '^\\s*(?:async\\s+)?def\\s+%W%\\b' },
    { kind: 'class', pattern: '^\\s*class\\s+%W%\\b' },
    { kind: 'var', pattern: '^\\s*%W%\\s*(?::[^=]+)?=' },
  ],
  java: [
    { kind: 'class', pattern: '\\b(?:class|record)\\s+%W%\\b' },
    { kind: 'interface', pattern: '\\binterface\\s+%W%\\b' },
    { kind: 'enum', pattern: '\\benum\\s+%W%\\b' },
    // A Java method has no keyword: modifiers + a return type + the name + `(`.
    // The deny list is what keeps `return foo(`, `if (x)` and `new Foo(` out.
    {
      kind: 'method',
      pattern: '^\\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\\s+)*[\\w$<>\\[\\].,?\\s]+\\s+%W%\\s*\\(',
    },
  ],
  csharp: [
    { kind: 'class', pattern: '\\b(?:class|record)\\s+%W%\\b' },
    { kind: 'interface', pattern: '\\binterface\\s+%W%\\b' },
    { kind: 'enum', pattern: '\\benum\\s+%W%\\b' },
    { kind: 'type', pattern: '\\bstruct\\s+%W%\\b' },
    {
      kind: 'method',
      pattern: '^\\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial|extern|unsafe|new)\\s+)*[\\w$<>\\[\\].,?\\s]+\\s+%W%\\s*\\(',
    },
  ],
  kotlin: [
    { kind: 'function', pattern: '\\bfun\\s+%W%\\b' },
    { kind: 'class', pattern: '\\bclass\\s+%W%\\b' },
    { kind: 'interface', pattern: '\\binterface\\s+%W%\\b' },
    { kind: 'module', pattern: '\\bobject\\s+%W%\\b' },
    { kind: 'var', pattern: '\\b(?:val|var)\\s+%W%\\b' },
  ],
  scala: [
    { kind: 'function', pattern: '\\bdef\\s+%W%\\b' },
    { kind: 'class', pattern: '\\bclass\\s+%W%\\b' },
    { kind: 'module', pattern: '\\bobject\\s+%W%\\b' },
    { kind: 'interface', pattern: '\\btrait\\s+%W%\\b' },
    { kind: 'var', pattern: '\\b(?:val|var)\\s+%W%\\b' },
  ],
  c: [
    { kind: 'var', pattern: '#\\s*define\\s+%W%\\b' },
    { kind: 'type', pattern: '\\b(?:typedef\\s+)?(?:struct|union|enum)\\s+%W%\\b' },
    { kind: 'function', pattern: '^[\\w\\s*]+\\b%W%\\s*\\([^;]*$' },
  ],
  go: [
    { kind: 'function', pattern: '^\\s*func\\s+(?:\\([^)]*\\)\\s*)?%W%\\s*\\(' },
    { kind: 'type', pattern: '^\\s*type\\s+%W%\\b' },
    { kind: 'var', pattern: '^\\s*(?:var|const)\\s+%W%\\b' },
  ],
  rust: [
    { kind: 'function', pattern: '\\bfn\\s+%W%\\b' },
    { kind: 'type', pattern: '\\b(?:struct|enum|union|trait|type)\\s+%W%\\b' },
    { kind: 'module', pattern: '\\bmod\\s+%W%\\b' },
    { kind: 'var', pattern: '\\b(?:const|static)\\s+%W%\\b' },
  ],
  php: [
    { kind: 'function', pattern: '\\bfunction\\s+%W%\\b' },
    { kind: 'class', pattern: '\\bclass\\s+%W%\\b' },
    { kind: 'interface', pattern: '\\binterface\\s+%W%\\b' },
    { kind: 'type', pattern: '\\btrait\\s+%W%\\b' },
    { kind: 'var', pattern: '\\$%W%\\s*=' },
  ],
  ruby: [
    { kind: 'function', pattern: '^\\s*def\\s+(?:self\\.)?%W%\\b' },
    { kind: 'class', pattern: '^\\s*class\\s+%W%\\b' },
    { kind: 'module', pattern: '^\\s*module\\s+%W%\\b' },
  ],
  swift: [
    { kind: 'function', pattern: '\\bfunc\\s+%W%\\b' },
    { kind: 'class', pattern: '\\bclass\\s+%W%\\b' },
    { kind: 'type', pattern: '\\b(?:struct|enum|protocol|typealias)\\s+%W%\\b' },
    { kind: 'var', pattern: '\\b(?:let|var)\\s+%W%\\b' },
  ],
  dart: [
    { kind: 'class', pattern: '\\bclass\\s+%W%\\b' },
    { kind: 'enum', pattern: '\\benum\\s+%W%\\b' },
    { kind: 'function', pattern: '^\\s*(?:[\\w<>?]+\\s+)+%W%\\s*\\(' },
  ],
  lua: [
    { kind: 'function', pattern: '\\bfunction\\s+(?:[\\w.:]*[.:])?%W%\\s*\\(' },
    { kind: 'var', pattern: '^\\s*(?:local\\s+)?%W%\\s*=' },
  ],
  shell: [
    { kind: 'function', pattern: '^\\s*(?:function\\s+)?%W%\\s*\\(\\)\\s*\\{' },
    { kind: 'var', pattern: '^\\s*(?:export\\s+)?%W%=' },
  ],
}

/** Fallback for extensions without a table: a standalone token followed by a
 *  declaration-ish operator. Cheap, and only used after every other source. */
const GENERIC_RULES: readonly Rule[] = [
  { kind: 'var', pattern: '^\\s*(?:(?:export|declare|public|private|protected|internal|static|final|readonly|const|let|var|val)\\s+)*%W%\\s*(?::|=)' },
  { kind: 'unknown', pattern: '\\b%W%\\b' },
]

const EXT_FAMILY: Record<string, string> = {
  '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.mts': 'js', '.cts': 'js',
  '.vue': 'js', '.svelte': 'js', '.astro': 'js',
  '.py': 'python', '.pyi': 'python',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala', '.groovy': 'scala',
  '.cs': 'csharp', '.fs': 'csharp', '.vb': 'csharp',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c', '.hxx': 'c', '.m': 'c', '.mm': 'c',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby', '.pl': 'ruby',
  '.swift': 'swift',
  '.dart': 'dart',
  '.lua': 'lua',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'shell',
}

/** Escape a word so it can be embedded in a declaration pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rulesFor(file: string): readonly Rule[] {
  return FAMILIES[EXT_FAMILY[extname(file).toLowerCase()] ?? ''] ?? GENERIC_RULES
}

/** Compile one family's rules for a single word (exposed for tests). */
export function rulesForWord(file: string, word: string): { kind: SymbolKind; re: RegExp }[] {
  const escaped = escapeRegExp(word)
  return rulesFor(file).map(rule => ({
    kind: rule.kind,
    re: new RegExp(rule.pattern.split('%W%').join(escaped)),
  }))
}

/** The 1-based column of `word` inside `line`, or 0 when absent. */
function columnOf(line: string, word: string): number {
  const at = line.indexOf(word)
  return at === -1 ? 0 : at + 1
}

/** Does `line` declare `word` according to the file's family rules? */
export function declarationMatch(file: string, line: string, word: string): SymbolKind | null {
  const escaped = escapeRegExp(word)
  for (const rule of rulesFor(file)) {
    if (!new RegExp(rule.pattern.split('%W%').join(escaped)).test(line)) continue
    // Guard against `%W%` matching a prefix of a longer identifier.
    if (!new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(line)) continue
    // A Java/C# method rule is broad; a line that also reads like a control
    // statement or a call is not a declaration.
    if ((rule.kind === 'method') && /^\s*(?:return|if|for|while|switch|catch|new|throw|else|do|try|await)\b/.test(line)) continue
    return rule.kind
  }
  return null
}

/** Score one hit: the closer to the reader, the higher. */
function scoreHit(hit: SymbolHit, request: { root: string; file: string; dir: string; imported: ReadonlySet<string> }): number {
  let score = 0
  if (hit.path === request.file) score += 100
  else if (request.imported.has(hit.path)) score += 60
  else if (dirname(hit.path) === request.dir) score += 30
  const depth = relative(request.root, hit.path).split(/[\\/]/).length
  score -= Math.min(depth, 12)
  if (hit.kind === 'class' || hit.kind === 'interface' || hit.kind === 'function') score += 5
  if (hit.kind === 'var') score -= 5
  return score
}

/**
 * Resolve the module specifiers of one file to absolute paths that exist.
 * Only RELATIVE/relative-to-root forms are resolved (bare package names and
 * Go/Rust crate paths are not project files); a failed resolution simply
 * drops that import, it never fails the lookup.
 */
export async function resolveImports(file: string, text: string, root: string): Promise<Set<string>> {
  const dir = dirname(file)
  const ext = extname(file).toLowerCase()
  const specs = new Set<string>()
  const take = (spec: string | undefined): void => {
    if (spec !== undefined && spec !== '' && !spec.startsWith('node:')) specs.add(spec)
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'].includes(ext)) {
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) take(match[1])
    for (const match of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) take(match[1])
    for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) take(match[1])
    for (const match of text.matchAll(/(?:^|\n)\s*import\(\s*['"]([^'"]+)['"]\s*\)/g)) take(match[1])
  } else if (ext === '.py' || ext === '.pyi') {
    for (const match of text.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) take(match[1]?.replace(/\./g, '/'))
    for (const match of text.matchAll(/^\s*import\s+([\w.]+)/gm)) take(match[1]?.replace(/\./g, '/'))
  } else if (ext === '.go') {
    for (const block of text.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
      for (const match of (block[1] ?? '').matchAll(/"([^"]+)"/g)) take(match[1])
    }
    for (const match of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) take(match[1])
  } else if (['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'].includes(ext)) {
    for (const match of text.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) take(match[1])
  } else if (ext === '.php') {
    for (const match of text.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g)) take(match[1])
  } else if (ext === '.java' || ext === '.kt' || ext === '.scala' || ext === '.cs') {
    for (const match of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) take(match[1]?.replace(/\./g, '/'))
  }

  const out = new Set<string>()
  const candidates: string[] = []
  for (const spec of specs) {
    if (spec.startsWith('.')) candidates.push(resolve(dir, spec))
    else if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) candidates.push(resolve(spec))
    else if (!spec.includes('/') || spec.includes('.')) candidates.push(resolve(dir, spec))
    else candidates.push(resolve(root, spec))
  }
  for (const base of candidates) {
    for (const variant of importVariants(base)) {
      try {
        const info = await stat(variant)
        if (info.isFile()) { out.add(variant); break }
      } catch { /* try the next variant */ }
    }
  }
  return out
}

/** `./x` → `x`, `x.ts`, `x/index.ts`, … in the order TypeScript resolves. */
function importVariants(base: string): string[] {
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.php', '.rb', '.swift', '.cs', '.cpp', '.h', '.hpp', '.css', '.json']
  const variants: string[] = [base]
  for (const ext of exts) variants.push(base + ext)
  for (const ext of exts) variants.push(join(base, `index${ext}`))
  return variants
}

/** Is `path` inside `root` (the route already resolved it, this is defensive)? */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep)
}

/** One ripgrep pass over `root` for the word's declaration patterns. */
async function rgScan(root: string, file: string, word: string): Promise<SymbolHit[] | null> {
  const engines = await usableEngines()
  const rg = engines.find(engine => engine.engine === 'rg')
  if (rg === undefined) return null
  const patterns = rulesFor(file)
    .map(rule => rule.pattern.split('%W%').join(escapeRegExp(word)))
  if (patterns.length === 0) return null
  const argv = [
    '--line-number', '--column', '--no-heading', '--color', 'never',
    '--max-count', String(MAX_MATCHES_PER_FILE),
    '--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--glob', '!**/dist/**', '--glob', '!**/lib/**',
    ...patterns.flatMap(pattern => ['-e', pattern]),
    '--', '.',
  ]
  const output = await new Promise<string | null>((done) => {
    let stdout = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(rg.binary, argv, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, ENGINE_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 || code === 1 ? stdout : null))
  })
  if (output === null) return null
  const hits: SymbolHit[] = []
  for (const raw of output.split(/\r?\n/)) {
    if (raw === '') continue
    // `path:line:column:text`; the path may contain colons on Windows (C:\…),
    // so anchor on the LAST two numeric fields before the text.
    const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(raw)
    if (match === null) continue
    const [, rawPath = '', rawLine = '0', rawColumn = '0', text = ''] = match
    const path = resolve(root, rawPath.replace(/\\/g, '/'))
    if (!inside(root, path)) continue
    const kind = declarationMatch(path, text, word)
    if (kind === null) continue
    hits.push({
      path,
      line: Number(rawLine),
      column: Number(rawColumn),
      name: word,
      kind,
      source: text.trim(),
      score: 0,
    })
  }
  return hits
}

/** Budgeted directory walk used when ripgrep is unavailable. */
async function walkScan(root: string, file: string, word: string): Promise<SymbolHit[]> {
  const hits: SymbolHit[] = []
  const queue: string[] = [root]
  let visited = 0
  while (queue.length > 0 && visited < WALK_MAX_FILES) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited >= WALK_MAX_FILES) break
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.includes(entry.name)) continue
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (!SOURCE_EXTS.has(ext)) continue
      visited += 1
      let text: string
      try {
        const info = await stat(full)
        if (info.size > WALK_SKIP_BYTES) continue
        text = await readFile(full, 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      let perFile = 0
      for (let index = 0; index < lines.length && perFile < MAX_MATCHES_PER_FILE; index += 1) {
        const line = lines[index] ?? ''
        if (!line.includes(word)) continue
        const kind = declarationMatch(full, line, word)
        if (kind === null) continue
        perFile += 1
        hits.push({
          path: full,
          line: index + 1,
          column: columnOf(line, word),
          name: word,
          kind,
          source: line.trim(),
          score: 0,
        })
      }
      if (hits.length >= MAX_CANDIDATES * 20) return hits
    }
  }
  return hits
}

/** The same-file source: scan the text the caller already read. */
function fileScan(file: string, word: string, text: string): SymbolHit[] {
  const hits: SymbolHit[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.includes(word)) continue
    const kind = declarationMatch(file, line, word)
    if (kind === null) continue
    hits.push({
      path: file,
      line: index + 1,
      column: columnOf(line, word),
      name: word,
      kind,
      source: line.trim(),
      score: 0,
    })
    if (hits.length >= MAX_CANDIDATES) break
  }
  return hits
}

interface CacheEntry {
  at: number
  value: DefinitionResult
}

const cache = new Map<string, CacheEntry>()

/** Test hook: drop the memoized lookups. */
export function resetDefinitionCache(): void {
  cache.clear()
}

const WORD_SHAPE = /^[A-Za-z_$][\w$]{0,63}$/

/**
 * Find the declaration(s) of `word` as seen from `request.file`.
 *
 * @param request - root, file, word and the click position (line/column are
 *   only used for ranking ties and future precision; both are optional).
 * @returns ranked candidates, best first. An unknown word yields an empty
 *   list — never an error: "no definition found" is a normal answer.
 */
export async function findDefinitions(request: DefinitionRequest): Promise<DefinitionResult> {
  const { root, file, word } = request
  if (!WORD_SHAPE.test(word) || !inside(root, file)) {
    return { candidates: [], truncated: false }
  }
  const key = `${root}\u0000${word}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value
  }

  const text = await readFile(file, 'utf8').catch(() => '')
  const own = fileScan(file, word, text)
  const imported = text === '' ? new Set<string>() : await resolveImports(file, text, root)
  const external = (await rgScan(root, file, word)) ?? await walkScan(root, file, word)

  const context = { root, file, dir: dirname(file), imported }
  const seen = new Set<string>()
  const merged: SymbolHit[] = []
  for (const hit of [...own, ...external]) {
    const id = `${hit.path}:${hit.line}`
    if (seen.has(id)) continue
    seen.add(id)
    merged.push({ ...hit, score: scoreHit(hit, context) })
  }
  merged.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  const candidates = merged.slice(0, request.limit ?? MAX_CANDIDATES)
  const value: DefinitionResult = { candidates, truncated: merged.length > candidates.length }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), value })
  return value
}
