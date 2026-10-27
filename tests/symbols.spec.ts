import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  declarationMatch,
  findDefinitions,
  resetDefinitionCache,
  resolveImports,
  rulesForWord,
} from '../src/symbols.ts'

let root: string

beforeEach(async () => {
  resetDefinitionCache()
  root = await mkdtemp(join(tmpdir(), 'dsh-symbols-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(relativePath: string, text: string): Promise<string> {
  const full = join(root, relativePath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, text, 'utf8')
  return full
}

describe('declarationMatch', () => {
  it('recognises TypeScript declarations and ignores usages', () => {
    expect(declarationMatch('a.ts', 'export function greet(name: string) {', 'greet')).toBe('function')
    expect(declarationMatch('a.ts', 'export class Greeter {', 'Greeter')).toBe('class')
    expect(declarationMatch('a.ts', 'export interface Greeter {', 'Greeter')).toBe('interface')
    expect(declarationMatch('a.ts', '  const greet = (name: string) => name', 'greet')).toBe('function')
    expect(declarationMatch('a.ts', '  greet("world")', 'greet')).toBeNull()
    // A longer identifier must not satisfy a shorter word.
    expect(declarationMatch('a.ts', 'function greeter() {}', 'greet')).toBeNull()
  })

  it('recognises Java methods without a method keyword, and keeps calls out', () => {
    expect(declarationMatch('A.java', '    public static String greet(String name) {', 'greet')).toBe('method')
    expect(declarationMatch('A.java', '    private List<String> fetchAll() {', 'fetchAll')).toBe('method')
    expect(declarationMatch('A.java', '    return greet(name);', 'greet')).toBeNull()
    expect(declarationMatch('A.java', '    if (greet(name)) {', 'greet')).toBeNull()
    expect(declarationMatch('A.java', '    new Greeter();', 'Greeter')).toBeNull()
  })

  it('recognises Python, Go and C declarations', () => {
    expect(declarationMatch('a.py', 'class Parser:', 'Parser')).toBe('class')
    expect(declarationMatch('a.py', '    def parse(self):', 'parse')).toBe('function')
    expect(declarationMatch('main.go', 'func Parse(input string) (*Node, error) {', 'Parse')).toBe('function')
    expect(declarationMatch('a.h', '#define MAX_DEPTH 12', 'MAX_DEPTH')).toBe('var')
  })

  it('falls back to a generic rule for unknown extensions', () => {
    expect(declarationMatch('a.weird', 'const thing = 1', 'thing')).toBe('var')
  })

  it('compiles a rule per family for one word', () => {
    expect(rulesForWord('a.java', 'greet').length).toBeGreaterThan(0)
    expect(rulesForWord('a.java', 'greet')[0]?.kind).toBe('class')
  })
})

describe('resolveImports', () => {
  it('resolves relative specifiers with the extension-free and index forms', async () => {
    const a = await put('src/a.ts', "import { greet } from './b'\nimport { other } from './dir'\nimport x from 'lodash'\n")
    await put('src/b.ts', 'export function greet() {}\n')
    await put('src/dir/index.ts', 'export const other = 1\n')
    const found = await resolveImports(a, "import { greet } from './b'\nimport { other } from './dir'\n", root)
    expect([...found].sort()).toEqual([join(root, 'src', 'b.ts'), join(root, 'src', 'dir', 'index.ts')].sort())
  })

  it('maps Python dotted imports onto files and ignores missing modules', async () => {
    const a = await put('pkg/a.py', 'from pkg.helpers import thing\nimport pkg.missing\n')
    await put('pkg/helpers.py', 'def thing(): pass\n')
    const found = await resolveImports(a, 'from pkg.helpers import thing\n', root)
    expect(found.has(join(root, 'pkg', 'helpers.py'))).toBe(true)
  })
})

describe('findDefinitions', () => {
  it('prefers the current file, then an imported file, then a same-directory file', async () => {
    const file = await put('src/a.ts', [
      'export function greet() { return 1 }',
      "import { helper } from './b'",
      'helper()',
    ].join('\n'))
    await put('src/b.ts', 'export function helper() { return 2 }\n')
    await put('src/c.ts', 'export function local() { return 3 }\n')

    const helper = await findDefinitions({ root, file, word: 'helper' })
    expect(helper.candidates[0]?.path).toBe(join(root, 'src', 'b.ts'))

    const greet = await findDefinitions({ root, file, word: 'greet' })
    expect(greet.candidates[0]?.path).toBe(file)
    expect(greet.candidates[0]?.line).toBe(1)
    expect(greet.candidates[0]?.column).toBe(17)

    const local = await findDefinitions({ root, file, word: 'local' })
    expect(local.candidates[0]?.path).toBe(join(root, 'src', 'c.ts'))
  })

  it('finds a declaration several directories away through the walker', async () => {
    const file = await put('app/main.ts', "import { deep } from '../lib/util'\ndeep()\n")
    await put('lib/util.ts', '\nexport const deep = () => 1\n')
    const result = await findDefinitions({ root, file, word: 'deep' })
    expect(result.candidates.map(hit => hit.path)).toContain(join(root, 'lib', 'util.ts'))
  })

  // The staged lookup stops at the first stage that answers: a name declared
  // right here must not drag in a same-named declaration from a distant
  // directory (that sweep is what made every jump cost a whole-tree scan).
  it('answers from the open file without sweeping the tree', async () => {
    const file = await put('src/only.ts', 'export function greet() { return 1 }\n')
    await put('deep/nested/greet.ts', 'export function greet() { return 2 }\n')
    const result = await findDefinitions({ root, file, word: 'greet' })
    expect(result.candidates.map(hit => hit.path)).toEqual([file])
    expect(result.truncated).toBe(false)
  })

  it('answers from an imported module before touching the rest of the tree', async () => {
    const file = await put('src/app.ts', "import { helper } from './modules/b'\nhelper()\n")
    await put('src/modules/b.ts', 'export function helper() { return 2 }\n')
    // Same-directory decoy: it is not imported, so the import stage wins.
    await put('src/decoy.ts', 'export function helper() { return 3 }\n')
    const result = await findDefinitions({ root, file, word: 'helper' })
    expect(result.candidates.map(hit => hit.path)).toEqual([join(root, 'src', 'modules', 'b.ts')])
  })

  it('returns no candidates for an unknown word — absence is not an error', async () => {
    const file = await put('src/a.ts', 'export const x = 1\n')
    const result = await findDefinitions({ root, file, word: 'missingThing' })
    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('refuses malformed words and paths outside the root', async () => {
    const file = await put('src/a.ts', 'export const x = 1\n')
    expect((await findDefinitions({ root, file, word: 'a.b(' })).candidates).toEqual([])
    expect((await findDefinitions({ root, file: join(root, '..', 'escape.ts'), word: 'x' })).candidates).toEqual([])
  })

  it('caps the candidate list and reports truncation', async () => {
    const file = await put('src/a.ts', 'export const x = 1\n')
    for (let index = 0; index < 8; index += 1) {
      await put(`src/f${index}.ts`, `export const target = ${index}\n`)
    }
    const result = await findDefinitions({ root, file, word: 'target', limit: 3 })
    expect(result.candidates).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('memoizes a lookup until the cache is reset', async () => {
    const file = await put('src/a.ts', 'export const x = 1\ntarget()\n')
    await put('src/b.ts', 'export function target() {}\n')
    const first = await findDefinitions({ root, file, word: 'target' })
    await put('src/c.ts', 'export function target() { return 2 }\n')
    const second = await findDefinitions({ root, file, word: 'target' })
    expect(second).toBe(first)
    resetDefinitionCache()
    const third = await findDefinitions({ root, file, word: 'target' })
    expect(third).not.toBe(first)
  })
})
