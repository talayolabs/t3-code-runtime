# t3-code-runtime

Workspace runtime for T3 Code: a retained Docker
container **is** the workspace. The repository checkout lives only inside the container;
the host repository is never mounted and never modified.

```text
T3 workspace
  → one runtime
  → one Docker container
  → one repository checkout
  → one agent session
```

This repository is the runtime foundation only. It does not modify T3 Code, ship a UI,
mirror files back to the host, or implement SSH yet (the protocol is designed so an SSH
runtime can be added without changing callers).

## Packages

| Package                         | Purpose                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@t3-code/runtime-protocol`     | Runtime-agnostic contract: `WorkspaceRuntime`, workspace/metadata/PTY/file/search/watch types, typed `RuntimeError`s. No I/O, no Docker.                 |
| `@t3-code/runtime-core`         | Reusable host-side building blocks: workspace id/container-name normalization, workspace-relative path validation, metadata store, lifecycle state machine, durable agent lock, argv validation, error mapping. |
| `@t3-code/runtime-docker`       | `DockerWorkspaceRuntime` (the `WorkspaceRuntime` implementation), Docker CLI/Engine API adapters, repository importer, container file system, search, polling watcher, and the `t3-runtime` CLI. |

```text
packages/
  runtime-protocol/   interface + types + errors
  runtime-core/       ids, paths, metadata, lifecycle, agent lock, argv
  runtime-docker/     DockerWorkspaceRuntime, importer, files, search, watcher, CLI
test/
  unit/               CLI parsing tests
  integration/        Docker integration suite (skips cleanly without Docker)
```

## Architecture

```text
┌──────────────────── host ────────────────────┐        ┌────────── container t3ws-<id> ──────────┐
│ T3 Code ──▶ WorkspaceRuntime (protocol)      │        │  /workspace/repo   (the only checkout)  │
│               │                              │        │     ├── .git                            │
│               ▼                              │ docker │     └── …                               │
│  DockerWorkspaceRuntime ── docker exec ──────┼───────▶│  sh / git / cat / find / stat / rg       │
│      │          └──────── Engine API ────────┼───────▶│  PTY sessions (hijacked exec stream)     │
│      ▼                                       │        │  entrypoint: sleep infinity             │
│  ~/.t3-code-runtime/workspaces/<id>/         │        └─────────────────────────────────────────┘
│      metadata.json   agent.lock              │
│                                              │
│  host repo  ── read once (bundle/tar) ──▶     │   (never mounted, never written)
└──────────────────────────────────────────────┘
```

Every operation T3 Code needs is executed **inside** the container through `docker exec`
(or the Docker Engine API for PTYs) and the results are streamed back to the host. Nothing
is synchronized to the host filesystem; the container filesystem is the source of truth.

### No-mount behaviour

- Containers are created with `docker create` and **no `--volume`/`--mount` of the source**.
  `extraCreateArgs` exists for resource limits and similar; it must not be used to mount the
  source path.
- Source repositories are read exactly once at `createWorkspace` time (Git bundle or tar) and
  streamed into the container with `docker cp`. After that the host path is only stored in
  the metadata as information.
- The runtime never writes to the host repository: no checkout, no branch, no commit, no
  `.git` creation for plain folders. The integration suite snapshots the host source
  directory before and after and asserts byte-for-byte equality.
- Images may declare anonymous volumes (`alpine/git` declares `/git`); these are
  container-local and removed together with the container (`docker rm --volumes`).

### Container lifecycle

```text
creating ──▶ created ──▶ running ◀──▶ stopped ──▶ removed
                 │           │            │
                 └───────────┴────────────┴──▶ missing ──▶ removed
```

- `createWorkspace()` — `docker create --init --stop-signal SIGKILL --label … --entrypoint sleep <image> infinity`,
  then `docker start`, then import. If a retained container for the id already exists it is
  reused (and started) instead of re-imported; pass `reuseExisting: false` to get
  `WORKSPACE_ALREADY_EXISTS` instead.
- `startWorkspace()` / `stopWorkspace()` — `docker start` / `docker stop`. Stopping keeps the
  container and its filesystem; both calls are idempotent. Open PTYs and watchers are closed
  before stopping.
- `removeWorkspace()` — `docker rm --force --volumes` **only** for containers carrying the
  runtime label `t3-code-runtime.managed=true`, then deletes the metadata directory.
  Containers not created by the runtime are never adopted or removed
  (`WORKSPACE_ALREADY_EXISTS` is raised instead).
- Containers removed behind the runtime's back are reported as `missing`; operations fail
  with `CONTAINER_MISSING`, `removeWorkspace()` still cleans up the metadata, and
  `createWorkspace()` rebuilds the container.
- Operations on a stopped workspace fail with `CONTAINER_NOT_RUNNING`.

Containers are labelled `t3-code-runtime.managed=true` and
`t3-code-runtime.workspace=<workspaceId>` and named `<prefix>-<workspaceId>` (default prefix
`t3ws`). Workspace ids are normalized (`My Feature/Branch` → `my-feature-branch`, max 48
chars, `^[a-z0-9][a-z0-9._-]*$`, no `..`), so they can never inject Docker arguments.

### Workspace metadata

Metadata lives outside the source checkout, in
`$T3_CODE_RUNTIME_HOME` (default `~/.t3-code-runtime`):

```text
~/.t3-code-runtime/workspaces/<workspaceId>/metadata.json
~/.t3-code-runtime/workspaces/<workspaceId>/agent.lock
```

```json
{
  "version": 1,
  "workspaceId": "example",
  "runtime": "docker",
  "containerId": "3f9c…",
  "containerName": "t3ws-example",
  "image": "alpine/git:latest",
  "repositoryPath": "/workspace/repo",
  "branch": "t3/example",
  "sourcePath": "/home/me/src/example",
  "importMode": "git-bundle",
  "status": "running",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "labels": {}
}
```

Writes are atomic (temp file + rename). After a process restart a new
`DockerWorkspaceRuntime` reads this file, inspects the container by id and reconnects;
`status` is re-derived from `docker inspect` on every `getWorkspace()`.

### Repository import

| Host source                         | Strategy     | What ends up in the container                                                                        |
| ----------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| Git repository with at least one commit | `git-bundle` | `git bundle create --all` on the host → `docker cp` → `git init` + `git fetch` from the bundle inside the container → branch `t3/<id>` created from the source `HEAD` and checked out. All refs and tags are preserved; **uncommitted host changes are not imported**. |
| Any other directory (including a Git repository without commits) | `tar`        | `tar -cf - .` (excluding `.git`) streamed into `docker cp -`, ownership handed to the container user → `git init` + initial commit (author `T3 Code Runtime <t3-code-runtime@localhost>`) on branch `t3/<id>`. The host folder does not gain a `.git`. |
| No `sourcePath`                     | —            | Empty repository initialized inside the container on branch `t3/<id>`.                              |

`importMode: 'git-bundle' | 'tar'` forces a strategy; the default is `auto`.
Host Git credentials, hooks and config are not copied.

### One agent per workspace

Each workspace has at most one active **agent** session. Terminals (`exec`/`spawnPty`) are
never blocked by the lock; only agent sessions must acquire it.

- `acquireAgentLock()` creates `agent.lock` with `O_EXCL`, so concurrent attempts are
  race-safe; exactly one wins.
- A second acquisition fails with `AgentLockHeldError` (`code: 'AGENT_LOCK_HELD'`) carrying
  the current owner and the message:

  ```text
  This workspace already has an active agent session.
  Create another workspace to run a second agent.
  ```

- The lock survives process restarts; it is stale when the owning PID on the same host is
  gone or the heartbeat is older than `staleAfterMs` (default 5 minutes). Stale locks are
  reclaimed automatically (disable with `reclaimStale: false`); `forceReleaseAgentLock()`
  removes any lock.
- `release()` is idempotent and only removes the lock if it is still ours.

## API

```ts
import { DockerWorkspaceRuntime } from '@t3-code/runtime-docker';
import { AgentLockHeldError } from '@t3-code/runtime-protocol';

const runtime = new DockerWorkspaceRuntime({
  // stateDir: '~/.t3-code-runtime', defaultImage: 'alpine/git:latest',
  // defaultRepositoryPath: '/workspace/repo', containerNamePrefix: 't3ws',
});

const ws = await runtime.createWorkspace({
  workspaceId: 'feature-x',
  sourcePath: '/home/me/src/my-app', // read once, never mounted
  image: 'node:22-alpine', // any image with sh, git, tar, find, stat (BusyBox is fine)
});

// Files, search, git – all inside the container
const tree = await runtime.listDirectory(ws.id, '.');
const src = await runtime.readFile(ws.id, 'src/index.ts');
await runtime.writeFile(ws.id, 'src/index.ts', Buffer.from(src.toString().replace('foo', 'bar')));
const hits = await runtime.search(ws.id, { pattern: 'TODO', path: 'src' });
const status = await runtime.git(ws.id, ['status', '--porcelain']);

// Commands and terminals
const result = await runtime.exec(ws.id, 'pnpm', ['test'], { cwd: '.', timeoutMs: 600_000 });
const pty = await runtime.spawnPty(ws.id, { cols: 120, rows: 40 });
pty.onData((chunk) => process.stdout.write(chunk));
pty.write('ls -la\n');
await pty.resize(200, 50);

// File watching (container-side polling)
const watcher = await runtime.watch(ws.id, 'src', (events) => {
  for (const event of events) console.log(event.type, event.path, event.previousPath);
});
await watcher.close();

// Agent sessions
try {
  const lock = await runtime.acquireAgentLock(ws.id, { ownerId: 'agent-1' });
  const agent = await runtime.spawnPty(ws.id, { command: 'my-agent' });
  await agent.exited;
  await lock.release();
} catch (error) {
  if (error instanceof AgentLockHeldError) console.error(error.message, error.owner);
}

// Lifecycle
await runtime.stopWorkspace(ws.id); // container retained
await runtime.startWorkspace(ws.id); // same filesystem
await runtime.removeWorkspace(ws.id); // container + metadata gone
await runtime.dispose();
```

All errors thrown by the runtime extend `RuntimeError` and expose a stable `code`
(`WORKSPACE_NOT_FOUND`, `CONTAINER_NOT_RUNNING`, `CONTAINER_MISSING`, `FILE_NOT_FOUND`,
`IS_A_DIRECTORY`, `INVALID_PATH`, `AGENT_LOCK_HELD`, `IMPORT_FAILED`, `COMMAND_FAILED`,
`RUNTIME_UNAVAILABLE`, …). Paths passed to file operations are workspace-relative (or absolute
inside the repository root); anything escaping the root is rejected with `INVALID_PATH`.

## CLI

The CLI is a debugging and integration-test surface; the programmatic API is the primary
integration point.

```bash
pnpm build
alias t3-runtime="node $(pwd)/packages/runtime-docker/bin/runtime.js"

t3-runtime create demo --source ~/src/my-app            # git bundle import
t3-runtime create scratch --source ~/notes              # tar import
t3-runtime create empty                                 # empty repo inside the container
t3-runtime ls-workspaces
t3-runtime status demo
t3-runtime exec demo -- sh -c 'pwd && git log --oneline | head'
t3-runtime pty demo                                     # interactive shell
t3-runtime ls demo src
t3-runtime read demo README.md
echo 'hello' | t3-runtime write demo notes.txt
t3-runtime search demo TODO --path src
t3-runtime git demo -- status --porcelain
t3-runtime git demo -- diff
t3-runtime watch demo src                               # prints change events until Ctrl+C
t3-runtime agent-lock acquire demo --owner agent-1      # exit 3 if another agent holds it
t3-runtime agent-lock status demo
t3-runtime agent-lock release demo
t3-runtime stop demo
t3-runtime start demo
t3-runtime remove demo
```

Exit codes: `0` success, `1` runtime error, `2` usage error, `3` agent lock held. Use
`--state-dir <dir>` to point at a different metadata directory and `--json` for
machine-readable output.

## Prerequisites

- Node.js ≥ 22 and pnpm.
- Docker Engine reachable via the `docker` CLI and via the Engine API socket (default
  `unix:///var/run/docker.sock`, or `DOCKER_HOST` as `unix://…` / `tcp://…`). PTYs use the
  Engine API because interactive `docker exec` needs a hijacked stream.
- `git` and `tar` on the host (only used to read the source at import time).
- The workspace image must provide `sh`, `git`, `tar`, `find`, `stat`, `grep` (BusyBox is
  enough; `rg` is used when present). The default image is `alpine/git:latest`.

## Development

```bash
pnpm install
pnpm typecheck          # tsc over all packages and tests
pnpm lint               # eslint (strict, type-checked)
pnpm test               # unit tests (no Docker required)
pnpm test:integration   # Docker integration suite; skips with a message if Docker is unreachable
pnpm test:all
pnpm build              # emits packages/*/dist
```

The integration suite creates containers named `t3it<pid>-*` with the runtime label, uses a
temporary state directory and removes everything it created. `T3_RUNTIME_TEST_IMAGE`
overrides the image.

## Limitations

- **Polling watcher.** `watch()` snapshots the watched tree inside the container
  (`find … | stat`) once per interval (default 1 s) and diffs it. Renames are detected
  heuristically (same kind, size and mtime disappearing and appearing in the same tick);
  a same-size rewrite within the same second is missed; `.git` is not watched; very large
  trees cost one `docker exec` per tick. An inotify-based container-side watcher is the
  planned replacement.
- **PTY signals.** `PtyHandle.kill()` closes the hijacked stream (the process receives
  SIGHUP); arbitrary signals are not delivered.
- **Docker Engine API endpoints.** Unix sockets and plain `tcp://` are supported for PTYs;
  TLS-protected TCP endpoints and SSH contexts are not.
- **Single host.** Locks assume one host: staleness by PID only works for same-host
  owners; cross-host owners rely on heartbeats.
- **Import is one-way and one-time.** Uncommitted host changes are not imported for Git
  sources; there is no re-sync after creation.
- **No resource limits by default.** Pass `extraCreateArgs` (e.g. `['--memory', '2g']`).
- **BusyBox `stat` granularity.** Modification times are second-precise.
- Windows hosts are untested.

## Integrating with T3 Code (next step)

T3 Code should treat the runtime root — not a host path — as the workspace root:

```text
T3 Code file tree  → WorkspaceRuntime.listDirectory()
T3 Code editor     → readFile()/writeFile()
T3 Code terminal   → spawnPty()/exec()
T3 Code Git panel  → git()
T3 Code search     → search()
T3 Code watcher    → watch()
T3 Code agent      → acquireAgentLock() + spawnPty()
```

Proposed order:

1. Introduce a `WorkspaceRuntime` provider in the T3 Code server and route the file tree,
   editor and Git panel through it (`listDirectory`, `readFile`, `writeFile`, `stat`, `git`),
   keeping a local-host adapter for the existing behaviour.
2. Switch the terminal to `spawnPty()` with resize forwarding and the search panel to
   `search()`.
3. Replace host `fs.watch` usage with `watch()`.
4. Wrap agent launches in `acquireAgentLock()` and surface `AGENT_LOCK_HELD` in the UI
   with a "create another workspace" action.
5. Add a workspace picker driven by `listWorkspaces()`/`createWorkspace()`.

## Future SSH runtime

The protocol is transport-agnostic: `WorkspaceRuntime` has no Docker types, and all
`runtime-core` pieces (ids, path validation, metadata store, lifecycle, agent lock, argv
handling, error mapping) are reusable. An `SshWorkspaceRuntime` would implement the same
interface by executing the same container-side helper commands over an SSH channel, with
`RuntimeKind = 'ssh'` and `metadata.runtime = 'ssh'`. Nothing in T3 Code's integration
would need to change.
