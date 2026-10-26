/**
 * Unit tests for the editor breadcrumb trail (src/client/Breadcrumbs.tsx).
 *
 * The trail is pure display logic over `relativeTo`, and the cases that matter
 * are the ones the sidebar already has to live with: a file inside the session
 * cwd, a file OUTSIDE it (still breadcrumbed, anchored at the drive or root),
 * and a window with no path at all.
 */
import { describe, expect, it } from 'vitest'
import { breadcrumbTrail } from '../src/client/Breadcrumbs.tsx'

describe('breadcrumbTrail', () => {
  it('splits a cwd-relative path into directory crumbs plus the file', () => {
    expect(breadcrumbTrail('/w', '/w/src/client/App.tsx')).toEqual([
      { label: 'src', path: '/w/src', dir: true },
      { label: 'client', path: '/w/src/client', dir: true },
      { label: 'App.tsx', path: '/w/src/client/App.tsx', dir: false },
    ])
  })

  it('anchors an absolute path outside the cwd at the filesystem root', () => {
    expect(breadcrumbTrail('/w', '/elsewhere/lib/x.ts')).toEqual([
      { label: 'elsewhere', path: '/elsewhere', dir: true },
      { label: 'lib', path: '/elsewhere/lib', dir: true },
      { label: 'x.ts', path: '/elsewhere/lib/x.ts', dir: false },
    ])
  })

  it('keeps a Windows drive as the anchor and normalizes separators', () => {
    expect(breadcrumbTrail('C:\\w', 'C:\\w\\src\\a.ts')).toEqual([
      { label: 'src', path: 'C:/w/src', dir: true },
      { label: 'a.ts', path: 'C:/w/src/a.ts', dir: false },
    ])
  })

  it('renders a single file crumb when the file sits in the cwd itself', () => {
    expect(breadcrumbTrail('/w', '/w/a.ts')).toEqual([
      { label: 'a.ts', path: '/w/a.ts', dir: false },
    ])
  })

  it('returns nothing for a path-less window', () => {
    expect(breadcrumbTrail('/w', '')).toEqual([])
  })
})
