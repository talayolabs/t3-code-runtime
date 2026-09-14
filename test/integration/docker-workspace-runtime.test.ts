import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AgentLockHeldError,
  ContainerMissingError,
  ContainerNotRunningError,
  FileNotFoundError,
  InvalidPathError,
  WorkspaceNotFoundError,
  type FileChangeEvent,
} from '@t3-code/runtime-protocol';
import { DEFAULT_DOCKER_IMAGE, DockerCli, DockerWorkspaceRuntime, RUNTIME_LABEL, runCli } from '@t3-code/runtime-docker';

const execFileAsync = promisify(execFile);

const docker = new DockerCli();
const dockerAvailable = await docker.isAvailable();
const SKIP_MESSAGE = 'Docker daemon is not reachable; skipping Docker integration tests (set DOCKER_HOST or start Docker).';
if (!dockerAvailable) {
  // Vitest swallows module-level console output; write straight to the terminal so the skip is visible.
  process.stderr.write(`\n${SKIP_MESSAGE}\n\n`);
}

const PREFIX = `t3it${process.pid.toString(36)}`;
const IMAGE = process.env['T3_RUNTIME_TEST_IMAGE'] ?? DEFAULT_DOCKER_IMAGE;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'it', GIT_AUTHOR_EMAIL: 'it@example.com', GIT_COMMITTER_NAME: 'it', GIT_COMMITTER_EMAIL: 'it@example.com' },
  });
  return stdout;
}

async function snapshotDirectory(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        result.set(`${rel}/`, 'dir');
        await walk(full);
      } else {
        const stat = await fs.stat(full);
        result.set(rel, `${stat.size}:${stat.mtimeMs}:${(await fs.readFile(full)).toString('base64')}`);
      }
    }
  }
  await walk(root);
  return result;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!dockerAvailable)(dockerAvailable ? 'DockerWorkspaceRuntime (Docker integration)' : `DockerWorkspaceRuntime — ${SKIP_MESSAGE}`, () => {
  let tmp: string;
  let stateDir: string;
  let gitSource: string;
  let plainSource: string;
  let runtime: DockerWorkspaceRuntime;
  const created = new Set<string>();

  const newRuntime = (): DockerWorkspaceRuntime =>
    new DockerWorkspaceRuntime({ stateDir, containerNamePrefix: PREFIX, defaultImage: IMAGE, watchIntervalMs: 200 });

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't3-runtime-it-'));
    stateDir = path.join(tmp, 'state');
    gitSource = path.join(tmp, 'git-source');
    plainSource = path.join(tmp, 'plain-source');

    await fs.mkdir(path.join(gitSource, 'src'), { recursive: true });
    await fs.writeFile(path.join(gitSource, 'README.md'), '# Sample\n');
    await fs.writeFile(path.join(gitSource, 'src', 'index.ts'), 'export const needle = 42;\n');
    await git(gitSource, 'init', '-q', '-b', 'main');
    await git(gitSource, 'add', 'README.md', 'src/index.ts');
    await git(gitSource, 'commit', '-q', '-m', 'initial');
    await git(gitSource, 'tag', 'v1');
    // Uncommitted host change: must never be imported and must never be touched.
    await fs.writeFile(path.join(gitSource, 'README.md'), '# Sample\n\ndirty host change\n');

    await fs.mkdir(path.join(plainSource, 'nested'), { recursive: true });
    await fs.writeFile(path.join(plainSource, 'hello.txt'), 'hello\n');
    await fs.writeFile(path.join(plainSource, 'nested', 'deep.txt'), 'deep\n');
    // A Git repository without commits is imported like a plain folder (its .git is not copied).
    await git(plainSource, 'init', '-q');

    runtime = newRuntime();
  });

  afterAll(async () => {
    if (runtime) {
      await runtime.dispose();
      for (const id of created) {
        await runtime.removeWorkspace(id).catch(() => undefined);
      }
    }
    // Belt and braces: nothing with our prefix may survive the suite.
    const leftovers = await docker.run(['ps', '--all', '--quiet', '--filter', `label=${RUNTIME_LABEL}=true`, '--filter', `name=^/${PREFIX}-`]);
    const ids = leftovers.stdout.toString('utf8').split('\n').filter((line) => line.length > 0);
    if (ids.length > 0) await docker.run(['rm', '--force', '--volumes', '--', ...ids]);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const track = (id: string): string => {
    created.add(id);
    return id;
  };

  it('creates a workspace from a Git repository via bundle without mounting or touching the host', async () => {
    const before = await snapshotDirectory(gitSource);
    const hostHead = (await git(gitSource, 'rev-parse', 'HEAD')).trim();

    const ws = await runtime.createWorkspace({ workspaceId: track('Git Import'), sourcePath: gitSource });
    expect(ws.id).toBe('git-import');
    expect(ws.status).toBe('running');
    expect(ws.metadata).toMatchObject({
      workspaceId: 'git-import',
      runtime: 'docker',
      containerName: `${PREFIX}-git-import`,
      repositoryPath: '/workspace/repo',
      branch: 't3/git-import',
      importMode: 'git-bundle',
      image: IMAGE,
    });
    expect(ws.metadata.containerId).toMatch(/^[0-9a-f]{64}$/);

    const inspect = await docker.inspectContainer(ws.metadata.containerId ?? '');
    expect(inspect).not.toBeNull();
    // No host path is mounted. (Images may declare anonymous volumes, e.g. alpine/git's `/git`;
    // those are container-local and removed together with the container.)
    const raw = await docker.run(['inspect', '--format', '{{json .Mounts}}', '--', ws.metadata.containerId ?? '']);
    const mounts = JSON.parse(raw.stdout.toString('utf8')) as { Type: string; Source: string }[];
    expect(mounts.filter((mount) => mount.Type === 'bind')).toEqual([]);
    expect(mounts.some((mount) => mount.Source.startsWith(tmp))).toBe(false);

    const head = (await runtime.git('git-import', ['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
    expect(head).toBe(hostHead);
    const branch = (await runtime.git('git-import', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.toString('utf8').trim();
    expect(branch).toBe('t3/git-import');
    const tags = (await runtime.git('git-import', ['tag', '--list'])).stdout.toString('utf8').trim();
    expect(tags).toBe('v1');

    // Only committed content is imported; the dirty host change stays on the host.
    expect((await runtime.readFile('git-import', 'README.md')).toString('utf8')).toBe('# Sample\n');
    expect(await snapshotDirectory(gitSource)).toEqual(before);
    expect(await git(gitSource, 'status', '--porcelain')).toBe(' M README.md\n');
    expect((await git(gitSource, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main');
  });

  it('creates a workspace from a non-Git folder via tar', async () => {
    const before = await snapshotDirectory(plainSource);
    const ws = await runtime.createWorkspace({ workspaceId: track('plain'), sourcePath: plainSource });
    expect(ws.metadata.importMode).toBe('tar');
    expect((await runtime.readFile('plain', 'nested/deep.txt')).toString('utf8')).toBe('deep\n');
    const log = (await runtime.git('plain', ['log', '--oneline'])).stdout.toString('utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect((await runtime.git('plain', ['status', '--porcelain'])).stdout.toString('utf8')).toBe('');

    expect(await snapshotDirectory(plainSource)).toEqual(before);
    expect((await git(plainSource, 'status', '--porcelain')).split('\n').filter(Boolean).sort()).toEqual(['?? hello.txt', '?? nested/']);
    expect((await runtime.listDirectory('plain', '.')).map((e) => e.path).sort()).toEqual(['.git', 'hello.txt', 'nested']);
    const owner = await runtime.exec('plain', 'sh', ['-c', 'stat -c %u .git hello.txt; id -u']);
    expect(new Set(owner.stdout.toString('utf8').trim().split('\n')).size).toBe(1);
  });

  it('executes commands inside the container with argv semantics', async () => {
    const result = await runtime.exec('git-import', 'sh', ['-c', 'pwd; printf "%s" "$1"', 'sh', 'a b;c']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString('utf8')).toBe('/workspace/repo\na b;c');

    const failing = await runtime.exec('git-import', 'sh', ['-c', 'echo err >&2; exit 3']);
    expect(failing.exitCode).toBe(3);
    expect(failing.stderr.toString('utf8')).toBe('err\n');

    const cwd = await runtime.exec('git-import', 'pwd', [], { cwd: 'src' });
    expect(cwd.stdout.toString('utf8').trim()).toBe('/workspace/repo/src');

    const env = await runtime.exec('git-import', 'sh', ['-c', 'echo "$T3_TEST_VALUE"'], { env: { T3_TEST_VALUE: 'from host' } });
    expect(env.stdout.toString('utf8').trim()).toBe('from host');

    const timedOut = await runtime.exec('git-import', 'sleep', ['30'], { timeoutMs: 500 });
    expect(timedOut.timedOut).toBe(true);
  });

  it('reads, writes, stats and lists files inside the container', async () => {
    await runtime.writeFile('git-import', 'src/new/file.txt', Buffer.from('written from host\n'));
    expect((await runtime.readFile('git-import', 'src/new/file.txt')).toString('utf8')).toBe('written from host\n');

    const binary = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
    await runtime.writeFile('git-import', 'bin.dat', binary);
    expect(await runtime.readFile('git-import', 'bin.dat')).toEqual(binary);

    const entries = await runtime.listDirectory('git-import', '.');
    expect(entries.map((e) => `${e.kind}:${e.path}`).sort()).toEqual(['directory:.git', 'directory:src', 'file:README.md', 'file:bin.dat']);
    const src = await runtime.listDirectory('git-import', 'src');
    expect(src.map((e) => e.path)).toEqual(['src/index.ts', 'src/new']);

    const stat = await runtime.stat('git-import', 'src/new/file.txt');
    expect(stat).toMatchObject({ name: 'file.txt', path: 'src/new/file.txt', kind: 'file', size: 18 });

    await expect(runtime.readFile('git-import', 'missing.txt')).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(runtime.listDirectory('git-import', 'missing')).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(runtime.readFile('git-import', '../etc/passwd')).rejects.toBeInstanceOf(InvalidPathError);
    await expect(runtime.writeFile('git-import', '/etc/evil', Buffer.from('x'))).rejects.toBeInstanceOf(InvalidPathError);

    // Host source is still untouched after container-side writes.
    await expect(fs.stat(path.join(gitSource, 'src', 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('searches inside the container', async () => {
    const results = await runtime.search('git-import', { pattern: 'needle' });
    expect(results).toEqual([{ path: 'src/index.ts', line: 1, text: 'export const needle = 42;' }]);

    const scoped = await runtime.search('git-import', { pattern: 'written', path: 'src' });
    expect(scoped).toEqual([{ path: 'src/new/file.txt', line: 1, text: 'written from host' }]);

    const none = await runtime.search('git-import', { pattern: 'definitely-not-there' });
    expect(none).toEqual([]);

    const fixed = await runtime.search('git-import', { pattern: 'NEEDLE = 4', fixedString: true, caseSensitive: false });
    expect(fixed).toHaveLength(1);
  });

  it('runs git status and diff inside the container', async () => {
    await runtime.writeFile('git-import', 'src/index.ts', Buffer.from('export const needle = 43;\n'));
    const status = await runtime.git('git-import', ['status', '--porcelain']);
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString('utf8').split('\n').filter(Boolean).sort()).toEqual(['?? bin.dat', '?? src/new/', ' M src/index.ts'].sort());

    const diff = await runtime.git('git-import', ['diff', '--', 'src/index.ts']);
    expect(diff.stdout.toString('utf8')).toContain('-export const needle = 42;');
    expect(diff.stdout.toString('utf8')).toContain('+export const needle = 43;');

    await runtime.git('git-import', ['-c', 'user.name=T3', '-c', 'user.email=t3@example.com', 'commit', '-q', '-am', 'bump']);
    expect((await runtime.git('git-import', ['log', '--oneline'])).stdout.toString('utf8').split('\n').filter(Boolean)).toHaveLength(2);

    // The host repository did not gain the commit.
    expect((await git(gitSource, 'log', '--oneline')).trim().split('\n')).toHaveLength(1);
  });

  it('streams a PTY session with resize support', async () => {
    const pty = await runtime.spawnPty('git-import', { cols: 100, rows: 30 });
    let output = '';
    pty.onData((chunk) => {
      output += chunk.toString('utf8');
    });
    pty.write('stty size; echo PTY_MARKER_$((20+22))\n');
    await waitFor(() => output.includes('PTY_MARKER_42'), 10_000);
    expect(output).toContain('30 100');

    await pty.resize(120, 40);
    pty.write('stty size\n');
    await waitFor(() => output.includes('40 120'), 10_000);

    pty.write('exit 5\n');
    const exit = await pty.exited;
    expect(exit.exitCode).toBe(5);
  });

  it('watches a directory inside the container', async () => {
    const events: FileChangeEvent[] = [];
    const watcher = await runtime.watch('git-import', 'src', (batch) => {
      events.push(...batch);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    await runtime.writeFile('git-import', 'src/watched.txt', Buffer.from('1'));
    await waitFor(() => events.some((e) => e.type === 'create' && e.path === 'src/watched.txt'), 5_000);

    await runtime.exec('git-import', 'sh', ['-c', 'sleep 1; echo 22 >> src/watched.txt']);
    await waitFor(() => events.some((e) => e.type === 'modify' && e.path === 'src/watched.txt'), 5_000);

    await runtime.exec('git-import', 'rm', ['src/watched.txt']);
    await waitFor(() => events.some((e) => e.type === 'delete' && e.path === 'src/watched.txt'), 5_000);

    let closed = false;
    watcher.onClose(() => {
      closed = true;
    });
    await watcher.close();
    expect(closed).toBe(true);
    const count = events.length;
    await runtime.writeFile('git-import', 'src/after-close.txt', Buffer.from('x'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events).toHaveLength(count);
  });

  it('stops and starts a retained container, keeping its filesystem', async () => {
    await runtime.stopWorkspace('git-import');
    expect((await runtime.getWorkspace('git-import')).status).toBe('stopped');
    await expect(runtime.exec('git-import', 'true')).rejects.toBeInstanceOf(ContainerNotRunningError);
    await expect(runtime.readFile('git-import', 'README.md')).rejects.toBeInstanceOf(ContainerNotRunningError);

    const inspect = await docker.inspectContainer(`${PREFIX}-git-import`);
    expect(inspect?.State.Status).toBe('exited');

    await runtime.stopWorkspace('git-import'); // idempotent
    await runtime.startWorkspace('git-import');
    await runtime.startWorkspace('git-import'); // idempotent
    expect((await runtime.getWorkspace('git-import')).status).toBe('running');
    expect((await runtime.readFile('git-import', 'src/new/file.txt')).toString('utf8')).toBe('written from host\n');
  });

  it('reconnects to an existing container from a fresh runtime instance', async () => {
    await runtime.stopWorkspace('git-import');
    const containerId = (await runtime.getWorkspace('git-import')).metadata.containerId;

    const restarted = newRuntime();
    const listed = await restarted.listWorkspaces();
    expect(listed.map((w) => `${w.id}:${w.status}`).sort()).toEqual(['git-import:stopped', 'plain:running']);

    const ws = await restarted.getWorkspace('git-import');
    expect(ws.metadata.containerId).toBe(containerId);
    await restarted.startWorkspace('git-import');
    expect((await restarted.readFile('git-import', 'src/new/file.txt')).toString('utf8')).toBe('written from host\n');

    // createWorkspace with the same id reuses the retained container instead of importing again.
    const reused = await restarted.createWorkspace({ workspaceId: 'git-import', sourcePath: gitSource });
    expect(reused.metadata.containerId).toBe(containerId);
    expect((await restarted.readFile('git-import', 'src/new/file.txt')).toString('utf8')).toBe('written from host\n');
    await restarted.dispose();
  });

  it('enforces one agent per workspace while leaving terminals unaffected', async () => {
    const first = await runtime.acquireAgentLock('git-import', { ownerId: 'agent-a', heartbeatIntervalMs: 0 });
    const status = await runtime.inspectAgentLock('git-import');
    expect(status.locked).toBe(true);
    expect(status.owner?.ownerId).toBe('agent-a');

    await expect(runtime.acquireAgentLock('git-import', { ownerId: 'agent-b' })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentLockHeldError);
      const held = error as AgentLockHeldError;
      expect(held.owner.ownerId).toBe('agent-a');
      expect(held.message).toContain('This workspace already has an active agent session.');
      expect(held.message).toContain('Create another workspace to run a second agent.');
      return true;
    });

    // A terminal/exec still works while the agent lock is held.
    expect((await runtime.exec('git-import', 'echo', ['terminal ok'])).stdout.toString('utf8')).toBe('terminal ok\n');
    const pty = await runtime.spawnPty('git-import', { command: 'sh', args: ['-c', 'exit 0'] });
    expect((await pty.exited).exitCode).toBe(0);

    // Another workspace is not affected.
    const other = await runtime.acquireAgentLock('plain', { ownerId: 'agent-b', heartbeatIntervalMs: 0 });
    await other.release();

    // The lock survives a runtime restart.
    const restarted = newRuntime();
    expect((await restarted.inspectAgentLock('git-import')).owner?.ownerId).toBe('agent-a');
    await expect(restarted.acquireAgentLock('git-import')).rejects.toBeInstanceOf(AgentLockHeldError);
    await restarted.dispose();

    await first.release();
    await first.release();
    expect((await runtime.inspectAgentLock('git-import')).locked).toBe(false);
    const second = await runtime.acquireAgentLock('git-import', { ownerId: 'agent-b', heartbeatIntervalMs: 0 });
    expect(second.owner.ownerId).toBe('agent-b');
    await second.release();
  });

  it('exposes the same operations through the CLI', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (chunk: string | Uint8Array) => (out.push(chunk.toString()), true) } as unknown as NodeJS.WritableStream,
      stderr: { write: (chunk: string | Uint8Array) => (err.push(chunk.toString()), true) } as unknown as NodeJS.WritableStream,
      stdin: process.stdin,
      env: process.env,
    };
    const opts = { containerNamePrefix: PREFIX, defaultImage: IMAGE };
    const run = (...argv: string[]): Promise<number> => runCli(['--state-dir', stateDir, ...argv], io, opts);

    expect(await run('ls', 'git-import', 'src')).toBe(0);
    expect(out.join('')).toContain('index.ts');
    out.length = 0;

    expect(await run('read', 'git-import', 'README.md')).toBe(0);
    expect(out.join('')).toBe('# Sample\n');
    out.length = 0;

    expect(await run('exec', 'git-import', '--', 'echo', 'cli')).toBe(0);
    expect(out.join('')).toBe('cli\n');
    out.length = 0;

    expect(await run('git', 'git-import', '--', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(0);
    expect(out.join('').trim()).toBe('t3/git-import');
    out.length = 0;

    expect(await run('agent-lock', 'acquire', 'git-import', '--owner', 'cli-agent')).toBe(0);
    expect(await run('agent-lock', 'acquire', 'git-import', '--owner', 'other')).toBe(3);
    expect(err.join('')).toContain('This workspace already has an active agent session.');
    expect(await run('agent-lock', 'release', 'git-import')).toBe(0);
    expect((await runtime.inspectAgentLock('git-import')).locked).toBe(false);

    expect(await run('exec', 'no-such-workspace', '--', 'true')).toBe(1);
    expect(err.join('')).toContain('WORKSPACE_NOT_FOUND');
  });

  it('reports a container that was removed behind its back and can be cleaned up', async () => {
    const ws = await runtime.createWorkspace({ workspaceId: track('vanish'), sourcePath: plainSource });
    await docker.run(['rm', '--force', '--', ws.metadata.containerId ?? '']);

    expect((await runtime.getWorkspace('vanish')).status).toBe('missing');
    await expect(runtime.exec('vanish', 'true')).rejects.toBeInstanceOf(ContainerMissingError);
    await expect(runtime.startWorkspace('vanish')).rejects.toBeInstanceOf(ContainerMissingError);

    await runtime.removeWorkspace('vanish');
    await expect(runtime.getWorkspace('vanish')).rejects.toBeInstanceOf(WorkspaceNotFoundError);

    // Re-creating after external removal rebuilds the container.
    const rebuilt = await runtime.createWorkspace({ workspaceId: 'vanish', sourcePath: plainSource });
    expect(rebuilt.status).toBe('running');
    expect(rebuilt.metadata.containerId).not.toBe(ws.metadata.containerId);
  });

  it('refuses to adopt or remove containers it did not create', async () => {
    const foreign = `${PREFIX}-foreign`;
    const createdForeign = await docker.run(['create', '--name', foreign, '--entrypoint', 'sleep', '--', IMAGE, 'infinity']);
    expect(createdForeign.exitCode).toBe(0);
    try {
      await expect(runtime.createWorkspace({ workspaceId: 'foreign' })).rejects.toThrow(/already exists/i);
      expect(await docker.inspectContainer(foreign)).not.toBeNull();
    } finally {
      await docker.run(['rm', '--force', '--', foreign]);
    }
  });

  it('removes workspaces explicitly and leaves nothing behind', async () => {
    const ids = ['git-import', 'plain', 'vanish'];
    for (const id of ids) {
      const containerId = (await runtime.getWorkspace(id)).metadata.containerId ?? '';
      await runtime.removeWorkspace(id);
      created.delete(id);
      expect(await docker.inspectContainer(containerId)).toBeNull();
      await expect(runtime.getWorkspace(id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
      await expect(runtime.removeWorkspace(id)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    }
    expect(await runtime.listWorkspaces()).toEqual([]);
    await expect(fs.readdir(path.join(stateDir, 'workspaces'))).resolves.toEqual([]);
  });
});
