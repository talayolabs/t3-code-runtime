import { describe, expect, it } from 'vitest';

import { InvalidWorkspaceIdError } from '@t3-code/runtime-protocol';

import {
  MAX_WORKSPACE_ID_LENGTH,
  assertWorkspaceId,
  containerNameForWorkspace,
  defaultBranchForWorkspace,
  isNormalizedWorkspaceId,
  normalizeWorkspaceId,
  workspaceIdFromContainerName,
} from './workspace-identity.js';

describe('normalizeWorkspaceId', () => {
  it('lowercases and replaces unsupported characters', () => {
    expect(normalizeWorkspaceId('My Feature/Branch')).toBe('my-feature-branch');
    expect(normalizeWorkspaceId('  padded  ')).toBe('padded');
    expect(normalizeWorkspaceId('a__b')).toBe('a__b');
  });

  it('is deterministic', () => {
    expect(normalizeWorkspaceId('Hello World')).toBe(normalizeWorkspaceId('hello world'));
  });

  it('cannot produce values that look like Docker flags or paths', () => {
    expect(normalizeWorkspaceId('--rm')).toBe('rm');
    expect(normalizeWorkspaceId('-v /:/host')).toBe('v-host');
    expect(normalizeWorkspaceId('../../etc')).toBe('etc');
    expect(normalizeWorkspaceId('a/../b')).toBe('a-.-b');
  });

  it('truncates to the maximum length', () => {
    const long = 'x'.repeat(200);
    expect(normalizeWorkspaceId(long)).toHaveLength(MAX_WORKSPACE_ID_LENGTH);
  });

  it('rejects values without any letter or digit', () => {
    expect(() => normalizeWorkspaceId('---')).toThrow(InvalidWorkspaceIdError);
    expect(() => normalizeWorkspaceId('')).toThrow(InvalidWorkspaceIdError);
    expect(() => normalizeWorkspaceId('a\0b')).toThrow(InvalidWorkspaceIdError);
  });
});

describe('assertWorkspaceId', () => {
  it('accepts normalized ids', () => {
    expect(assertWorkspaceId('demo')).toBe('demo');
    expect(assertWorkspaceId('demo.v2_x-1')).toBe('demo.v2_x-1');
  });

  it('rejects un-normalized ids instead of silently normalizing', () => {
    for (const bad of ['Demo', 'a b', '-lead', 'a..b', '.', '..', 'x/y', 'a;rm -rf /']) {
      expect(() => assertWorkspaceId(bad), bad).toThrow(InvalidWorkspaceIdError);
      expect(isNormalizedWorkspaceId(bad), bad).toBe(false);
    }
  });
});

describe('container names', () => {
  it('are deterministic and reversible', () => {
    expect(containerNameForWorkspace('demo')).toBe('t3ws-demo');
    expect(containerNameForWorkspace('demo', 'custom')).toBe('custom-demo');
    expect(workspaceIdFromContainerName('t3ws-demo')).toBe('demo');
    expect(workspaceIdFromContainerName('/t3ws-demo')).toBe('demo');
    expect(workspaceIdFromContainerName('custom-demo', 'custom')).toBe('demo');
  });

  it('ignores containers that were not created by the runtime', () => {
    expect(workspaceIdFromContainerName('postgres')).toBeNull();
    expect(workspaceIdFromContainerName('t3ws-Not Valid')).toBeNull();
    expect(workspaceIdFromContainerName('t3ws-')).toBeNull();
  });

  it('rejects unsafe prefixes and ids', () => {
    expect(() => containerNameForWorkspace('Demo')).toThrow(InvalidWorkspaceIdError);
    expect(() => containerNameForWorkspace('demo', '--label')).toThrow(InvalidWorkspaceIdError);
    expect(() => containerNameForWorkspace('demo', 'a b')).toThrow(InvalidWorkspaceIdError);
  });
});

describe('defaultBranchForWorkspace', () => {
  it('derives the branch from the workspace id', () => {
    expect(defaultBranchForWorkspace('demo')).toBe('t3/demo');
    expect(() => defaultBranchForWorkspace('Bad Id')).toThrow(InvalidWorkspaceIdError);
  });
});
