/**
 * The plugin's structural read of the HOST's browser terminal service
 * (`ctx.webTerminals`, provided by `@deepseek-ai/dsh-api-terminal-controller`'s
 * client half on the web profile).
 *
 * The plugin does NOT own a PTY stack any more (v0.21.1 yielded the terminal to
 * DSH's own right-Sidebar type): the bottom workbench's terminal drives the
 * host's session-scoped terminals through this service, and the host keeps
 * process lifetime, screen recovery and reconnection.
 *
 * Detection is STRUCTURAL and by name only — the plugin never imports the host
 * package (the client-bundle purity gate forbids `@deepseek-ai/*` value
 * imports outside the platform module table), and `webTerminals` is
 * deliberately NOT in `package.json#dsh.client.inject`: a deployment without
 * the service must still activate the plugin (a missing injected service leaves
 * the whole row `pending`), so the terminal tab degrades instead.
 *
 * The shapes mirror the pinned host package (`dsh-api-terminal-controller`
 * 0.2.0-rc.1, `lib/types/client/{index,model}.d.ts` + `lib/types/types.d.ts`):
 *
 * - `view(sessionId, key, contentId, terminalId?, shellPath?)` returns the
 *   STABLE model for one occurrence (`key` memoizes it; repeating a call is
 *   free) and allocates the terminal eagerly on first call. `contentId` is the
 *   persistence key: the service remembers `(sessionId, contentId) -> host
 *   terminal id` in `localStorage`, so passing the same `contentId` after a
 *   page reload ADOPTS the saved process instead of allocating a new one —
 *   unless an explicit `terminalId` is given, which wins.
 * - `mount()` attaches the DOM lifetime and returns a DETACH callback; the
 *   process survives unmount (only `close()` ends it).
 * - `state.render` is the next screen frame awaiting
 *   {@link HostTerminalView.acknowledge}; the service will not publish the
 *   following frame until it is acknowledged, so the emulator's write callback
 *   is what releases the stream.
 * - `write` / `resize` are refused unless the view is currently `writable`
 *   (the host serializes input across windows per attachment).
 */
import type { Context } from '../context-types.ts'

/** A host terminal identity, unique per Session and host lifetime. */
export type WebTerminalId = string

/** Host-owned terminal state; process exit never creates a replacement shell. */
export interface HostTerminalInfo {
  readonly id: WebTerminalId
  readonly title: string
  /** Initial working directory; a shell's own `cd` does not update it. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
}

/** Working directory and limits shared by new and restored terminals. */
export interface HostTerminalEnvironment {
  readonly cwd: string
  readonly maxInputBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}

/**
 * Every attachment begins with a complete bounded screen (the host serializes
 * the emulator's screen), then ordered output; `state` frames only carry
 * metadata. This is why the view REPLAYS `screen` rather than appending it.
 */
export type HostTerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: HostTerminalInfo }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: HostTerminalInfo }

/** Product error identifiers the host terminals UI translates. */
export type HostTerminalIssue = 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit'

/**
 * The two frame kinds that carry screen content. The host's render slot is
 * `Extract<TerminalFrame, { type: 'snapshot' | 'output' }>`: a `state` frame is
 * metadata only and never reaches the emulator.
 */
export type HostRenderFrame = Extract<HostTerminalFrame, { type: 'snapshot' | 'output' }>

/** Observable state of one occurrence. */
export interface HostTerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly environment?: HostTerminalEnvironment | undefined
  readonly title?: string | undefined
  readonly info?: HostTerminalInfo | undefined
  /** Whether this view currently holds input/resize control. */
  readonly writable: boolean
  /** The next screen frame awaiting {@link HostTerminalView.acknowledge}. */
  readonly render?: { readonly revision: number; readonly frame: HostRenderFrame } | undefined
  readonly error?: string | undefined
  readonly issue?: HostTerminalIssue | undefined
}

/** The host's observable snapshot store face (a subset of `SnapshotStore`). */
export interface HostSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One terminal occurrence's model. A view survives DOM unmount. */
export interface HostTerminalView {
  readonly id: WebTerminalId
  readonly state: HostSnapshot<HostTerminalViewState>
  /** Attach the DOM lifetime; the returned detach leaves the process alive. */
  mount(): () => void
  /** Start or recover this tab (deduplicated by the service). */
  refresh(): Promise<void>
  /** Reattach with a fresh screen and regain input control. */
  connect(): void
  /** Release the next stream item after the emulator parsed this frame. */
  acknowledge(revision: number): void
  /** Serialize raw input (refused unless writable). */
  write(data: string): void
  /** Resize only from the currently writable view. */
  resize(cols: number, rows: number): void
  /** Terminate the process; the DOM lifetime is irrelevant to it. */
  close(): Promise<void>
}

/**
 * One shell the host verified in this Session's execution environment
 * (`Shell` in the pinned controller): `path` is already PATH-resolved, `args`
 * is the host's own profile for that kind (`[]` for cmd, `['-NoLogo']` for
 * PowerShell).
 */
export interface HostShell {
  readonly path: string
  readonly name: string
  readonly args: readonly string[]
}

/** Installed shells plus the one the host would start for a new terminal. */
export interface HostShellLaunch {
  readonly shells: readonly HostShell[]
  readonly selectedShell?: string | undefined
}

/** The service slice this plugin consumes. */
export interface WebTerminalsFace {
  view(
    sessionId: string,
    key: string,
    contentId: string,
    terminalId?: WebTerminalId,
    shellPath?: string,
  ): HostTerminalView
  /**
   * Save a close intent, release the occurrence immediately and drop the
   * `(sessionId, contentId)` binding; the process cleanup outlives DOM
   * unmount and a page reload (the plugin's tab `onClose`).
   */
  close(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId): void
  /** Query host terminals without a live view or unfinished close. */
  recover(sessionId: string): Promise<HostTerminalInfo[]>
  /**
   * Installed shells together with the one the host would start for a NEW
   * terminal.
   *
   * OPTIONAL on purpose: the member is newer than view(), and a deployment
   * without it must keep opening terminals — the shell preference simply does
   * not apply — instead of degrading the whole tab.
   */
  launchShells?(sessionId: string, signal?: AbortSignal): Promise<HostShellLaunch>
}

/**
 * The host terminal service, when this deployment mounts it.
 *
 * Structural detection (`view` + `close` + `recover` are the members this
 * plugin calls); a service that does not look like the pinned contract reads
 * as absent rather than throwing at the first keystroke.
 * @param ctx - the client context.
 */
export function webTerminals(ctx: Context): WebTerminalsFace | undefined {
  const service = ctx.get('webTerminals') as unknown as Partial<WebTerminalsFace> | undefined
  if (service === undefined || service === null) return undefined
  if (typeof service.view !== 'function' || typeof service.close !== 'function') return undefined
  if (typeof service.recover !== 'function') return undefined
  return service as WebTerminalsFace
}

/**
 * The shell kind of a path, read the way the host reads it: the executable
 * name, lowercased, one trailing .exe dropped — so cmd.exe, CMD and
 * C:\WINDOWS\system32\cmd.exe all read as cmd.
 * @param path - an absolute shell path.
 */
export function shellKindOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name.toLowerCase().replace(/\.exe$/u, '')
}

/** The shell names this plugin prefers over the host's Windows default. */
const PREFERRED_SHELLS = ['pwsh'] as const

/**
 * The shell path a NEW terminal should launch, or undefined meaning "no
 * opinion — keep the host's own default".
 *
 * A stock Windows install makes the host start cmd.exe:
 * dsh-subprocess-local reports ComSpec as the execution environment's default
 * shell, and the controller resolves a shell from it. Where the host would do
 * exactly that AND the environment also offers a preferred shell, the plugin
 * asks for the preferred one instead. Keying on the HOST's own selection is
 * what keeps this honest — a POSIX $SHELL, a login shell, or a
 * profile-configured shell is never overridden — and undefined leaves the
 * host resolving its default, which is the cmd fallback when pwsh is absent.
 *
 * The returned path is one the host just DISCOVERED, never a guess: the host
 * refuses a shell path it did not discover ("Selected shell is not available
 * in this execution environment"), while "no path" merely means the host
 * decides.
 * @param launch - the host's shell discovery result.
 */
export function preferredShellPath(launch: HostShellLaunch): string | undefined {
  const selected = launch.selectedShell ?? launch.shells[0]?.path
  if (selected === undefined) return undefined
  // Any other default (bash, zsh, a configured shell) is already the user's
  // intent, and PowerShell is not what it asks for.
  if (shellKindOf(selected) !== 'cmd') return undefined
  for (const kind of PREFERRED_SHELLS) {
    const shell = launch.shells.find(candidate => shellKindOf(candidate.path) === kind)
    if (shell !== undefined) return shell.path
  }
  return undefined
}

/** A launch-shell lookup for one Session, settled or still in flight. */
export interface ShellResolution {
  /** Resolves to the shell path, or undefined to keep the host's default. */
  readonly promise: Promise<string | undefined>
  /** Whether {@link ShellResolution.path} is already known. */
  readonly settled: boolean
  /** The resolved path; undefined means the host keeps its own choice. */
  readonly path: string | undefined
}

/** The mutable side of a resolution (settled in place, read as a snapshot). */
interface PendingShellResolution {
  promise: Promise<string | undefined>
  settled: boolean
  path: string | undefined
}

/** Upper bound on remembered lookups: a Session id is cheap, but not free. */
const MAX_SHELL_RESOLUTIONS = 32

/**
 * One lookup per service and Session. The bottom workbench mounts one view per
 * tab and re-renders it constantly, so the discovery must not run per render;
 * the service is the WeakMap key, so a replaced service can never read a stale
 * answer.
 */
const shellResolutions = new WeakMap<object, Map<string, PendingShellResolution>>()

/**
 * The launch-shell preference for one Session, discovering it on first use.
 *
 * A failed round trip resolves to undefined (the host's default) instead of
 * rejecting: a terminal that cannot be improved is still a terminal that has to
 * open.
 * @param service - the host terminal service.
 * @param sessionId - the Session whose execution environment is asked.
 * @returns the lookup, or undefined when this host exposes no discovery.
 */
export function launchShellResolution(
  service: WebTerminalsFace,
  sessionId: string,
): ShellResolution | undefined {
  const launch = service.launchShells
  if (typeof launch !== 'function') return undefined
  let perSession = shellResolutions.get(service)
  if (perSession === undefined) {
    perSession = new Map<string, PendingShellResolution>()
    shellResolutions.set(service, perSession)
  }
  const cached = perSession.get(sessionId)
  if (cached !== undefined) return cached
  // The snapshot object is mutated by the promise, so a synchronous read after
  // the insert (the next tab's initial state) sees the same answer.
  const entry: PendingShellResolution = { promise: Promise.resolve(undefined), settled: false, path: undefined }
  // bind(), not a bare reference: the host method reads its own this.remote.
  const discover = launch.bind(service)
  entry.promise = discover(sessionId).then(
    result => preferredShellPath(result),
    () => undefined,
  ).then((path) => {
    entry.path = path
    entry.settled = true
    return path
  })
  // Eviction keeps the map bounded; a still-pending entry is awaited by a
  // mounted view, so only a settled one is dropped.
  if (perSession.size >= MAX_SHELL_RESOLUTIONS) {
    for (const [key, value] of perSession) {
      if (value.settled) {
        perSession.delete(key)
        break
      }
    }
  }
  perSession.set(sessionId, entry)
  return entry
}

/** Namespace for the plugin's own occurrence key and content identity. */
const TERMINAL_NS = 'dsh-better-sidebar:terminal-bottom'

/** The persisted `tab.meta` field identifying ONE terminal tab instance. */
export const INSTANCE_FIELD = 'terminalInstance'

/** The persisted `tab.meta` field holding the content-identity generation. */
const RUN_FIELD = 'terminalRun'

/**
 * The content identity of the bottom terminal at `run`.
 *
 * The host keys its recovery binding on `(sessionId, contentId)`, so a stable
 * value is what makes a page reload adopt the SAME host terminal instead of
 * allocating a new one. A "new terminal" (the run bump) deliberately changes
 * it: the old binding points at a process that is gone — a host restart, or a
 * terminal closed elsewhere — and reusing it would wedge the tab on
 * `missingTerminal` forever.
 *
 * The SAME value is the occurrence key the host memoizes one view by
 * (`view(sessionId, key, contentId)`), so a run bump has to move both: the
 * namespace is what keeps it from colliding with a host layout tab id (`tab1`).
 *
 * The bottom workbench hosts SEVERAL terminals (#774 follow-up), so each tab
 * carries its own `instance`, spliced in before the run suffix: two tabs never
 * share an id and therefore never share a shell. A tab WITHOUT an instance —
 * one persisted before the follow-up — keeps the byte-identical legacy
 * identity, so its host binding still reattaches.
 * @param run - the content-identity generation (0 for a tab's first terminal).
 * @param instance - the tab's own instance id (`undefined` on legacy tabs).
 */
export function bottomTerminalContentId(run: number, instance?: string): string {
  const base = instance === undefined || instance === '' ? TERMINAL_NS : `${TERMINAL_NS}:${instance}`
  return run === 0 ? base : `${base}#${run}`
}

/** The per-tab instance id a tab carries (absent/legacy tabs read as `undefined`). */
export function terminalInstanceOf(tab: { meta?: unknown }): string | undefined {
  const meta = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
  const instance = meta[INSTANCE_FIELD]
  return typeof instance === 'string' && instance !== '' ? instance : undefined
}

/** The content-identity generation a tab carries (absent/corrupt reads as 0). */
export function terminalRunOf(tab: { meta?: unknown }): number {
  const meta = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
  const run = meta[RUN_FIELD]
  return typeof run === 'number' && Number.isSafeInteger(run) && run >= 0 ? run : 0
}

/**
 * The `tab.meta` patch that mints the tab's next terminal.
 *
 * The instance has to survive the bump: `patchTab` REPLACES `meta` wholesale,
 * so returning only the run field would drop `terminalInstance` and collapse
 * the tab onto the legacy identity — where every tab that bumped its run lands
 * on the same key (`…terminal-bottom#1`) and the host, which memoizes one view
 * per `(sessionId, key)`, would hand two tabs the SAME shell. Legacy tabs carry
 * no instance and get none here, so their identity stays byte-identical.
 */
export function nextTerminalMeta(tab: { meta?: unknown }): Record<string, unknown> {
  const instance = terminalInstanceOf(tab)
  const run = { [RUN_FIELD]: terminalRunOf(tab) + 1 }
  return instance === undefined ? run : { [INSTANCE_FIELD]: instance, ...run }
}

/**
 * End the tab's host terminal (the descriptor's `onClose`). Unmounting the
 * view deliberately does NOT do this — that is the host's "a view survives DOM
 * unmount" contract, and it is what lets a reload reattach — so without this
 * every closed bottom terminal would leave its shell running invisibly.
 * @param ctx - the client context.
 * @param tab - the closing tab (its `meta` names the content identity).
 * @param sessionId - the tab's session.
 */
export function closeBottomTerminal(ctx: Context, tab: { meta?: unknown }, sessionId: string): void {
  const service = webTerminals(ctx)
  if (service === undefined) return
  const id = bottomTerminalContentId(terminalRunOf(tab), terminalInstanceOf(tab))
  service.close(sessionId, id, id)
}
