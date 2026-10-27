import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  definitionFromIndex,
  fileIndexOf,
  find,
  fuzzyScore,
  matchFiles,
  matchSymbols,
  outlineOf,
  readySymbols,
  resetFileIndexCache,
  symbolIndexOf,
} from '../src/file-index.ts'
import { resetEngines, setEngineHooks } from '../src/search-engines.ts'
import { setDefinitionIndexLookup, resetDefinitionCache } from '../src/symbols.ts'

let root: string

beforeEach(async () => {
  resetEngines()
  // Force the walk fallback: these tests are about the index, not about which
  // engine the machine happens to ship.
  setEngineHooks({ prober: async () => [] })
  resetFileIndexCache()
  resetDefinitionCache()
  setDefinitionIndexLookup(null)
  root = await mkdtemp(join(tmpdir(), 'dsh-index-'))
})

afterEach(async () => {
  resetEngines()
  resetFileIndexCache()
  setDefinitionIndexLookup(null)
  await rm(root, { recursive: true, force: true })
})

async function put(relativePath: string, text: string): Promise<string> {
  const full = join(root, relativePath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, text, 'utf8')
  return full
}

describe('fuzzyScore', () => {
  it('rejects non-subsequences and rewards boundaries and runs', () => {
    expect(fuzzyScore('src/client/EditorHost.tsx', 'xyz')).toBe(-1)
    expect(fuzzyScore('src/client/EditorHost.tsx', 'eh')).toBeGreaterThan(0)
    // A contiguous run beats the same characters scattered across the path.
    expect(fuzzyScore('src/EditorHost.tsx', 'editor')).toBeGreaterThan(fuzzyScore('src/e/d/i/t/o/r.ts', 'editor'))
    // A basename hit beats the same characters in a directory name.
    expect(fuzzyScore('a/b/editor.ts', 'editor')).toBeGreaterThan(fuzzyScore('a/editor/b.ts', 'editor'))
  })

  it('treats an empty needle as a match', () => {
    expect(fuzzyScore('a.ts', '')).toBe(0)
  })
})

describe('matchFiles', () => {
  const files = [
    { path: 'src/client/EditorHost.tsx', name: 'EditorHost.tsx' },
    { path: 'src/client/TextEditor.tsx', name: 'TextEditor.tsx' },
    { path: 'docs/editor.md', name: 'editor.md' },
  ]

  it('ranks a basename hit above a path hit and reports totals', () => {
    const result = matchFiles(files, 'texteditor', 10)
    expect(result.matches[0]?.path).toBe('src/client/TextEditor.tsx')
    expect(result.total).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('truncates to the limit but keeps the pre-limit total', () => {
    const result = matchFiles(files, 'editor', 1)
    expect(result.matches).toHaveLength(1)
    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
  })
})

describe('matchSymbols', () => {
  it('matches by declaration name and carries the location', () => {
    const hit = { path: 'src/a.ts', line: 7, column: 3, name: 'useNavHistory', kind: 'function' as const, source: 'export function useNavHistory() {}', score: 0 }
    const result = matchSymbols([hit], 'navHist', 10)
    expect(result.matches[0]).toMatchObject({ path: 'src/a.ts', line: 7, name: 'useNavHistory', kind: 'function' })
    expect(matchSymbols([hit], 'nope', 10).total).toBe(0)
  })
})

describe('fileIndexOf', () => {
  it('walks the tree when no engine exists and skips dependency directories', async () => {
    await put('src/a.ts', 'export const a = 1\n')
    await put('node_modules/pkg/index.ts', 'export const dep = 1\n')
    await put('.hidden/skip.ts', 'export const hidden = 1\n')
    const index = await fileIndexOf(root)
    const paths = index.files.map(file => file.path)
    expect(paths).toContain('src/a.ts')
    expect(paths.some(path => path.startsWith('node_modules/'))).toBe(false)
    expect(paths.some(path => path.startsWith('.hidden/'))).toBe(false)
    expect(index.source).toBe('walk')
  })

  it('caches per root until reset', async () => {
    await put('src/a.ts', 'x\n')
    const first = await fileIndexOf(root)
    await put('src/b.ts', 'x\n')
    const second = await fileIndexOf(root)
    expect(second).toBe(first)
    resetFileIndexCache()
    const third = await fileIndexOf(root)
    expect(third.files.map(file => file.path)).toContain('src/b.ts')
  })
})

describe('symbolIndexOf', () => {
  it('parses declarations out of the listed files', async () => {
    await put('src/a.ts', ['export interface Shape {', '  area(): number', '}', 'export function areaOf(shape: Shape) {', '  return shape.area()', '}', ''].join('\n'))
    await put('src/Shape.java', ['package x;', '', 'public class Shape {', '  private int size;', '  public int getSize() {', '    return size;', '  }', '}', ''].join('\n'))

    expect(readySymbols(root)).toBeNull()
    const index = await symbolIndexOf(root)
    const names = (index.symbols ?? []).map(hit => `${hit.name}:${hit.kind}`)
    expect(names).toContain('Shape:interface')
    expect(names).toContain('areaOf:function')
    expect(names).toContain('Shape:class')
    expect(names).toContain('getSize:method')
    // Methods never shadow the class they live in.
    const javaClass = (index.symbols ?? []).find(hit => hit.name === 'Shape' && hit.kind === 'class')
    expect(javaClass?.path).toBe('src/Shape.java')
    expect(readySymbols(root)).not.toBeNull()
  })

  it('reuses the cached table', async () => {
    await put('src/a.ts', 'export const one = 1\n')
    const first = await symbolIndexOf(root)
    const second = await symbolIndexOf(root)
    expect(second).toBe(first)
  })
})

describe('outlineOf', () => {
  it('returns declarations in source order', async () => {
    const file = await put('src/outline.ts', ['export interface A {', '  x: number', '}', 'export function b() {', '  return 1', '}', 'export class C {', '}', ''].join('\n'))
    const { symbols, truncated } = await outlineOf(file)
    expect(truncated).toBe(false)
    expect(symbols.map(hit => hit.name)).toEqual(['A', 'b', 'C'])
    expect(symbols.map(hit => hit.line)).toEqual([1, 4, 7])
  })

  it('answers an empty outline for a missing file', async () => {
    const { symbols } = await outlineOf(join(root, 'nope.ts'))
    expect(symbols).toEqual([])
  })
})

describe('find', () => {
  it('matches files by default and symbols after @', async () => {
    await put('src/client/EditorHost.tsx', 'export function EditorHost() {}\n')
    await put('src/other.ts', 'export function unrelated() {}\n')

    const files = await find(root, 'editorhost')
    expect(files.source).toBe('files')
    expect(files.matches[0]?.path).toBe('src/client/EditorHost.tsx')

    const symbols = await find(root, '@EditorHost')
    expect(symbols.source).toBe('symbols')
    expect(symbols.matches[0]).toMatchObject({ path: 'src/client/EditorHost.tsx', name: 'EditorHost', kind: 'function' })
  })
})

describe('definitionFromIndex', () => {
  it('answers from the built table and ranks same-directory hits first', async () => {
    const near = await put('src/app/main.ts', 'export function boot() {}\n')
    await put('src/app/helper.ts', 'export function boot() {}\n')
    await put('lib/boot.ts', 'export function boot() {}\n')
    await symbolIndexOf(root)

    const result = definitionFromIndex(root, near, 'boot')
    expect(result).not.toBeNull()
    expect(result?.hits.map(hit => hit.path)).toContain(join(root, 'src/app/helper.ts'))
    expect(result?.hits[0]?.path).toBe(join(root, 'src/app/main.ts'))
    expect(definitionFromIndex(root, near, 'missing')).toMatchObject({ hits: [], truncated: false })
  })

  it('returns null while the table is cold', async () => {
    const file = await put('src/a.ts', 'export function x() {}\n')
    expect(definitionFromIndex(root, file, 'x')).toBeNull()
  })
})
