import http from 'node:http';
import type { Duplex } from 'node:stream';

import { RuntimeUnavailableError } from '@t3-code/runtime-protocol';

export interface DockerEngineApiOptions {
  /** `unix:///var/run/docker.sock`, `tcp://host:2375`, or a bare socket path. Defaults to `$DOCKER_HOST`. */
  host?: string;
  /** API version prefix, e.g. `v1.44`. Omitted by default (daemon negotiates). */
  apiVersion?: string;
  requestTimeoutMs?: number;
}

export interface ExecCreateRequest {
  Cmd: string[];
  Tty: boolean;
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  WorkingDir?: string;
  Env?: string[];
  User?: string;
  ConsoleSize?: [number, number];
}

export interface ExecInspectResponse {
  ID: string;
  Running: boolean;
  ExitCode: number | null;
  Pid: number;
  ContainerID: string;
}

interface Endpoint {
  socketPath?: string;
  host?: string;
  port?: number;
}

function parseHost(raw: string | undefined): Endpoint {
  const value = raw && raw.length > 0 ? raw : 'unix:///var/run/docker.sock';
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  if (value.startsWith('/')) return { socketPath: value };
  if (value.startsWith('tcp://') || value.startsWith('http://')) {
    const url = new URL(value.replace(/^tcp:/, 'http:'));
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new RuntimeUnavailableError(
    `Unsupported DOCKER_HOST "${value}". Only unix:// sockets and plain tcp:// endpoints are supported for PTY sessions.`,
  );
}

/**
 * Minimal Docker Engine API client used for the features the CLI cannot
 * offer without a host TTY: creating an exec with `Tty: true`, hijacking its
 * stream, resizing it and reading its exit code.
 */
export class DockerEngineApi {
  private readonly endpoint: Endpoint;
  private readonly prefix: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DockerEngineApiOptions = {}) {
    this.endpoint = parseHost(options.host ?? process.env['DOCKER_HOST']);
    this.prefix = options.apiVersion ? `/${options.apiVersion}` : '';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async ping(): Promise<void> {
    await this.request('GET', '/_ping');
  }

  async createExec(containerId: string, body: ExecCreateRequest): Promise<string> {
    const response = await this.request<{ Id: string }>(
      'POST',
      `/containers/${encodeURIComponent(containerId)}/exec`,
      body,
    );
    return response.Id;
  }

  async inspectExec(execId: string): Promise<ExecInspectResponse> {
    return this.request<ExecInspectResponse>('GET', `/exec/${encodeURIComponent(execId)}/json`);
  }

  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    const h = Math.max(1, Math.floor(rows));
    const w = Math.max(1, Math.floor(cols));
    await this.request('POST', `/exec/${encodeURIComponent(execId)}/resize?h=${h}&w=${w}`);
  }

  /**
   * Start an exec and hijack the connection. The returned duplex carries the
   * raw PTY byte stream in both directions (no multiplexing when `Tty` is set).
   */
  startExecHijacked(execId: string, tty: boolean): Promise<Duplex> {
    const payload = JSON.stringify({ Detach: false, Tty: tty });
    return new Promise<Duplex>((resolve, reject) => {
      const request = http.request({
        ...this.endpoint,
        method: 'POST',
        path: `${this.prefix}/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      });
      request.once('upgrade', (_response, socket, head) => {
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.once('response', (response) => {
        // Daemon refused to upgrade: read the error body.
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          reject(
            new RuntimeUnavailableError(
              `docker exec start did not upgrade the connection (HTTP ${response.statusCode ?? '?'}): ${text}`,
            ),
          );
        });
      });
      request.once('error', (error) => {
        reject(wrapConnectionError(error, this.endpoint));
      });
      request.end(payload);
    });
  }

  private request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        {
          ...this.endpoint,
          method,
          path: `${this.prefix}${path}`,
          headers: {
            'Content-Type': 'application/json',
            ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: this.requestTimeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new RuntimeUnavailableError(`Docker Engine API ${method} ${path} failed (HTTP ${status}): ${text.trim()}`));
              return;
            }
            if (text.length === 0) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              resolve(text as T);
            }
          });
        },
      );
      request.once('timeout', () => {
        request.destroy(new Error(`Docker Engine API ${method} ${path} timed out`));
      });
      request.once('error', (error) => {
        reject(wrapConnectionError(error, this.endpoint));
      });
      request.end(payload);
    });
  }
}

function wrapConnectionError(error: Error, endpoint: Endpoint): Error {
  const where = endpoint.socketPath ?? `${endpoint.host ?? ''}:${endpoint.port ?? ''}`;
  return new RuntimeUnavailableError(`Cannot reach the Docker Engine API at ${where}: ${error.message}`, { cause: error });
}
