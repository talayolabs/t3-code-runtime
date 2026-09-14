import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentLockHeldError,
  AgentLockNotOwnedError,
  InvalidArgumentError,
  type AcquireAgentLockOptions,
  type AgentLockHandle,
  type AgentLockOwner,
  type AgentLockStatus,
} from '@t3-code/runtime-protocol';

import { assertWorkspaceId } from './workspace-identity.js';

export const DEFAULT_LOCK_STALE_AFTER_MS = 5 * 60_000;
const MAX_ACQUIRE_ATTEMPTS = 16;
const RECLAIM_MUTEX_STALE_MS = 10_000;
const INCOMPLETE_LOCK_GRACE_MS = 2_000;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseAgentLockOwner(raw: unknown): AgentLockOwner | null {
  if (!isRecord(raw)) return null;
  const { ownerId, token, pid, hostname, acquiredAt, heartbeatAt, staleAfterMs } = raw;
  if (
    typeof ownerId !== 'string' ||
    typeof token !== 'string' ||
    typeof pid !== 'number' ||
    typeof hostname !== 'string' ||
    typeof acquiredAt !== 'string' ||
    typeof heartbeatAt !== 'string' ||
    typeof staleAfterMs !== 'number'
  ) {
    return null;
  }
  return { ownerId, token, pid, hostname, acquiredAt, heartbeatAt, staleAfterMs };
}

/**
 * A lock is stale when its owner process is provably dead (same host, pid
 * gone) or when its heartbeat is older than the owner's own threshold.
 */
export function isAgentLockStale(
  owner: AgentLockOwner,
  now: number = Date.now(),
  hostname: string = os.hostname(),
): boolean {
  if (owner.hostname === hostname && !isProcessAlive(owner.pid)) return true;
  if (owner.staleAfterMs > 0) {
    const heartbeat = Date.parse(owner.heartbeatAt);
    if (Number.isNaN(heartbeat) || now - heartbeat > owner.staleAfterMs) return true;
  }
  return false;
}

export interface AgentLockManagerOptions {
  /** Maps a workspace id to the absolute path of its lock file. */
  lockPathFor: (workspaceId: string) => string;
  hostname?: string;
  pid?: number;
  now?: () => number;
}

/**
 * Durable one-agent-per-workspace lock backed by an exclusive-create lock
 * file.
 *
 * - Acquisition relies on `O_EXCL`, which the OS guarantees to be atomic, so
 *   concurrent attempts (promises, processes, restarts) resolve to exactly
 *   one owner.
 * - Stale locks (dead pid on this host, or heartbeat older than the owner's
 *   `staleAfterMs`) are reclaimed under a short-lived reclaim mutex so two
 *   reclaimers cannot delete each other's freshly created lock.
 * - Heartbeats are written in place through the already open descriptor so a
 *   heartbeat can never overwrite a lock that was reclaimed by someone else.
 *
 * Terminal sessions do not go through this lock; only agent sessions do.
 */
export class AgentLockManager {
  private readonly lockPathFor: (workspaceId: string) => string;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly now: () => number;

  constructor(options: AgentLockManagerOptions) {
    this.lockPathFor = options.lockPathFor;
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
  }

  async acquire(workspaceId: string, options: AcquireAgentLockOptions = {}): Promise<AgentLockHandle> {
    assertWorkspaceId(workspaceId);
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new InvalidArgumentError('staleAfterMs must be a non-negative number');
    }
    const reclaimStale = options.reclaimStale ?? true;
    const lockPath = this.lockPathFor(workspaceId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    let lastSeen: AgentLockOwner | null = null;
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const owner = this.newOwner(options, staleAfterMs);
      if (await this.tryCreate(lockPath, owner)) {
        return this.createHandle(workspaceId, lockPath, owner, options.heartbeatIntervalMs);
      }

      const existing = await this.readOwner(lockPath);
      if (existing === null) {
        await this.reclaimIncomplete(lockPath);
        continue;
      }
      lastSeen = existing;
      if (!reclaimStale || !isAgentLockStale(existing, this.now(), this.hostname)) {
        throw new AgentLockHeldError(workspaceId, existing);
      }
      await this.reclaimStale(lockPath, existing.token);
    }
    throw new AgentLockHeldError(workspaceId, lastSeen ?? unknownOwner(this.now()));
  }

  async inspect(workspaceId: string): Promise<AgentLockStatus> {
    assertWorkspaceId(workspaceId);
    const owner = await this.readOwner(this.lockPathFor(workspaceId));
    if (owner === null) return { workspaceId, locked: false, owner: null, stale: false };
    return { workspaceId, locked: true, owner, stale: isAgentLockStale(owner, this.now(), this.hostname) };
  }

  /** Remove the lock regardless of who owns it. Idempotent. */
  async forceRelease(workspaceId: string): Promise<void> {
    assertWorkspaceId(workspaceId);
    await fs.rm(this.lockPathFor(workspaceId), { force: true });
  }

  private newOwner(options: AcquireAgentLockOptions, staleAfterMs: number): AgentLockOwner {
    const nowIso = new Date(this.now()).toISOString();
    const pid = options.ownerPid ?? this.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new InvalidArgumentError('ownerPid must be a positive integer');
    }
    return {
      ownerId: options.ownerId ?? `${pid}@${this.hostname}`,
      token: randomBytes(16).toString('hex'),
      pid,
      hostname: this.hostname,
      acquiredAt: nowIso,
      heartbeatAt: nowIso,
      staleAfterMs,
    };
  }

  private createHandle(
    workspaceId: string,
    lockPath: string,
    initialOwner: AgentLockOwner,
    heartbeatIntervalMs: number | undefined,
  ): AgentLockHandle {
    let owner = initialOwner;
    let released = false;
    let timer: NodeJS.Timeout | null = null;

    const stopTimer = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const heartbeat = async (): Promise<void> => {
      if (released) throw new AgentLockNotOwnedError(workspaceId);
      const next = { ...owner, heartbeatAt: new Date(this.now()).toISOString() };
      const written = await this.writeInPlaceIfOwned(lockPath, owner.token, next);
      if (!written) {
        stopTimer();
        throw new AgentLockNotOwnedError(workspaceId);
      }
      owner = next;
      handle.owner = owner;
    };

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      stopTimer();
      const current = await this.readOwner(lockPath);
      // Only delete a lock we still own; a reclaimed lock belongs to somebody else.
      if (current !== null && current.token === owner.token) {
        await fs.rm(lockPath, { force: true });
      }
    };

    const handle: { -readonly [K in keyof AgentLockHandle]: AgentLockHandle[K] } = {
      workspaceId,
      owner,
      heartbeat,
      release,
    };

    const interval =
      heartbeatIntervalMs ?? (owner.staleAfterMs > 0 ? Math.max(1_000, Math.floor(owner.staleAfterMs / 3)) : 0);
    if (interval > 0) {
      timer = setInterval(() => {
        heartbeat().catch(stopTimer);
      }, interval);
      timer.unref();
    }
    return handle;
  }

  private async tryCreate(lockPath: string, owner: AgentLockOwner): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'EEXIST') return false;
      throw error;
    }
    try {
      await handle.writeFile(serializeOwner(owner), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  }

  private async readOwner(lockPath: string): Promise<AgentLockOwner | null> {
    let content: string;
    try {
      content = await fs.readFile(lockPath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    }
    return parseOwnerContent(content);
  }

  /** Rewrite the lock through one descriptor, only if it still carries `token`. */
  private async writeInPlaceIfOwned(lockPath: string, token: string, next: AgentLockOwner): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, 'r+');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      const current = parseOwnerContent(await handle.readFile('utf8'));
      if (current?.token !== token) return false;
      await handle.truncate(0);
      await handle.write(serializeOwner(next), 0, 'utf8');
      return true;
    } finally {
      await handle.close();
    }
  }

  /**
   * Run `action` while holding the reclaim mutex (`<lock>.reclaim`). The mutex
   * itself is an `O_EXCL` file; if it is abandoned for longer than
   * {@link RECLAIM_MUTEX_STALE_MS} it is removed by the next reclaimer.
   */
  private async withReclaimMutex(lockPath: string, action: () => Promise<void>): Promise<void> {
    const mutexPath = `${lockPath}.reclaim`;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(mutexPath, 'wx', 0o600);
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'EEXIST')) throw error;
      try {
        const stat = await fs.stat(mutexPath);
        if (this.now() - stat.mtimeMs > RECLAIM_MUTEX_STALE_MS) {
          await fs.rm(mutexPath, { force: true });
        }
      } catch (statError) {
        if (!(isErrnoException(statError) && statError.code === 'ENOENT')) throw statError;
      }
      await sleep(10 + Math.floor(Math.random() * 40));
      return;
    }
    try {
      await handle.close();
      await action();
    } finally {
      await fs.rm(mutexPath, { force: true });
    }
  }

  /** Delete the lock if it still holds the stale `expectedToken`. */
  private async reclaimStale(lockPath: string, expectedToken: string): Promise<void> {
    await this.withReclaimMutex(lockPath, async () => {
      const current = await this.readOwner(lockPath);
      if (current !== null && current.token === expectedToken && isAgentLockStale(current, this.now(), this.hostname)) {
        await fs.rm(lockPath, { force: true });
      }
    });
  }

  /** Delete an empty or corrupt lock file once its writer had a fair chance to finish. */
  private async reclaimIncomplete(lockPath: string): Promise<void> {
    await this.withReclaimMutex(lockPath, async () => {
      let stat;
      try {
        stat = await fs.stat(lockPath);
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return;
        throw error;
      }
      if (this.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
        await sleep(25);
        return;
      }
      if ((await this.readOwner(lockPath)) === null) {
        await fs.rm(lockPath, { force: true });
      }
    });
  }
}

function serializeOwner(owner: AgentLockOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

function parseOwnerContent(content: string): AgentLockOwner | null {
  if (content.trim().length === 0) return null;
  try {
    return parseAgentLockOwner(JSON.parse(content));
  } catch {
    return null;
  }
}

function unknownOwner(now: number): AgentLockOwner {
  const iso = new Date(now).toISOString();
  return { ownerId: 'unknown', token: '', pid: 0, hostname: '', acquiredAt: iso, heartbeatAt: iso, staleAfterMs: 0 };
}
