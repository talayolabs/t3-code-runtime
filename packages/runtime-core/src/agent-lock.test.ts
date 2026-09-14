import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_LOCK_HELD_MESSAGE,
  AgentLockHeldError,
  AgentLockNotOwnedError,
  InvalidArgumentError,
  type AgentLockHandle,
  type AgentLockOwner,
} from '@t3-code/runtime-protocol';

import { AgentLockManager, isAgentLockStale, isProcessAlive, parseAgentLockOwner } from './agent-lock.js';

const WS = 'demo';

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('failed to spawn helper');
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  return pid;
}

async function settle<T>(promises: Promise<T>[]): Promise<{ fulfilled: T[]; rejected: unknown[] }> {
  const results = await Promise.allSettled(promises);
  return {
    fulfilled: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    rejected: results.flatMap((r): unknown[] => (r.status === 'rejected' ? [r.reason] : [])),
  };
}

describe('AgentLockManager', () => {
  let dir: string;
  let manager: AgentLockManager;
  const handles: AgentLockHandle[] = [];

  const newManager = (options: { hostname?: string; pid?: number } = {}): AgentLockManager =>
    new AgentLockManager({ lockPathFor: (id) => path.join(dir, id, 'agent.lock'), ...options });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-lock-'));
    manager = newManager();
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.release()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('acquires when nobody owns the workspace and records the owner', async () => {
    const handle = await manager.acquire(WS, { ownerId: 'agent-1', heartbeatIntervalMs: 0 });
    handles.push(handle);
    expect(handle.workspaceId).toBe(WS);
    expect(handle.owner.ownerId).toBe('agent-1');
    expect(handle.owner.pid).toBe(process.pid);
    expect(handle.owner.hostname).toBe(os.hostname());

    const status = await manager.inspect(WS);
    expect(status).toMatchObject({ workspaceId: WS, locked: true, stale: false });
    expect(status.owner?.token).toBe(handle.owner.token);
  });

  it('fails a second acquisition with the existing owner information', async () => {
    const first = await manager.acquire(WS, { ownerId: 'agent-1', heartbeatIntervalMs: 0 });
    handles.push(first);
    try {
      await manager.acquire(WS, { ownerId: 'agent-2', heartbeatIntervalMs: 0 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLockHeldError);
      const held = error as AgentLockHeldError;
      expect(held.code).toBe('AGENT_LOCK_HELD');
      expect(held.workspaceId).toBe(WS);
      expect(held.owner.ownerId).toBe('agent-1');
      expect(held.owner.token).toBe(first.owner.token);
      expect(held.message.startsWith(AGENT_LOCK_HELD_MESSAGE)).toBe(true);
      expect(held.message).toContain('This workspace already has an active agent session.');
      expect(held.message).toContain('Create another workspace to run a second agent.');
    }
  });

  it('does not block other workspaces', async () => {
    handles.push(await manager.acquire('one', { heartbeatIntervalMs: 0 }));
    handles.push(await manager.acquire('two', { heartbeatIntervalMs: 0 }));
    expect((await manager.inspect('one')).locked).toBe(true);
    expect((await manager.inspect('two')).locked).toBe(true);
  });

  it('release is idempotent and frees the workspace', async () => {
    const handle = await manager.acquire(WS, { heartbeatIntervalMs: 0 });
    await handle.release();
    await handle.release();
    expect((await manager.inspect(WS)).locked).toBe(false);
    await expect(handle.heartbeat()).rejects.toBeInstanceOf(AgentLockNotOwnedError);

    const again = await manager.acquire(WS, { heartbeatIntervalMs: 0 });
    handles.push(again);
    expect(again.owner.token).not.toBe(handle.owner.token);
  });

  it('survives a runtime restart', async () => {
    const handle = await manager.acquire(WS, { ownerId: 'survivor', heartbeatIntervalMs: 0 });
    handles.push(handle);

    const restarted = newManager();
    const status = await restarted.inspect(WS);
    expect(status.locked).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.owner?.ownerId).toBe('survivor');
    await expect(restarted.acquire(WS, { heartbeatIntervalMs: 0 })).rejects.toBeInstanceOf(AgentLockHeldError);
  });

  it('reclaims a lock whose owner process died on this host', async () => {
    const pid = await deadPid();
    expect(isProcessAlive(pid)).toBe(false);
    const orphan = await manager.acquire(WS, { ownerId: 'crashed', ownerPid: pid, heartbeatIntervalMs: 0 });

    const status = await manager.inspect(WS);
    expect(status).toMatchObject({ locked: true, stale: true });

    const reclaimed = await manager.acquire(WS, { ownerId: 'fresh', heartbeatIntervalMs: 0 });
    handles.push(reclaimed);
    expect(reclaimed.owner.ownerId).toBe('fresh');
    expect((await manager.inspect(WS)).owner?.ownerId).toBe('fresh');

    // The orphan handle must not be able to touch the lock it lost.
    await expect(orphan.heartbeat()).rejects.toBeInstanceOf(AgentLockNotOwnedError);
    await orphan.release();
    expect((await manager.inspect(WS)).owner?.token).toBe(reclaimed.owner.token);
  });

  it('reclaims a lock whose heartbeat expired (owner on another host)', async () => {
    const remote = newManager({ hostname: 'other-host', pid: 4242 });
    const stale = await remote.acquire(WS, { ownerId: 'remote', staleAfterMs: 50, heartbeatIntervalMs: 0 });
    expect((await manager.inspect(WS)).stale).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await manager.inspect(WS)).stale).toBe(true);

    const fresh = await manager.acquire(WS, { ownerId: 'local', heartbeatIntervalMs: 0 });
    handles.push(fresh);
    expect((await manager.inspect(WS)).owner?.ownerId).toBe('local');
    await expect(stale.heartbeat()).rejects.toBeInstanceOf(AgentLockNotOwnedError);
  });

  it('keeps a lock alive through heartbeats', async () => {
    const remote = newManager({ hostname: 'other-host', pid: 4242 });
    const handle = await remote.acquire(WS, { staleAfterMs: 80, heartbeatIntervalMs: 20 });
    handles.push(handle);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await manager.inspect(WS);
    expect(status.stale).toBe(false);
    expect(Date.parse(status.owner?.heartbeatAt ?? '')).toBeGreaterThan(Date.parse(handle.owner.acquiredAt));
  });

  it('can refuse to reclaim stale locks', async () => {
    const pid = await deadPid();
    await manager.acquire(WS, { ownerId: 'crashed', ownerPid: pid, heartbeatIntervalMs: 0 });
    await expect(manager.acquire(WS, { reclaimStale: false, heartbeatIntervalMs: 0 })).rejects.toBeInstanceOf(
      AgentLockHeldError,
    );
  });

  it('exactly one of many concurrent acquisitions wins', async () => {
    const attempts = Array.from({ length: 25 }, (_, i) =>
      manager.acquire(WS, { ownerId: `agent-${i}`, heartbeatIntervalMs: 0 }),
    );
    const { fulfilled, rejected } = await settle(attempts);
    handles.push(...fulfilled);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(24);
    for (const error of rejected) {
      expect(error).toBeInstanceOf(AgentLockHeldError);
      expect((error as AgentLockHeldError).owner.token).toBe(fulfilled[0]?.owner.token);
    }
  });

  it('exactly one of many concurrent reclaimers wins a stale lock', async () => {
    const pid = await deadPid();
    await manager.acquire(WS, { ownerId: 'crashed', ownerPid: pid, heartbeatIntervalMs: 0 });

    const attempts = Array.from({ length: 12 }, (_, i) =>
      newManager().acquire(WS, { ownerId: `reclaimer-${i}`, heartbeatIntervalMs: 0 }),
    );
    const { fulfilled, rejected } = await settle(attempts);
    handles.push(...fulfilled);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    expect((await manager.inspect(WS)).owner?.token).toBe(fulfilled[0]?.owner.token);
    for (const error of rejected) expect(error).toBeInstanceOf(AgentLockHeldError);
    expect(await fs.readdir(path.join(dir, WS))).toEqual(['agent.lock']);
  });

  it('recovers from an empty or corrupt lock file', async () => {
    const lockPath = path.join(dir, WS, 'agent.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'not json');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    expect((await manager.inspect(WS)).locked).toBe(false);

    const handle = await manager.acquire(WS, { heartbeatIntervalMs: 0 });
    handles.push(handle);
    expect((await manager.inspect(WS)).owner?.token).toBe(handle.owner.token);
  });

  it('force release removes any lock and is idempotent', async () => {
    handles.push(await manager.acquire(WS, { heartbeatIntervalMs: 0 }));
    await manager.forceRelease(WS);
    await manager.forceRelease(WS);
    expect((await manager.inspect(WS)).locked).toBe(false);
  });

  it('validates arguments', async () => {
    await expect(manager.acquire('Bad Id')).rejects.toThrow();
    await expect(manager.acquire(WS, { staleAfterMs: -1 })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(manager.acquire(WS, { ownerPid: 0 })).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('isAgentLockStale', () => {
  const now = Date.parse('2026-01-01T00:10:00.000Z');
  const base: AgentLockOwner = {
    ownerId: 'x',
    token: 't',
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:09:59.000Z',
    staleAfterMs: 60_000,
  };

  it('is fresh while the pid lives and the heartbeat is recent', () => {
    expect(isAgentLockStale(base, now)).toBe(false);
  });

  it('is stale when the heartbeat is older than the threshold', () => {
    expect(isAgentLockStale({ ...base, heartbeatAt: '2026-01-01T00:00:00.000Z' }, now)).toBe(true);
    expect(isAgentLockStale({ ...base, heartbeatAt: 'garbage' }, now)).toBe(true);
  });

  it('never expires by time when staleAfterMs is 0', () => {
    expect(isAgentLockStale({ ...base, heartbeatAt: '2000-01-01T00:00:00.000Z', staleAfterMs: 0 }, now)).toBe(false);
  });

  it('is stale when the pid is dead on this host but not on other hosts', async () => {
    const pid = await deadPid();
    expect(isAgentLockStale({ ...base, pid }, now)).toBe(true);
    expect(isAgentLockStale({ ...base, pid, hostname: 'elsewhere' }, now)).toBe(false);
  });
});

describe('parseAgentLockOwner', () => {
  it('accepts well formed owners and rejects everything else', () => {
    const owner: AgentLockOwner = {
      ownerId: 'a',
      token: 'b',
      pid: 1,
      hostname: 'h',
      acquiredAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:00.000Z',
      staleAfterMs: 1,
    };
    expect(parseAgentLockOwner(owner)).toEqual(owner);
    expect(parseAgentLockOwner({ ...owner, pid: '1' })).toBeNull();
    expect(parseAgentLockOwner(null)).toBeNull();
    expect(parseAgentLockOwner('nope')).toBeNull();
  });
});
