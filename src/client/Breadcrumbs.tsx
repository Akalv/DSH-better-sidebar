/**
 * The editor header's breadcrumb strip: the open file's path as a row of
 * clickable directory segments plus the file name (IDEA's editor breadcrumb
 * bar / VS Code's breadcrumb row).
 *
 * It is display + one gesture only: clicking a directory segment asks the host
 * to REVEAL that directory in the file tree (`onOpenDir`). The host owns the
 * expansion state, so this component never touches the store — which also
 * keeps it renderable in isolation for tests.
 *
 * Paths outside the session cwd still breadcrumb: the trail then starts at the
 * filesystem anchor (`/` or `C:`), so an absolute open never renders as one
 * giant un-clickable label.
 */
import { Fragment } from 'react'
import clsx from 'clsx'
import css from './sidebar.module.css'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'

export interface Crumb {
  /** Segment text as shown. */
  label: string
  /** Absolute directory path this segment stands for. */
  path: string
  /** False only for the file segment (the last one). */
  dir: boolean
}

/** Split `path` into breadcrumb segments, relative to `cwd` when possible. */
export function breadcrumbTrail(cwd: string | undefined, path: string): Crumb[] {
  if (path === '') return []
  const normalized = path.replace(/\\/g, '/')
  const relative = cwd === undefined || cwd === '' ? path : relativeTo(cwd, path)
  const inside = relative !== path || path === (cwd ?? '').replace(/\\/g, '/')
  const segments = (inside ? relative : normalized).split('/').filter(segment => segment !== '')
  if (segments.length === 0) return []
  const root = inside ? (cwd ?? '').replace(/\\/g, '/') : (/^[a-zA-Z]:\//.test(normalized) ? normalized.slice(0, 2) : '')
  const trail: Crumb[] = []
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) continue
    current = current === '' ? `/${segment}` : current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`
    trail.push({ label: segment, path: current, dir: index < segments.length - 1 })
  }
  return trail
}

export interface BreadcrumbsProps {
  cwd: string | undefined
  path: string
  /** Reveal a directory in the file tree (the host supplies expansion). */
  onOpenDir?: (dir: string) => void
}

/** The crumb row; renders nothing for a path-less (home) window. */
export function Breadcrumbs(props: BreadcrumbsProps) {
  const trail = breadcrumbTrail(props.cwd, props.path)
  if (trail.length === 0) return null
  return (
    <nav className={css.editorCrumbs} aria-label={t('editorBreadcrumbs')} title={props.path}>
      {trail.map((crumb, index) => (
        <Fragment key={crumb.path}>
          {index > 0 && <span className={css.editorCrumbSep} aria-hidden="true">/</span>}
          {crumb.dir && props.onOpenDir !== undefined
            ? (
                <button
                  type="button"
                  className={css.editorCrumb}
                  title={crumb.path}
                  onClick={() => { props.onOpenDir?.(crumb.path) }}
                >
                  {crumb.label}
                </button>
              )
            : (
                <span
                  className={clsx(css.editorCrumb, !crumb.dir && css.editorCrumbFile)}
                  aria-current={crumb.dir ? undefined : 'page'}
                >
                  {crumb.label}
                </span>
              )}
        </Fragment>
      ))}
    </nav>
  )
}
