import { spawn, type ChildProcess } from 'node:child_process';

import { RuntimeUnavailableError, TimeoutError } from '@t3-code/runtime-protocol';

export interface DockerCommandOptions {
  /** Data written to stdin; stdin is closed afterwards. */
  input?: Buffer | string;
  /** Kill the `docker` process after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra environment for the `docker` process (used for `docker exec -e NAME` pass-through). */
  env?: Record<string, string>;
  /** Reject when stdout exceeds this many bytes. Default: 256 MiB. */
  maxOutputBytes?: number;
}

export interface DockerCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

export interface DockerContainerState {
  Status: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
  Running: boolean;
  Paused: boolean;
  Pid: number;
  ExitCode: number;
  StartedAt: string;
  FinishedAt: string;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  State: DockerContainerState;
  Config: {
    Image: string;
    Labels: Record<string, string> | null;
    WorkingDir: string;
    Env: string[] | null;
  };
  Image: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Thin, argv-only wrapper around the `docker` binary. Arguments are passed to
 * `spawn` as an array — nothing is ever interpolated into a shell string.
 */
export class DockerCli {
  readonly binary: string;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: { binary?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.binary = options.binary ?? process.env['T3_CODE_RUNTIME_DOCKER'] ?? 'docker';
    this.baseEnv = options.env ?? process.env;
  }

  /** Spawn `docker <args>` and return the child for streaming use cases. */
  spawn(args: readonly string[], options: { env?: Record<string, string>; stdin?: 'pipe' | 'ignore' } = {}): ChildProcess {
    return spawn(this.binary, [...args], {
      env: { ...this.baseEnv, ...(options.env ?? {}) },
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  /** Run `docker <args>` to completion and collect its output. */
  async run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    const startedAt = Date.now();
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = this.spawn(args, { ...(options.env ? { env: options.env } : {}), stdin: 'pipe' });

    return new Promise<DockerCommandResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        child.kill('SIGKILL');
        finish(() => {
          reject(new TimeoutError(`docker ${args[0] ?? ''} aborted`));
        });
      };

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
      }
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBytes) {
          child.kill('SIGKILL');
          finish(() => {
            reject(new RuntimeUnavailableError(`docker ${args[0] ?? ''} produced more than ${maxBytes} bytes of output`));
          });
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.on('error', (error) => {
        finish(() => {
          if (isErrnoException(error) && error.code === 'ENOENT') {
            reject(
              new RuntimeUnavailableError(
                `The "${this.binary}" binary was not found. Install Docker or set T3_CODE_RUNTIME_DOCKER.`,
                { cause: error },
              ),
            );
            return;
          }
          reject(error);
        });
      });
      child.on('close', (code, signal) => {
        finish(() => {
          resolve({
            exitCode: code ?? (signal ? 128 + signalNumber(signal) : 1),
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            signal,
            timedOut,
            durationMs: Date.now() - startedAt,
          });
        });
      });

      if (child.stdin) {
        child.stdin.on('error', () => {
          /* the process may exit before consuming stdin (e.g. `docker exec true`) */
        });
        if (options.input !== undefined) {
          child.stdin.end(options.input);
        } else {
          child.stdin.end();
        }
      }
    });
  }

  /** Resolve with the daemon's server version or reject with {@link RuntimeUnavailableError}. */
  async serverVersion(): Promise<string> {
    const result = await this.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      throw new RuntimeUnavailableError(`Docker daemon is not reachable: ${result.stderr.toString('utf8').trim()}`);
    }
    return result.stdout.toString('utf8').trim();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.serverVersion();
      return true;
    } catch {
      return false;
    }
  }

  /** `docker inspect --type container`; returns `null` when the container does not exist. */
  async inspectContainer(nameOrId: string): Promise<DockerContainerInspect | null> {
    const result = await this.run(['inspect', '--type', 'container', '--', nameOrId], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8');
      if (/No such (container|object)/i.test(stderr)) return null;
      throw mapDockerStderr(stderr, ['inspect', nameOrId]);
    }
    const parsed: unknown = JSON.parse(result.stdout.toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed[0] as DockerContainerInspect;
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.run(['image', 'inspect', '--', image], { timeoutMs: 30_000 });
    if (result.exitCode === 0) return true;
    const stderr = result.stderr.toString('utf8');
    if (/No such image/i.test(stderr)) return false;
    throw mapDockerStderr(stderr, ['image', 'inspect', image]);
  }

  async pullImage(image: string, timeoutMs = 10 * 60_000): Promise<void> {
    const result = await this.run(['pull', '--quiet', '--', image], { timeoutMs });
    if (result.exitCode !== 0) {
      throw mapDockerStderr(result.stderr.toString('utf8'), ['pull', image]);
    }
  }
}

/** Map well-known Docker CLI error output to runtime errors. */
export function mapDockerStderr(stderr: string, argv: readonly string[]): Error {
  const text = stderr.trim();
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|permission denied while trying to connect/i.test(text)) {
    return new RuntimeUnavailableError(`Docker daemon is not reachable: ${text}`);
  }
  return new RuntimeUnavailableError(`docker ${argv.join(' ')} failed: ${text}`);
}

export function isNoSuchContainer(stderr: string): boolean {
  return /No such container/i.test(stderr);
}

export function isContainerNotRunning(stderr: string): boolean {
  return /is not running|container .* is (paused|restarting)/i.test(stderr);
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 0;
}
