import { InvalidWorkspaceIdError } from '@t3-code/runtime-protocol';

/** Maximum length of a normalized workspace id. Leaves room for the container prefix. */
export const MAX_WORKSPACE_ID_LENGTH = 48;

/** Prefix of every container managed by this runtime. */
export const DEFAULT_CONTAINER_NAME_PREFIX = 't3ws';

/**
 * A normalized id: lower-case, starts with an alphanumeric character and only
 * contains `[a-z0-9._-]`. This is a strict subset of what Docker accepts for
 * container names, so an id can never be mistaken for a CLI flag.
 */
const NORMALIZED_WORKSPACE_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function isNormalizedWorkspaceId(value: string): boolean {
  return NORMALIZED_WORKSPACE_ID.test(value) && value !== '.' && value !== '..' && !value.includes('..');
}

/**
 * Normalize a user supplied workspace id into a deterministic, Docker- and
 * filesystem-safe identifier. The same input always yields the same output.
 */
export function normalizeWorkspaceId(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidWorkspaceIdError(String(input), 'workspace id must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidWorkspaceIdError(input, 'workspace id must not be empty');
  }
  if (trimmed.includes('\0')) {
    throw new InvalidWorkspaceIdError(input, 'workspace id must not contain NUL bytes');
  }

  let normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');

  if (normalized.length > MAX_WORKSPACE_ID_LENGTH) {
    normalized = normalized.slice(0, MAX_WORKSPACE_ID_LENGTH).replace(/[^a-z0-9]+$/, '');
  }

  if (!isNormalizedWorkspaceId(normalized)) {
    throw new InvalidWorkspaceIdError(input, 'workspace id must contain at least one letter or digit');
  }
  return normalized;
}

/** Validate that `value` is already normalized; throws otherwise. */
export function assertWorkspaceId(value: string): string {
  if (typeof value !== 'string' || !isNormalizedWorkspaceId(value)) {
    throw new InvalidWorkspaceIdError(
      typeof value === 'string' ? value : JSON.stringify(value),
      `expected a normalized id matching ${NORMALIZED_WORKSPACE_ID.source}`,
    );
  }
  return value;
}

/** Deterministic container name for a workspace, e.g. `t3ws-my-feature`. */
export function containerNameForWorkspace(
  workspaceId: string,
  prefix: string = DEFAULT_CONTAINER_NAME_PREFIX,
): string {
  assertWorkspaceId(workspaceId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix)) {
    throw new InvalidWorkspaceIdError(prefix, 'container name prefix contains unsupported characters');
  }
  return `${prefix}-${workspaceId}`;
}

/** Inverse of {@link containerNameForWorkspace}; returns `null` for foreign containers. */
export function workspaceIdFromContainerName(
  containerName: string,
  prefix: string = DEFAULT_CONTAINER_NAME_PREFIX,
): string | null {
  const name = containerName.startsWith('/') ? containerName.slice(1) : containerName;
  const head = `${prefix}-`;
  if (!name.startsWith(head)) return null;
  const id = name.slice(head.length);
  return isNormalizedWorkspaceId(id) ? id : null;
}

/** Default branch checked out inside the container for a workspace. */
export function defaultBranchForWorkspace(workspaceId: string): string {
  return `t3/${assertWorkspaceId(workspaceId)}`;
}
