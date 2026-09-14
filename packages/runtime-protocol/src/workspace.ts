/**
 * Identifier of the runtime implementation that owns a workspace.
 * `docker` is the only implementation today; `ssh` is reserved for the
 * planned remote runtime so metadata written now stays forward compatible.
 */
export type RuntimeKind = 'docker' | 'ssh';

/**
 * Lifecycle state of a workspace as observed by the runtime.
 *
 * ```text
 * creating ─▶ created ─▶ running ◀─▶ stopped ─▶ removed
 *                 │                        ▲
 *                 └────────────────────────┘ (created ─▶ removed)
 * missing: metadata exists but the backing container/host is gone
 * ```
 */
export type WorkspaceStatus =
  | 'creating'
  | 'created'
  | 'running'
  | 'stopped'
  | 'removed'
  | 'missing';

/** How the source repository is transferred into the workspace. */
export type RepositoryImportMode = 'git-bundle' | 'tar';

/**
 * Durable description of a workspace. Persisted by the runtime *outside* of
 * the source checkout so that a runtime process can reconnect to a retained
 * container after a restart.
 */
export interface WorkspaceMetadata {
  /** Normalized, filesystem- and Docker-safe workspace identifier. */
  workspaceId: string;
  /** Runtime that owns this workspace. */
  runtime: RuntimeKind;
  /** Backing container id (Docker). `null` until the container is created. */
  containerId: string | null;
  /** Deterministic container name derived from the workspace id. */
  containerName: string;
  /** Docker image the container was created from. */
  image: string;
  /** Absolute path of the repository checkout inside the container. */
  repositoryPath: string;
  /** Branch checked out inside the container after import. */
  branch: string;
  /** Host path the repository was imported from (informational only). */
  sourcePath: string | null;
  /** Import strategy used when the workspace was created. */
  importMode: RepositoryImportMode | null;
  /** Last lifecycle state persisted by the runtime. */
  status: WorkspaceStatus;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Free-form labels supplied at creation time. */
  labels: Record<string, string>;
}

/** Live view of a workspace: persisted metadata plus the observed status. */
export interface Workspace {
  id: string;
  metadata: WorkspaceMetadata;
  status: WorkspaceStatus;
}

export interface CreateWorkspaceOptions {
  /**
   * Requested workspace id. It is normalized (lower-cased, unsafe characters
   * replaced) before use; the normalized value is returned in the metadata.
   */
  workspaceId: string;
  /**
   * Host directory to import. When it is a Git repository the runtime imports
   * it as a Git bundle by default; otherwise the directory is imported as a
   * tar archive. The host path is only ever read.
   */
  sourcePath?: string;
  /** Force a specific import strategy. Defaults to `auto`. */
  importMode?: RepositoryImportMode | 'auto';
  /** Image used for the workspace container. Runtime default applies when omitted. */
  image?: string;
  /** Absolute container path of the repository checkout. Default: `/workspace/repo`. */
  repositoryPath?: string;
  /** Branch created/checked out inside the container. Default: `t3/<workspaceId>`. */
  branch?: string;
  /**
   * When `true` (default) and a retained container already exists for the
   * workspace, that container is reused instead of failing.
   */
  reuseExisting?: boolean;
  /** Start the container immediately after creation. Default: `true`. */
  start?: boolean;
  /** Additional metadata labels. */
  labels?: Record<string, string>;
}

export interface ExecOptions {
  /** Working directory inside the workspace, relative to the repository root, or absolute container path. */
  cwd?: string;
  /** Environment variables passed to the process. Values are never logged. */
  env?: Record<string, string>;
  /** Data written to the process stdin before it is closed. */
  input?: Buffer | string;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Abort signal that kills the process when triggered. */
  signal?: AbortSignal;
  /** Run as this user inside the container. */
  user?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  /** Set when the process was terminated by a signal instead of exiting. */
  signal: string | null;
  /** `true` when the process was killed because `timeoutMs` elapsed. */
  timedOut: boolean;
  durationMs: number;
}

export interface PtyOptions {
  /** Program to run. Defaults to the runtime's default shell. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  user?: string;
}

export interface PtyExit {
  exitCode: number | null;
  signal: string | null;
}

export interface PtyHandle {
  /** Runtime-specific identifier (Docker exec id). */
  readonly id: string;
  readonly pid: number | null;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): Promise<void>;
  onData(listener: (chunk: Buffer) => void): () => void;
  onExit(listener: (exit: PtyExit) => void): () => void;
  /** Resolves once the PTY process has exited. */
  readonly exited: Promise<PtyExit>;
  /** Terminate the PTY process and release the underlying transport. */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export type FileEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  /** Entry name (last path segment). */
  name: string;
  /** Workspace-relative POSIX path. */
  path: string;
  kind: FileEntryKind;
  size: number;
  /** Modification time in milliseconds since the epoch. */
  mtimeMs: number;
}

export interface SearchQuery {
  /** Text or regular expression to search for. */
  pattern: string;
  /** Treat `pattern` as a fixed string instead of a regular expression. Default: `false`. */
  fixedString?: boolean;
  caseSensitive?: boolean;
  /** Workspace-relative directory to search. Defaults to the repository root. */
  path?: string;
  /** Maximum number of matches to return. Default: 1000. */
  maxResults?: number;
  /** Include hidden files and `.git`. Default: `false`. */
  includeHidden?: boolean;
}

export interface SearchResult {
  /** Workspace-relative POSIX path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Content of the matching line. */
  text: string;
}

export type FileChangeType = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChangeEvent {
  type: FileChangeType;
  /** Workspace-relative POSIX path. */
  path: string;
  /** Previous path for `rename` events when the watcher can detect it. */
  previousPath?: string;
  kind: FileEntryKind;
  timestamp: number;
}

export type FileChangeListener = (events: FileChangeEvent[]) => void;

export interface WatchHandle {
  readonly id: string;
  /** Watched workspace-relative path. */
  readonly path: string;
  /** Watching strategy actually used (`polling` for the first Docker implementation). */
  readonly strategy: 'polling' | 'inotify';
  /** Stop the watcher and release any processes. Idempotent. */
  close(): Promise<void>;
  /** Fires once when the watcher stops, with the error that stopped it if any. */
  onClose(listener: (error: Error | null) => void): () => void;
}
