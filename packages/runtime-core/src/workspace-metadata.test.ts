import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError, InvalidPathError, WorkspaceNotFoundError } from '@t3-code/runtime-protocol';

import {
  WORKSPACE_METADATA_VERSION,
  createWorkspaceMetadata,
  parseWorkspaceMetadata,
  serializeWorkspaceMetadata,
} from './workspace-metadata.js';
import { WorkspaceMetadataStore, defaultStateDir } from './workspace-metadata-store.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function sample() {
  return createWorkspaceMetadata({
    workspaceId: 'example',
    runtime: 'docker',
    containerName: 't3ws-example',
    image: 'alpine/git:latest',
    repositoryPath: '/workspace/repo',
    branch: 't3/example',
    sourcePath: '/home/me/project',
    importMode: 'git-bundle',
    now: NOW,
  });
}

describe('createWorkspaceMetadata', () => {
  it('produces the documented shape', () => {
    expect(sample()).toEqual({
      workspaceId: 'example',
      runtime: 'docker',
      containerId: null,
      containerName: 't3ws-example',
      image: 'alpine/git:latest',
      repositoryPath: '/workspace/repo',
      branch: 't3/example',
      sourcePath: '/home/me/project',
      importMode: 'git-bundle',
      status: 'creating',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      labels: {},
    });
  });

  it('validates ids and repository paths', () => {
    expect(() => createWorkspaceMetadata({ ...sample(), workspaceId: 'Bad Id' })).toThrow();
    expect(() => createWorkspaceMetadata({ ...sample(), repositoryPath: 'relative' })).toThrow(InvalidPathError);
  });
});

describe('serialize/parse', () => {
  it('round-trips through JSON with a version marker', () => {
    const metadata = sample();
    const text = serializeWorkspaceMetadata(metadata);
    const raw: unknown = JSON.parse(text);
    expect(raw).toMatchObject({ version: WORKSPACE_METADATA_VERSION });
    expect(parseWorkspaceMetadata(raw)).toEqual(metadata);
  });

  it('accepts the minimal documented example', () => {
    const parsed = parseWorkspaceMetadata({
      workspaceId: 'example',
      containerId: 'container-id',
      containerName: 't3ws-example',
      image: 'alpine/git:latest',
      repositoryPath: '/workspace/repo',
      branch: 't3/example',
      runtime: 'docker',
      status: 'stopped',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.containerId).toBe('container-id');
    expect(parsed.sourcePath).toBeNull();
    expect(parsed.importMode).toBeNull();
    expect(parsed.labels).toEqual({});
  });

  it('rejects malformed input', () => {
    const good = JSON.parse(serializeWorkspaceMetadata(sample())) as Record<string, unknown>;
    expect(() => parseWorkspaceMetadata(null)).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata([])).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata({ ...good, version: 99 })).toThrow(/version/);
    expect(() => parseWorkspaceMetadata({ ...good, runtime: 'kubernetes' })).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata({ ...good, status: 'exploded' })).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata({ ...good, importMode: 'zip' })).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata({ ...good, createdAt: 'yesterday' })).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata({ ...good, labels: { a: 1 } })).toThrow(InvalidArgumentError);
    expect(() => parseWorkspaceMetadata({ ...good, workspaceId: '../escape' })).toThrow();
    expect(() => parseWorkspaceMetadata({ ...good, repositoryPath: 'relative' })).toThrow(InvalidPathError);
  });
});

describe('WorkspaceMetadataStore', () => {
  let dir: string;
  let store: WorkspaceMetadataStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-metadata-'));
    store = new WorkspaceMetadataStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps metadata and locks outside the source tree', () => {
    expect(store.metadataPath('example')).toBe(path.join(dir, 'workspaces', 'example', 'metadata.json'));
    expect(store.agentLockPath('example')).toBe(path.join(dir, 'workspaces', 'example', 'agent.lock'));
    expect(() => store.metadataPath('../escape')).toThrow();
  });

  it('writes, reads, updates, lists and deletes', async () => {
    expect(await store.read('example')).toBeNull();
    await expect(store.require('example')).rejects.toBeInstanceOf(WorkspaceNotFoundError);

    await store.write(sample());
    expect(await store.exists('example')).toBe(true);
    expect(await store.read('example')).toEqual(sample());

    const later = new Date('2026-01-02T00:00:00.000Z');
    const updated = await store.update('example', { containerId: 'abc', status: 'running' }, later);
    expect(updated.containerId).toBe('abc');
    expect(updated.status).toBe('running');
    expect(updated.createdAt).toBe(NOW.toISOString());
    expect(updated.updatedAt).toBe(later.toISOString());
    expect(await store.read('example')).toEqual(updated);

    expect((await store.list()).map((m) => m.workspaceId)).toEqual(['example']);

    await store.delete('example');
    expect(await store.read('example')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('survives a "process restart" (a fresh store over the same directory)', async () => {
    await store.write({ ...sample(), containerId: 'retained', status: 'stopped' });
    const reopened = new WorkspaceMetadataStore(dir);
    const metadata = await reopened.require('example');
    expect(metadata.containerId).toBe('retained');
    expect(metadata.status).toBe('stopped');
  });

  it('never leaves temporary files behind', async () => {
    await store.write(sample());
    const files = await fs.readdir(path.join(dir, 'workspaces', 'example'));
    expect(files).toEqual(['metadata.json']);
  });

  it('ignores stray directories that are not workspace ids', async () => {
    await store.write(sample());
    await fs.mkdir(path.join(dir, 'workspaces', 'Not Valid'), { recursive: true });
    await fs.mkdir(path.join(dir, 'workspaces', 'orphan'), { recursive: true });
    expect((await store.list()).map((m) => m.workspaceId)).toEqual(['example']);
  });

  it('derives the default state dir from the environment', () => {
    expect(defaultStateDir({ T3_CODE_RUNTIME_HOME: '/tmp/x' })).toBe(path.resolve('/tmp/x'));
    expect(defaultStateDir({})).toBe(path.join(os.homedir(), '.t3-code-runtime'));
  });
});
