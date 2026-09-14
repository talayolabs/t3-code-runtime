import type { Duplex } from 'node:stream';

import type { PtyExit, PtyHandle } from '@t3-code/runtime-protocol';

import type { DockerEngineApi } from './docker-engine-api.js';

const EXIT_POLL_INTERVAL_MS = 100;
const EXIT_POLL_MAX_MS = 5_000;

/**
 * PTY session backed by a hijacked `docker exec` stream with `Tty: true`.
 *
 * Killing: the Engine API has no "signal this exec" endpoint. `kill()` closes
 * the hijacked connection, which closes the PTY master inside the container
 * and delivers `SIGHUP` to the foreground process group. Callers that need a
 * specific signal should send it from within the container (e.g. via
 * `exec(workspaceId, 'kill', ...)`).
 */
export class DockerPtyHandle implements PtyHandle {
  readonly id: string;
  readonly pid: number | null;
  readonly exited: Promise<PtyExit>;

  private readonly stream: Duplex;
  private readonly api: DockerEngineApi;
  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(exit: PtyExit) => void>();
  private resolveExit!: (exit: PtyExit) => void;
  private settled = false;

  constructor(id: string, pid: number | null, stream: Duplex, api: DockerEngineApi) {
    this.id = id;
    this.pid = pid;
    this.stream = stream;
    this.api = api;
    this.exited = new Promise<PtyExit>((resolve) => {
      this.resolveExit = resolve;
    });

    stream.on('data', (chunk: Buffer) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    const onDone = (): void => {
      void this.settle();
    };
    stream.once('end', onDone);
    stream.once('close', onDone);
    stream.once('error', onDone);
  }

  write(data: Buffer | string): void {
    if (this.settled || this.stream.destroyed) return;
    this.stream.write(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.settled) return;
    await this.api.resizeExec(this.id, cols, rows);
  }

  onData(listener: (chunk: Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async kill(_signal?: NodeJS.Signals): Promise<void> {
    if (!this.stream.destroyed) this.stream.destroy();
    await this.exited;
  }

  private async settle(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    if (!this.stream.destroyed) this.stream.destroy();

    let exitCode: number | null = null;
    const deadline = Date.now() + EXIT_POLL_MAX_MS;
    while (Date.now() < deadline) {
      try {
        const info = await this.api.inspectExec(this.id);
        if (!info.Running) {
          exitCode = info.ExitCode;
          break;
        }
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_INTERVAL_MS));
    }
    const exit: PtyExit = { exitCode, signal: exitCode === null ? 'SIGHUP' : null };
    for (const listener of this.exitListeners) listener(exit);
    this.resolveExit(exit);
  }
}
