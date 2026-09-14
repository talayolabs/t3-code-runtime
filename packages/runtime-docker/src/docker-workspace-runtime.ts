import path from 'node:path';

import {
  AgentLockManager,
  WorkspaceMetadataStore,
  assertCommandArgv,
  assertEnvironment,
  assertRepositoryRoot,
  assertTransition,
  containerNameForWorkspace,
  createWorkspaceMetadata,
  defaultBranchForWorkspace,
  normalizeWorkspaceId,
  resolveWorkspacePath,
} from '@t3-code/runtime-core';
import {
  CommandFailedError,
  ContainerMissingError,
  ContainerNotRunningError,
  ImportFailedError,
  InvalidArgumentError,
  RuntimeUnavailableError,
  WorkspaceAlreadyExistsError,
  WorkspaceNotFoundError,
  type AcquireAgentLockOptions,
  type AgentLockHandle,
  type AgentLockStatus,
  type CreateWorkspaceOptions,
  type ExecOptions,
  type ExecResult,
  type FileChangeListener,
  type FileEntry,
  type PtyHandle,
  type PtyOptions,
  type SearchQuery,
  type SearchResult,
  type WatchHandle,
  type Workspace,
  type WorkspaceMetadata,
  type WorkspaceRuntime,
  type WorkspaceStatus,
} from '@t3-code/runtime-protocol';

import { ContainerFileSystem, type ContainerExec } from './container-files.js';
import { ContainerSearch } from './container-search.js';
import { DockerCli, isContainerNotRunning, isNoSuchContainer, mapDockerStderr, type DockerContainerInspect } from './docker-cli.js';
import { DockerEngineApi } from './docker-engine-api.js';
import { buildDockerExecInvocation } from './docker-exec-command.js';
import { DockerPtyHandle } from './docker-pty.js';
import { PollingWatcher } from './polling-watcher.js';
import { RepositoryImporter } from './repository-importer.js';

export const DEFAULT_DOCKER_IMAGE = 'alpine/git:latest';
export const DEFAULT_REPOSITORY_PATH = '/workspace/repo';
export const DEFAULT_SHELL = '/bin/sh';
/** Label stamped on every container the runtime creates; cleanup only ever touches labelled containers. */
export const WORKSPACE_LABEL = 't3-code-runtime.workspace';
export const RUNTIME_LABEL = 't3-code-runtime.managed';

export interface DockerWorkspaceRuntimeOptions {
  /** Directory for metadata and locks. Default: `$T3_CODE_RUNTIME_HOME` or `~/.t3-code-runtime`. */
  stateDir?: string;
  /** Image used when `CreateWorkspaceOptions.image` is omitted. */
  defaultImage?: string;
  /** Container repository path used when `CreateWorkspaceOptions.repositoryPath` is omitted. */
  defaultRepositoryPath?: string;
  /** Prefix for deterministic container names. Default: `t3ws`. */
  containerNamePrefix?: string;
  /** Shell started by `spawnPty` when no command is given. Default: `/bin/sh`. */
  defaultShell?: string;
  /** Pull the image when it is not present locally. Default: `true`. */
  pullMissingImages?: boolean;
  /** Poll interval for `watch()`. Default: 1000ms. */
  watchIntervalMs?: number;
  /** Extra `docker create` arguments (e.g. `['--memory', '2g']`). Never include mounts of the source path. */
  extraCreateArgs?: string[];
  docker?: DockerCli;
  engineApi?: DockerEngineApi;
}

/**
 * Docker implementation of {@link WorkspaceRuntime}.
 *
 * One workspace maps to one retained container. The container is created with
 * `docker create` (never `docker run --rm`), so `stop` keeps the filesystem
 * and `start` resumes it. Nothing from the host is mounted; the repository is
 * imported once via Git bundle or tar and lives only inside the container.
 */
export class DockerWorkspaceRuntime implements WorkspaceRuntime {
  readonly kind = 'docker' as const;
  readonly store: WorkspaceMetadataStore;
  readonly locks: AgentLockManager;
  readonly docker: DockerCli;
  readonly engineApi: DockerEngineApi;

  private readonly defaultImage: string;
  private readonly defaultRepositoryPath: string;
  private readonly containerNamePrefix: string;
  private readonly defaultShell: string;
  private readonly pullMissingImages: boolean;
  private readonly watchIntervalMs: number | undefined;
  private readonly extraCreateArgs: string[];
  private readonly importer: RepositoryImporter;
  private readonly openPtys = new Map<DockerPtyHandle, string>();
  private readonly openWatchers = new Map<PollingWatcher, string>();

  constructor(options: DockerWorkspaceRuntimeOptions = {}) {
    this.store = new WorkspaceMetadataStore(options.stateDir);
    this.locks = new AgentLockManager({ lockPathFor: (id) => this.store.agentLockPath(id) });
    this.docker = options.docker ?? new DockerCli();
    this.engineApi = options.engineApi ?? new DockerEngineApi();
    this.defaultImage = options.defaultImage ?? DEFAULT_DOCKER_IMAGE;
    this.defaultRepositoryPath = assertRepositoryRoot(options.defaultRepositoryPath ?? DEFAULT_REPOSITORY_PATH);
    this.containerNamePrefix = options.containerNamePrefix ?? 't3ws';
    this.defaultShell = options.defaultShell ?? DEFAULT_SHELL;
    this.pullMissingImages = options.pullMissingImages ?? true;
    this.watchIntervalMs = options.watchIntervalMs;
    this.extraCreateArgs = [...(options.extraCreateArgs ?? [])];
    this.importer = new RepositoryImporter(this.docker);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async createWorkspace(options: CreateWorkspaceOptions): Promise<Workspace> {
    const workspaceId = normalizeWorkspaceId(options.workspaceId);
    const containerName = containerNameForWorkspace(workspaceId, this.containerNamePrefix);
    const repositoryPath = assertRepositoryRoot(options.repositoryPath ?? this.defaultRepositoryPath);
    const image = options.image ?? this.defaultImage;
    const branch = options.branch ?? defaultBranchForWorkspace(workspaceId);
    const reuseExisting = options.reuseExisting ?? true;
    const shouldStart = options.start ?? true;
    const sourcePath = options.sourcePath === undefined ? null : path.resolve(options.sourcePath);

    const existingMetadata = await this.store.read(workspaceId);
    const existingContainer = await this.docker.inspectContainer(containerName);

    if (existingMetadata && existingContainer) {
      if (!reuseExisting) throw new WorkspaceAlreadyExistsError(workspaceId);
      if (!this.isManaged(existingContainer)) {
        throw new WorkspaceAlreadyExistsError(workspaceId);
      }
      const status = statusFromInspect(existingContainer);
      await this.store.update(workspaceId, { containerId: existingContainer.Id, status });
      if (shouldStart && status !== 'running') await this.startWorkspace(workspaceId);
      return this.getWorkspace(workspaceId);
    }
    if (existingContainer && !existingMetadata) {
      // Never adopt a container we did not create.
      if (!this.isManaged(existingContainer)) throw new WorkspaceAlreadyExistsError(workspaceId);
      await this.removeContainer(existingContainer.Id);
    }
    if (existingMetadata && !existingContainer) {
      if (!reuseExisting) throw new WorkspaceAlreadyExistsError(workspaceId);
      // Metadata without a container: the container was removed externally; rebuild it.
      await this.store.delete(workspaceId);
    }

    await this.ensureImage(image);

    const metadata = createWorkspaceMetadata({
      workspaceId,
      runtime: 'docker',
      containerName,
      image,
      repositoryPath,
      branch,
      sourcePath,
      importMode: null,
      ...(options.labels ? { labels: options.labels } : {}),
    });
    await this.store.write(metadata);

    let containerId: string;
    try {
      containerId = await this.createContainer(metadata);
    } catch (error) {
      await this.store.delete(workspaceId);
      throw error;
    }
    await this.store.update(workspaceId, { containerId, status: 'created' });

    try {
      await this.startContainer(workspaceId, containerId);
      if (sourcePath !== null) {
        const result = await this.importer.import(
          {
            containerId,
            sourcePath,
            repositoryPath,
            branch,
            mode: options.importMode ?? 'auto',
          },
          this.containerExecFor(workspaceId, containerId),
        );
        await this.store.update(workspaceId, { importMode: result.mode });
      } else {
        await this.initializeEmptyRepository(workspaceId, containerId, repositoryPath, branch);
      }
      if (!shouldStart) await this.stopWorkspace(workspaceId);
    } catch (error) {
      await this.removeContainer(containerId).catch(() => undefined);
      await this.store.delete(workspaceId);
      if (error instanceof CommandFailedError) {
        throw new ImportFailedError(`Importing ${sourcePath ?? '<empty>'} into workspace "${workspaceId}" failed: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    return this.getWorkspace(workspaceId);
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const metadata = await this.store.require(normalizeWorkspaceId(workspaceId));
    const inspect = await this.inspectFor(metadata);
    const status: WorkspaceStatus = inspect ? statusFromInspect(inspect) : 'missing';
    if (status !== metadata.status || (inspect && inspect.Id !== metadata.containerId)) {
      const updated = await this.store.update(metadata.workspaceId, {
        status,
        containerId: inspect ? inspect.Id : metadata.containerId,
      });
      return this.toWorkspace(updated, status);
    }
    return this.toWorkspace(metadata, status);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const all = await this.store.list();
    const workspaces: Workspace[] = [];
    for (const metadata of all) {
      if (metadata.runtime !== 'docker') continue;
      workspaces.push(await this.getWorkspace(metadata.workspaceId));
    }
    return workspaces;
  }

  async startWorkspace(workspaceId: string): Promise<void> {
    const { metadata, inspect } = await this.requireContainer(workspaceId);
    const current = statusFromInspect(inspect);
    if (current === 'running') return;
    assertTransition(metadata.workspaceId, current, 'running');
    await this.startContainer(metadata.workspaceId, inspect.Id);
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const { metadata, inspect } = await this.requireContainer(workspaceId);
    const current = statusFromInspect(inspect);
    if (current === 'stopped' || current === 'created') {
      await this.store.update(metadata.workspaceId, { status: current });
      return;
    }
    assertTransition(metadata.workspaceId, current, 'stopped');
    await this.closeSessionsFor(metadata.workspaceId);
    const result = await this.docker.run(['stop', '--', inspect.Id], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8');
      if (!isNoSuchContainer(stderr)) throw mapDockerStderr(stderr, ['stop', metadata.containerName]);
    }
    await this.store.update(metadata.workspaceId, { status: 'stopped' });
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const id = normalizeWorkspaceId(workspaceId);
    const metadata = await this.store.read(id);
    if (metadata === null) throw new WorkspaceNotFoundError(id);
    await this.closeSessionsFor(id);
    const inspect = await this.inspectFor(metadata);
    if (inspect && this.isManaged(inspect)) {
      await this.removeContainer(inspect.Id);
    }
    await this.store.update(id, { status: 'removed', containerId: null }).catch(() => undefined);
    await this.store.delete(id);
  }

  // ───────────────────────────── processes ─────────────────────────────

  async exec(workspaceId: string, command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    return this.execInContainer(metadata, inspect.Id, command, args, options);
  }

  async spawnPty(workspaceId: string, options: PtyOptions = {}): Promise<PtyHandle> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const command = options.command ?? this.defaultShell;
    const argv = assertCommandArgv(command, options.args ?? []);
    const env = assertEnvironment(options.env);
    const workdir = options.cwd === undefined ? metadata.repositoryPath : resolveWorkspacePath(metadata.repositoryPath, options.cwd).absolute;
    const envList = Object.entries({ TERM: 'xterm-256color', ...env }).map(([key, value]) => `${key}=${value}`);

    const execId = await this.engineApi.createExec(inspect.Id, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: argv,
      Env: envList,
      WorkingDir: workdir,
      ...(options.user !== undefined ? { User: options.user } : {}),
    });
    const stream = await this.engineApi.startExecHijacked(execId, true);
    if (options.cols !== undefined && options.rows !== undefined) {
      await this.engineApi.resizeExec(execId, options.cols, options.rows).catch(() => undefined);
    }
    const pid = await this.engineApi
      .inspectExec(execId)
      .then((info) => info.Pid)
      .catch(() => null);
    const handle = new DockerPtyHandle(execId, pid, stream, this.engineApi);
    this.openPtys.set(handle, metadata.workspaceId);
    void handle.exited.then(() => this.openPtys.delete(handle));
    return handle;
  }

  // ─────────────────────────────── files ───────────────────────────────

  async readFile(workspaceId: string, filePath: string): Promise<Buffer> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const target = resolveWorkspacePath(metadata.repositoryPath, filePath);
    const fsys = new ContainerFileSystem(this.containerExecFor(metadata.workspaceId, inspect.Id));
    const entry = await fsys.stat(target.absolute, target.relative);
    fsys.assertNotDirectory(entry, target.relative);
    return fsys.readFile(target.absolute, target.relative);
  }

  async writeFile(workspaceId: string, filePath: string, data: Buffer | string): Promise<void> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const target = resolveWorkspacePath(metadata.repositoryPath, filePath);
    if (target.relative === '.') throw new InvalidArgumentError('cannot write to the repository root');
    const fsys = new ContainerFileSystem(this.containerExecFor(metadata.workspaceId, inspect.Id));
    await fsys.writeFile(target.absolute, target.relative, data);
  }

  async listDirectory(workspaceId: string, directoryPath: string): Promise<FileEntry[]> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const target = resolveWorkspacePath(metadata.repositoryPath, directoryPath);
    const fsys = new ContainerFileSystem(this.containerExecFor(metadata.workspaceId, inspect.Id));
    return fsys.listDirectory(target.absolute, target.relative);
  }

  async stat(workspaceId: string, filePath: string): Promise<FileEntry> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const target = resolveWorkspacePath(metadata.repositoryPath, filePath);
    const fsys = new ContainerFileSystem(this.containerExecFor(metadata.workspaceId, inspect.Id));
    return fsys.stat(target.absolute, target.relative);
  }

  async search(workspaceId: string, query: SearchQuery): Promise<SearchResult[]> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const target = resolveWorkspacePath(metadata.repositoryPath, query.path ?? '.');
    const search = new ContainerSearch(this.containerExecFor(metadata.workspaceId, inspect.Id));
    return search.search(query, target.absolute, target.relative);
  }

  async git(workspaceId: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    return this.execInContainer(metadata, inspect.Id, 'git', args, {
      ...options,
      env: { GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
    });
  }

  async watch(workspaceId: string, directoryPath: string, listener: FileChangeListener): Promise<WatchHandle> {
    const { metadata, inspect } = await this.requireRunning(workspaceId);
    const target = resolveWorkspacePath(metadata.repositoryPath, directoryPath);
    const watcher = new PollingWatcher(
      target.relative,
      target.absolute,
      this.containerExecFor(metadata.workspaceId, inspect.Id),
      listener,
      this.watchIntervalMs === undefined ? {} : { intervalMs: this.watchIntervalMs },
    );
    await watcher.start();
    this.openWatchers.set(watcher, metadata.workspaceId);
    watcher.onClose(() => this.openWatchers.delete(watcher));
    return watcher;
  }

  // ─────────────────────────────── locks ───────────────────────────────

  async acquireAgentLock(workspaceId: string, options: AcquireAgentLockOptions = {}): Promise<AgentLockHandle> {
    const id = normalizeWorkspaceId(workspaceId);
    await this.store.require(id);
    return this.locks.acquire(id, options);
  }

  async inspectAgentLock(workspaceId: string): Promise<AgentLockStatus> {
    return this.locks.inspect(normalizeWorkspaceId(workspaceId));
  }

  async forceReleaseAgentLock(workspaceId: string): Promise<void> {
    await this.locks.forceRelease(normalizeWorkspaceId(workspaceId));
  }

  /** Close every PTY and watcher owned by this runtime instance. Containers keep running. */
  async dispose(): Promise<void> {
    await this.closeSessionsFor(null);
  }

  // ────────────────────────────── internals ─────────────────────────────

  /** Exec function bound to a container; used by file, search, watch and import helpers. */
  private containerExecFor(workspaceId: string, containerId: string): ContainerExec {
    return async (command, args, options = {}) => {
      // Helpers use absolute paths; `/` keeps them working while the repository directory is being (re)created.
      const invocation = buildDockerExecInvocation({
        container: containerId,
        command,
        args,
        workdir: '/',
        interactive: options.input !== undefined,
      });
      const result = await this.docker.run(invocation.argv, {
        ...(options.input !== undefined ? { input: options.input } : {}),
        timeoutMs: options.timeoutMs ?? 120_000,
      });
      this.throwIfContainerGone(workspaceId, result.exitCode, result.stderr);
      return toExecResult(result);
    };
  }

  private async execInContainer(
    metadata: WorkspaceMetadata,
    containerId: string,
    command: string,
    args: string[],
    options: ExecOptions,
  ): Promise<ExecResult> {
    const workdir = options.cwd === undefined ? metadata.repositoryPath : resolveWorkspacePath(metadata.repositoryPath, options.cwd).absolute;
    const invocation = buildDockerExecInvocation({
      container: containerId,
      command,
      args,
      workdir,
      interactive: options.input !== undefined,
      ...(options.env ? { env: options.env } : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
    });
    const result = await this.docker.run(invocation.argv, {
      env: invocation.env,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.throwIfContainerGone(metadata.workspaceId, result.exitCode, result.stderr);
    return toExecResult(result);
  }

  private throwIfContainerGone(workspaceId: string, exitCode: number, stderr: Buffer): void {
    // `docker exec` reports its own failures with exit 125/126/127 and a diagnostic on stderr.
    if (exitCode < 125) return;
    const text = stderr.toString('utf8');
    if (isNoSuchContainer(text)) {
      throw new ContainerMissingError(workspaceId, containerNameForWorkspace(workspaceId, this.containerNamePrefix));
    }
    if (isContainerNotRunning(text)) throw new ContainerNotRunningError(workspaceId, 'stopped');
  }

  private async requireContainer(workspaceId: string): Promise<{ metadata: WorkspaceMetadata; inspect: DockerContainerInspect }> {
    const metadata = await this.store.require(normalizeWorkspaceId(workspaceId));
    const inspect = await this.inspectFor(metadata);
    if (!inspect) {
      await this.store.update(metadata.workspaceId, { status: 'missing' }).catch(() => undefined);
      throw new ContainerMissingError(metadata.workspaceId, metadata.containerName);
    }
    return { metadata, inspect };
  }

  private async requireRunning(workspaceId: string): Promise<{ metadata: WorkspaceMetadata; inspect: DockerContainerInspect }> {
    const found = await this.requireContainer(workspaceId);
    const status = statusFromInspect(found.inspect);
    if (status !== 'running') {
      await this.store.update(found.metadata.workspaceId, { status }).catch(() => undefined);
      throw new ContainerNotRunningError(found.metadata.workspaceId, status);
    }
    return found;
  }

  private async inspectFor(metadata: WorkspaceMetadata): Promise<DockerContainerInspect | null> {
    const byId = metadata.containerId ? await this.docker.inspectContainer(metadata.containerId) : null;
    if (byId && this.isManaged(byId)) return byId;
    const byName = await this.docker.inspectContainer(metadata.containerName);
    return byName && this.isManaged(byName) ? byName : null;
  }

  private isManaged(inspect: DockerContainerInspect): boolean {
    const labels = inspect.Config.Labels ?? {};
    return labels[RUNTIME_LABEL] === 'true' && labels[WORKSPACE_LABEL] !== undefined;
  }

  private async ensureImage(image: string): Promise<void> {
    if (await this.docker.imageExists(image)) return;
    if (!this.pullMissingImages) {
      throw new RuntimeUnavailableError(`Docker image "${image}" is not available locally and pulling is disabled.`);
    }
    await this.docker.pullImage(image);
  }

  private async createContainer(metadata: WorkspaceMetadata): Promise<string> {
    const args = [
      'create',
      '--name',
      metadata.containerName,
      '--label',
      `${RUNTIME_LABEL}=true`,
      '--label',
      `${WORKSPACE_LABEL}=${metadata.workspaceId}`,
      '--init',
      '--stop-signal',
      'SIGKILL',
      '--workdir',
      metadata.repositoryPath,
      '--entrypoint',
      'sleep',
      ...this.extraCreateArgs,
      '--',
      metadata.image,
      'infinity',
    ];
    const result = await this.docker.run(args, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw mapDockerStderr(result.stderr.toString('utf8'), ['create', metadata.containerName]);
    return result.stdout.toString('utf8').trim();
  }

  private async startContainer(workspaceId: string, containerId: string): Promise<void> {
    const result = await this.docker.run(['start', '--', containerId], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8');
      if (isNoSuchContainer(stderr)) {
        throw new ContainerMissingError(workspaceId, containerNameForWorkspace(workspaceId, this.containerNamePrefix));
      }
      throw mapDockerStderr(stderr, ['start', workspaceId]);
    }
    await this.store.update(workspaceId, { status: 'running', containerId });
  }

  private async removeContainer(containerId: string): Promise<void> {
    const result = await this.docker.run(['rm', '--force', '--volumes', '--', containerId], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8');
      if (!isNoSuchContainer(stderr)) throw mapDockerStderr(stderr, ['rm', containerId]);
    }
  }

  private async initializeEmptyRepository(workspaceId: string, containerId: string, repositoryPath: string, branch: string): Promise<void> {
    const exec = this.containerExecFor(workspaceId, containerId);
    const mkdir = await exec('mkdir', ['-p', '--', repositoryPath]);
    if (mkdir.exitCode !== 0) throw new ImportFailedError(mkdir.stderr.toString('utf8').trim());
    const init = await exec('git', ['-C', repositoryPath, 'init', '--quiet', '--initial-branch', branch]);
    if (init.exitCode !== 0) throw new ImportFailedError(init.stderr.toString('utf8').trim());
  }

  /** Close PTYs and watchers for one workspace, or for all of them when `workspaceId` is `null`. */
  private async closeSessionsFor(workspaceId: string | null): Promise<void> {
    const watchers = [...this.openWatchers].filter(([, id]) => workspaceId === null || id === workspaceId);
    const ptys = [...this.openPtys].filter(([, id]) => workspaceId === null || id === workspaceId);
    await Promise.all(watchers.map(([watcher]) => watcher.close()));
    await Promise.all(ptys.map(([pty]) => pty.kill()));
  }

  private toWorkspace(metadata: WorkspaceMetadata, status: WorkspaceStatus): Workspace {
    return { id: metadata.workspaceId, metadata, status };
  }
}

export function statusFromInspect(inspect: DockerContainerInspect): WorkspaceStatus {
  switch (inspect.State.Status) {
    case 'running':
    case 'paused':
    case 'restarting':
      return 'running';
    case 'created':
      return 'created';
    case 'exited':
    case 'dead':
      return 'stopped';
    case 'removing':
      return 'missing';
  }
}

function toExecResult(result: {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}): ExecResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  };
}
