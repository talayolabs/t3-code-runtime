import path from 'node:path';

import { InvalidPathError } from '@t3-code/runtime-protocol';

export interface ResolvedWorkspacePath {
  /** Absolute POSIX path inside the workspace container. */
  absolute: string;
  /** Path relative to the repository root, `.` for the root itself. */
  relative: string;
}

/** Validate that `root` is an absolute, normalized POSIX directory path. */
export function assertRepositoryRoot(root: string): string {
  if (typeof root !== 'string' || !path.posix.isAbsolute(root)) {
    throw new InvalidPathError(
      typeof root === 'string' ? root : JSON.stringify(root),
      'repository root must be an absolute POSIX path',
    );
  }
  if (root.includes('\0')) {
    throw new InvalidPathError(root, 'repository root must not contain NUL bytes');
  }
  if (root.includes('\\')) {
    throw new InvalidPathError(root, 'repository root must use POSIX separators');
  }
  const normalized = path.posix.normalize(root).replace(/\/+$/, '');
  if (normalized === '' || normalized.split('/').includes('..')) {
    throw new InvalidPathError(root, 'repository root must be a directory below the filesystem root');
  }
  return normalized;
}

/**
 * Resolve a caller supplied path against the repository root inside the
 * workspace and reject anything that would escape it.
 *
 * Accepted inputs: `''`, `.`, `src/index.ts`, `./src`, and absolute paths
 * that already live under the root (`/workspace/repo/src`).
 * Rejected inputs: `..`, `../x`, `src/../../x`, NUL bytes, absolute paths
 * outside the root, and backslash separators (paths are POSIX only).
 */
export function resolveWorkspacePath(repositoryRoot: string, input: string): ResolvedWorkspacePath {
  const root = assertRepositoryRoot(repositoryRoot);
  if (typeof input !== 'string') {
    throw new InvalidPathError(String(input), 'path must be a string');
  }
  if (input.includes('\0')) {
    throw new InvalidPathError(input, 'path must not contain NUL bytes');
  }
  if (input.includes('\\')) {
    throw new InvalidPathError(input, 'path must use POSIX separators');
  }

  let absolute: string;
  if (path.posix.isAbsolute(input)) {
    absolute = path.posix.normalize(input);
  } else {
    absolute = path.posix.normalize(path.posix.join(root, input === '' ? '.' : input));
  }
  absolute = absolute.replace(/\/+$/, '') || '/';

  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new InvalidPathError(input, `path escapes the workspace root ${root}`);
  }

  const relative = absolute === root ? '.' : absolute.slice(root.length + 1);
  return { absolute, relative };
}

/** Convert an absolute container path back to a workspace-relative POSIX path. */
export function toWorkspaceRelativePath(repositoryRoot: string, absolute: string): string {
  return resolveWorkspacePath(repositoryRoot, absolute).relative;
}

/** Join a workspace-relative parent with an entry name, keeping `.` for the root. */
export function joinWorkspaceRelative(parent: string, name: string): string {
  return parent === '.' || parent === '' ? name : `${parent}/${name}`;
}
