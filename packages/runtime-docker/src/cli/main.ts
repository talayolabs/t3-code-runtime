import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { splitAtDoubleDash, toError } from '@t3-code/runtime-core';
import { AgentLockHeldError, isRuntimeError, type CreateWorkspaceOptions } from '@t3-code/runtime-protocol';

import { DockerWorkspaceRuntime, type DockerWorkspaceRuntimeOptions } from '../docker-workspace-runtime.js';

export const USAGE = `t3-runtime — Docker workspace runtime for T3 Code

Usage:
  t3-runtime create <workspace> [--source <dir>] [--image <image>] [--repo-path <path>]
                    [--branch <name>] [--import git-bundle|tar] [--no-start]
  t3-runtime ls-workspaces
  t3-runtime status <workspace>
  t3-runtime start <workspace>
  t3-runtime stop <workspace>
  t3-runtime remove <workspace>
  t3-runtime exec <workspace> [--cwd <path>] -- <command> [args...]
  t3-runtime pty <workspace> [-- <command> [args...]]
  t3-runtime ls <workspace> <path>
  t3-runtime read <workspace> <path>
  t3-runtime write <workspace> <path> [--from <host-file>]   (reads stdin by default)
  t3-runtime search <workspace> <pattern> [--path <dir>] [--fixed] [--ignore-case]
  t3-runtime git <workspace> -- <git args...>
  t3-runtime watch <workspace> <path>
  t3-runtime agent-lock acquire <workspace> [--owner <id>] [--hold]
                    (without --hold the lock is owned by the calling process until released)
  t3-runtime agent-lock release <workspace>
  t3-runtime agent-lock status <workspace>

Global options:
  --state-dir <dir>   Metadata directory (default: $T3_CODE_RUNTIME_HOME or ~/.t3-code-runtime)
  --json              Print machine readable output where applicable
  -h, --help          Show this help
`;

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
}

interface ParsedFlags {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  'source',
  'image',
  'repo-path',
  'branch',
  'import',
  'cwd',
  'from',
  'path',
  'owner',
  'state-dir',
  'interval',
]);

export function parseFlags(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') {
      flags.set('help', true);
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) {
        flags.set(name, arg.slice(eq + 1));
      } else if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${name} requires a value`);
        flags.set(name, value);
        i += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function flagString(flags: ParsedFlags['flags'], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function requirePositional(positional: string[], index: number, name: string): string {
  const value = positional[index];
  if (value === undefined) throw new Error(`missing <${name}>`);
  return value;
}

/** Run the CLI; resolves with the process exit code. */
export async function main(argv: readonly string[], io: CliIo = process, runtimeOptions: DockerWorkspaceRuntimeOptions = {}): Promise<number> {
  const { before, after } = splitAtDoubleDash(argv);
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(before);
  } catch (error) {
    io.stderr.write(`${toError(error).message}\n`);
    return 2;
  }
  const { positional, flags } = parsed;
  const command = positional[0];
  if (command === undefined || flags.has('help')) {
    io.stdout.write(USAGE);
    return command === undefined && !flags.has('help') ? 2 : 0;
  }

  const stateDir = flagString(flags, 'state-dir');
  const runtime = new DockerWorkspaceRuntime({ ...runtimeOptions, ...(stateDir !== undefined ? { stateDir } : {}) });
  const json = flags.has('json');
  const print = (value: unknown): void => {
    io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };

  try {
    switch (command) {
      case 'create': {
        const workspaceId = requirePositional(positional, 1, 'workspace');
        const importFlag = flagString(flags, 'import');
        if (importFlag !== undefined && importFlag !== 'git-bundle' && importFlag !== 'tar') {
          throw new Error('--import must be git-bundle or tar');
        }
        const options: CreateWorkspaceOptions = {
          workspaceId,
          start: !flags.has('no-start'),
          reuseExisting: !flags.has('no-reuse'),
        };
        const source = flagString(flags, 'source');
        if (source !== undefined) options.sourcePath = source;
        const image = flagString(flags, 'image');
        if (image !== undefined) options.image = image;
        const repoPath = flagString(flags, 'repo-path');
        if (repoPath !== undefined) options.repositoryPath = repoPath;
        const branch = flagString(flags, 'branch');
        if (branch !== undefined) options.branch = branch;
        if (importFlag !== undefined) options.importMode = importFlag;
        const workspace = await runtime.createWorkspace(options);
        if (json) print(workspace);
        else io.stdout.write(`${workspace.id}\t${workspace.status}\t${workspace.metadata.containerName}\n`);
        return 0;
      }
      case 'ls-workspaces': {
        const workspaces = await runtime.listWorkspaces();
        if (json) print(workspaces);
        else for (const ws of workspaces) io.stdout.write(`${ws.id}\t${ws.status}\t${ws.metadata.containerName}\n`);
        return 0;
      }
      case 'status': {
        const workspace = await runtime.getWorkspace(requirePositional(positional, 1, 'workspace'));
        if (json) print(workspace);
        else io.stdout.write(`${workspace.id}\t${workspace.status}\t${workspace.metadata.containerName}\n`);
        return 0;
      }
      case 'start':
        await runtime.startWorkspace(requirePositional(positional, 1, 'workspace'));
        return 0;
      case 'stop':
        await runtime.stopWorkspace(requirePositional(positional, 1, 'workspace'));
        return 0;
      case 'remove':
        await runtime.removeWorkspace(requirePositional(positional, 1, 'workspace'));
        return 0;
      case 'exec': {
        const workspaceId = requirePositional(positional, 1, 'workspace');
        if (after === null || after.length === 0) throw new Error('exec requires `-- <command> [args...]`');
        const [program, ...args] = after;
        const cwd = flagString(flags, 'cwd');
        const result = await runtime.exec(workspaceId, program ?? '', args, cwd !== undefined ? { cwd } : {});
        io.stdout.write(result.stdout);
        io.stderr.write(result.stderr);
        return result.exitCode;
      }
      case 'git': {
        const workspaceId = requirePositional(positional, 1, 'workspace');
        if (after === null) throw new Error('git requires `-- <git args...>`');
        const result = await runtime.git(workspaceId, after);
        io.stdout.write(result.stdout);
        io.stderr.write(result.stderr);
        return result.exitCode;
      }
      case 'ls': {
        const entries = await runtime.listDirectory(
          requirePositional(positional, 1, 'workspace'),
          positional[2] ?? '.',
        );
        if (json) print(entries);
        else for (const entry of entries) io.stdout.write(`${entry.kind.padEnd(9)} ${String(entry.size).padStart(10)} ${entry.name}\n`);
        return 0;
      }
      case 'read': {
        const data = await runtime.readFile(requirePositional(positional, 1, 'workspace'), requirePositional(positional, 2, 'path'));
        io.stdout.write(data);
        return 0;
      }
      case 'write': {
        const from = flagString(flags, 'from');
        const data = from !== undefined ? await readFile(from) : await readAll(io.stdin);
        await runtime.writeFile(requirePositional(positional, 1, 'workspace'), requirePositional(positional, 2, 'path'), data);
        return 0;
      }
      case 'search': {
        const searchPath = flagString(flags, 'path');
        const results = await runtime.search(requirePositional(positional, 1, 'workspace'), {
          pattern: requirePositional(positional, 2, 'pattern'),
          fixedString: flags.has('fixed'),
          caseSensitive: !flags.has('ignore-case'),
          ...(searchPath !== undefined ? { path: searchPath } : {}),
        });
        if (json) print(results);
        else for (const hit of results) io.stdout.write(`${hit.path}:${String(hit.line)}:${hit.text}\n`);
        return 0;
      }
      case 'pty': {
        return await runPty(runtime, requirePositional(positional, 1, 'workspace'), after ?? [], io);
      }
      case 'watch': {
        const workspaceId = requirePositional(positional, 1, 'workspace');
        const handle = await runtime.watch(workspaceId, positional[2] ?? '.', (events) => {
          for (const event of events) io.stdout.write(`${JSON.stringify(event)}\n`);
        });
        io.stderr.write(`watching ${workspaceId}:${handle.path} (${handle.strategy}); press Ctrl+C to stop\n`);
        await new Promise<void>((resolve) => {
          handle.onClose(() => {
            resolve();
          });
          process.once('SIGINT', () => {
            void handle.close();
          });
        });
        return 0;
      }
      case 'agent-lock': {
        const action = requirePositional(positional, 1, 'acquire|release|status');
        const workspaceId = requirePositional(positional, 2, 'workspace');
        if (action === 'acquire') {
          const owner = flagString(flags, 'owner');
          const hold = flags.has('hold');
          // Without --hold this process exits immediately, so the lock is attributed to the
          // invoking process (shell, agent) and stays valid for as long as that process lives.
          const handle = await runtime.acquireAgentLock(workspaceId, {
            ...(owner !== undefined ? { ownerId: owner } : {}),
            ...(hold ? {} : { ownerPid: process.ppid, heartbeatIntervalMs: 0, staleAfterMs: 0 }),
          });
          print(handle.owner);
          if (hold) {
            io.stderr.write('holding agent lock; press Ctrl+C to release\n');
            await new Promise<void>((resolve) => {
              process.once('SIGINT', () => {
                resolve();
              });
            });
            await handle.release();
          }
          return 0;
        }
        if (action === 'release') {
          await runtime.forceReleaseAgentLock(workspaceId);
          return 0;
        }
        if (action === 'status') {
          print(await runtime.inspectAgentLock(workspaceId));
          return 0;
        }
        throw new Error(`unknown agent-lock action "${action}"`);
      }
      default:
        io.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    const err = toError(error);
    if (isRuntimeError(err)) {
      io.stderr.write(`${err.code}: ${err.message}\n`);
      if (err instanceof AgentLockHeldError && json) print(err.owner);
      return err instanceof AgentLockHeldError ? 3 : 1;
    }
    // Non-runtime errors at this point are argument/usage mistakes.
    io.stderr.write(`error: ${err.message}\n`);
    return 2;
  } finally {
    await runtime.dispose();
  }
}

async function runPty(runtime: DockerWorkspaceRuntime, workspaceId: string, argv: string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  const stdin = io.stdin as NodeJS.ReadStream;
  const stdout = io.stdout as NodeJS.WriteStream;
  const handle = await runtime.spawnPty(workspaceId, {
    ...(command !== undefined ? { command, args } : {}),
    ...(stdout.columns !== undefined ? { cols: stdout.columns, rows: stdout.rows } : {}),
  });
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  const onInput = (chunk: Buffer): void => {
    handle.write(chunk);
  };
  const onResize = (): void => {
    void handle.resize(stdout.columns, stdout.rows);
  };
  stdin.on('data', onInput);
  stdout.on('resize', onResize);
  handle.onData((chunk) => {
    stdout.write(chunk);
  });
  const exit = await handle.exited;
  stdin.off('data', onInput);
  stdout.off('resize', onResize);
  if (stdin.isTTY) stdin.setRawMode(wasRaw);
  stdin.pause();
  return exit.exitCode ?? 1;
}
