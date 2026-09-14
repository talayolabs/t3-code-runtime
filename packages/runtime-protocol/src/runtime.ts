import type { AcquireAgentLockOptions, AgentLockHandle, AgentLockStatus } from './agent-lock.js';
import type {
  CreateWorkspaceOptions,
  ExecOptions,
  ExecResult,
  FileChangeListener,
  FileEntry,
  PtyHandle,
  PtyOptions,
  SearchQuery,
  SearchResult,
  WatchHandle,
  Workspace,
} from './workspace.js';

/**
 * Runtime-agnostic contract between T3 Code and a workspace backend.
 *
 * Every operation takes a `workspaceId` and is executed *inside* the
 * workspace (a Docker container today, an SSH host later). Paths are always
 * workspace-relative POSIX paths resolved against the repository root; the
 * host filesystem is never touched.
 */
export interface WorkspaceRuntime {
  readonly kind: 'docker' | 'ssh';

  createWorkspace(options: CreateWorkspaceOptions): Promise<Workspace>;
  getWorkspace(workspaceId: string): Promise<Workspace>;
  listWorkspaces(): Promise<Workspace[]>;
  startWorkspace(workspaceId: string): Promise<void>;
  stopWorkspace(workspaceId: string): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<void>;

  exec(workspaceId: string, command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>;
  spawnPty(workspaceId: string, options?: PtyOptions): Promise<PtyHandle>;

  readFile(workspaceId: string, path: string): Promise<Buffer>;
  writeFile(workspaceId: string, path: string, data: Buffer | string): Promise<void>;
  listDirectory(workspaceId: string, path: string): Promise<FileEntry[]>;
  stat(workspaceId: string, path: string): Promise<FileEntry>;
  search(workspaceId: string, query: SearchQuery): Promise<SearchResult[]>;
  git(workspaceId: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  watch(workspaceId: string, path: string, listener: FileChangeListener): Promise<WatchHandle>;

  acquireAgentLock(workspaceId: string, options?: AcquireAgentLockOptions): Promise<AgentLockHandle>;
  inspectAgentLock(workspaceId: string): Promise<AgentLockStatus>;
  /** Release a lock regardless of ownership (administrative recovery). */
  forceReleaseAgentLock(workspaceId: string): Promise<void>;

  /** Release process-level resources (watchers, PTYs). Containers are retained. */
  dispose(): Promise<void>;
}
