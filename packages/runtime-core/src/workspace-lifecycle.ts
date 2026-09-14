import { InvalidWorkspaceStateError, type WorkspaceStatus } from '@t3-code/runtime-protocol';

/**
 * Allowed lifecycle transitions. `missing` is entered when the runtime
 * discovers that the backing container disappeared; the only way out is
 * `removed` (delete the metadata) so callers never operate on a phantom.
 */
export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceStatus, readonly WorkspaceStatus[]>> = {
  creating: ['created', 'running', 'removed', 'missing'],
  created: ['running', 'stopped', 'removed', 'missing'],
  running: ['stopped', 'removed', 'missing'],
  stopped: ['running', 'removed', 'missing'],
  missing: ['removed'],
  removed: [],
};

export function canTransition(from: WorkspaceStatus, to: WorkspaceStatus): boolean {
  return from === to || WORKSPACE_TRANSITIONS[from].includes(to);
}

export function assertTransition(workspaceId: string, from: WorkspaceStatus, to: WorkspaceStatus): WorkspaceStatus {
  if (!canTransition(from, to)) {
    throw new InvalidWorkspaceStateError(workspaceId, from, to);
  }
  return to;
}

export function isOperable(status: WorkspaceStatus): boolean {
  return status === 'running';
}

export function isRetained(status: WorkspaceStatus): boolean {
  return status === 'created' || status === 'running' || status === 'stopped';
}
