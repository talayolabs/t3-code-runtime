import { describe, expect, it } from 'vitest';

import { InvalidWorkspaceStateError, type WorkspaceStatus } from '@t3-code/runtime-protocol';

import { WORKSPACE_TRANSITIONS, assertTransition, canTransition, isOperable, isRetained } from './workspace-lifecycle.js';

const ALL: WorkspaceStatus[] = ['creating', 'created', 'running', 'stopped', 'removed', 'missing'];

describe('workspace lifecycle', () => {
  it('follows create → start → stop → start → remove', () => {
    expect(assertTransition('ws', 'creating', 'created')).toBe('created');
    expect(assertTransition('ws', 'created', 'running')).toBe('running');
    expect(assertTransition('ws', 'running', 'stopped')).toBe('stopped');
    expect(assertTransition('ws', 'stopped', 'running')).toBe('running');
    expect(assertTransition('ws', 'running', 'removed')).toBe('removed');
  });

  it('allows stopping and removing retained containers from any live state', () => {
    for (const from of ['created', 'running', 'stopped'] as const) {
      expect(canTransition(from, 'removed'), from).toBe(true);
      expect(canTransition(from, 'missing'), from).toBe(true);
    }
  });

  it('treats self transitions as no-ops', () => {
    for (const status of ALL) expect(canTransition(status, status), status).toBe(true);
  });

  it('never leaves the removed state', () => {
    for (const to of ALL.filter((s) => s !== 'removed')) {
      expect(canTransition('removed', to), to).toBe(false);
      expect(() => assertTransition('ws', 'removed', to)).toThrow(InvalidWorkspaceStateError);
    }
    expect(WORKSPACE_TRANSITIONS.removed).toEqual([]);
  });

  it('only allows a missing container to be cleaned up', () => {
    expect(canTransition('missing', 'removed')).toBe(true);
    expect(canTransition('missing', 'running')).toBe(false);
    expect(canTransition('missing', 'stopped')).toBe(false);
  });

  it('does not allow skipping back to creating', () => {
    for (const from of ALL.filter((s) => s !== 'creating')) {
      expect(canTransition(from, 'creating'), from).toBe(false);
    }
  });

  it('reports operable and retained states', () => {
    expect(ALL.filter(isOperable)).toEqual(['running']);
    expect(ALL.filter(isRetained)).toEqual(['created', 'running', 'stopped']);
  });

  it('includes the workspace id and both states in the error', () => {
    try {
      assertTransition('demo', 'removed', 'running');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWorkspaceStateError);
      expect((error as Error).message).toContain('demo');
      expect((error as Error).message).toContain('removed');
      expect((error as Error).message).toContain('running');
    }
  });
});
