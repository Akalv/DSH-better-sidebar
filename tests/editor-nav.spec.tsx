/**
 * The editor header's navigation surface (P1 of the navigation-bar design):
 * the [<][>] history buttons and the breadcrumb trail.
 *
 * These render in the REAL EditorHost (not the viewer), because that is what
 * decides a navigation happened: the host records the location it settles on
 * and replays entries for the arrows. jsdom keeps this cheap and the harness
 * below is the one tests/editor-line-nav-mode.spec.tsx already uses.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarStore, type SidebarTab } from '../src/client/state.ts'
import { navHistoryFor, resetNavHistoryCache } from '../src/client/nav-history.ts'

setupReactAct()

const fsRead = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsRead: (...args: unknown[]) => fsRead(...args),
    mediaUrl: () => '',
  },
}))

const SESSION = 'nav-bar-session'
const BODY = '# title\n\nfirst\n\nsecond\n'

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

interface Harness {
  ctx: Context
  store: SidebarStore
  tabOf: (path: string) => SidebarTab
}

function harness(): Harness {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'markdown',
    exts: ['md'],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: TextEditor,
  })
  store.setSession(SESSION)
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [SESSION]: { cwd: '/tmp' } } }) } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  return {
    ctx,
    store,
    tabOf: (path): SidebarTab => {
      ctx.betterSidebar.openTab({ type: 'editor', title: path.split('/').pop()!, path, id: `editor:${path}` })
      return allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(item => item.path === path)!
    },
  }
}

function mount(ctx: Context, tab: SidebarTab, store: SidebarStore): ReturnType<typeof renderRoot> {
  return renderRoot(createElement(EditorHost, {
    ctx,
    store,
    scope: { sessionId: SESSION, cwd: '/tmp' },
    tab,
    visible: true,
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  }))
}

function navButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[class*="editorNavButtons"] button'))
}

function click(button: HTMLButtonElement): void {
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** The tab the store holds under `id` (the host retargets an in-place window). */
function storedTab(store: SidebarStore, id: string): SidebarTab {
  return allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    .find(tab => tab.id === id)!
}

beforeEach(() => {
  localStorage.clear()
  resetNavHistoryCache()
  fsRead.mockReset()
  fsRead.mockResolvedValue({ kind: 'text', content: BODY, truncated: false })
})

describe('the header history arrows', () => {
  it('renders both arrows, disabled while the history has nothing to replay', async () => {
    const { ctx, store, tabOf } = harness()
    const view = mount(ctx, tabOf('/tmp/a.md'), store)
    try {
      await settle()
      const buttons = navButtons(view.container)
      expect(buttons).toHaveLength(2)
      // The first navigation (this file) is the only entry: nothing before it.
      expect(buttons[0]!.disabled).toBe(true)
      expect(buttons[1]!.disabled).toBe(true)
      expect(buttons[0]!.getAttribute('aria-label')).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('replays the previous location into this window when the mode is in-place', async () => {
    const { ctx, store, tabOf } = harness()
    store.setPrefs({ ...store.getSnapshot().prefs, editorExplorer: true })
    // A location visited before this window opened.
    navHistoryFor(SESSION).record({ path: '/tmp/prev.md' })
    const tab = tabOf('/tmp/a.md')
    const view = mount(ctx, tab, store)
    try {
      await settle()
      const back = navButtons(view.container)[0]!
      expect(back.disabled).toBe(false)
      click(back)
      await settle()
      expect(storedTab(store, tab.id).path).toBe('/tmp/prev.md')
      // The forward stack survives the replay (the re-record is swallowed).
      expect(navButtons(view.container)[1]!.disabled).toBe(false)
    } finally {
      view.unmount()
    }
  })
})

describe('the breadcrumb trail', () => {
  it('splits a file path into clickable directory crumbs plus the file', async () => {
    const { ctx, store, tabOf } = harness()
    const view = mount(ctx, tabOf('/tmp/src/a.md'), store)
    try {
      await settle()
      // The container is `editorCrumbs` (plural) — select the leaf nodes only.
      const crumbs = Array.from(view.container.querySelectorAll<HTMLElement>(
        'button[class*="editorCrumb"], span[class*="editorCrumbFile"]',
      ))
      expect(crumbs.map(node => node.textContent)).toEqual(['src', 'a.md'])
      // Only the directories are buttons; the file is the current location.
      expect(crumbs[0]!.tagName).toBe('BUTTON')
      expect(crumbs[1]!.tagName).toBe('SPAN')
    } finally {
      view.unmount()
    }
  })

  it('reveals the directory in the tree without switching the file', async () => {
    const { ctx, store, tabOf } = harness()
    const view = mount(ctx, tabOf('/tmp/src/a.md'), store)
    try {
      await settle()
      const dir = view.container.querySelector<HTMLButtonElement>('button[class*="editorCrumb"]')!
      click(dir)
      await settle()
      const state = store.getSnapshot().state!
      expect(state.expanded).toContain('/tmp/src')
      expect(storedTab(store, `editor:/tmp/src/a.md`).path).toBe('/tmp/src/a.md')
    } finally {
      view.unmount()
    }
  })
})
