import { describe, expect, it } from 'vitest';

import { InvalidPathError } from '@t3-code/runtime-protocol';

import {
  assertRepositoryRoot,
  joinWorkspaceRelative,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from './workspace-path.js';

const ROOT = '/workspace/repo';

describe('assertRepositoryRoot', () => {
  it('normalizes valid absolute roots', () => {
    expect(assertRepositoryRoot('/workspace/repo/')).toBe('/workspace/repo');
    expect(assertRepositoryRoot('/workspace//repo/./')).toBe('/workspace/repo');
  });

  it('rejects relative roots, the filesystem root, backslashes and NUL bytes', () => {
    for (const bad of ['workspace', '', '/', 'C:\\repo', '/a\0b']) {
      expect(() => assertRepositoryRoot(bad), JSON.stringify(bad)).toThrow(InvalidPathError);
    }
  });

  it('normalizes traversal inside absolute roots', () => {
    expect(assertRepositoryRoot('/a/../../b')).toBe('/b');
    expect(assertRepositoryRoot('/../x')).toBe('/x');
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves relative paths below the root', () => {
    expect(resolveWorkspacePath(ROOT, 'src/index.ts')).toEqual({
      absolute: '/workspace/repo/src/index.ts',
      relative: 'src/index.ts',
    });
    expect(resolveWorkspacePath(ROOT, './src/../README.md')).toEqual({
      absolute: '/workspace/repo/README.md',
      relative: 'README.md',
    });
  });

  it('treats empty, "." and the root itself as the root', () => {
    for (const input of ['', '.', './', ROOT, `${ROOT}/`]) {
      expect(resolveWorkspacePath(ROOT, input)).toEqual({ absolute: ROOT, relative: '.' });
    }
  });

  it('accepts absolute paths inside the root', () => {
    expect(resolveWorkspacePath(ROOT, '/workspace/repo/a/b').relative).toBe('a/b');
  });

  it('rejects traversal outside the root', () => {
    for (const bad of [
      '..',
      '../',
      '../sibling',
      'a/../../b',
      '/etc/passwd',
      '/workspace/repo2/file',
      '/workspace/repo/../repo2',
      'a\\b',
      'a\0b',
    ]) {
      expect(() => resolveWorkspacePath(ROOT, bad), JSON.stringify(bad)).toThrow(InvalidPathError);
    }
  });

  it('does not match a sibling directory sharing the root prefix', () => {
    expect(() => resolveWorkspacePath(ROOT, '/workspace/repository')).toThrow(InvalidPathError);
  });
});

describe('path helpers', () => {
  it('converts absolute container paths back to workspace-relative paths', () => {
    expect(toWorkspaceRelativePath(ROOT, '/workspace/repo/x/y')).toBe('x/y');
    expect(toWorkspaceRelativePath(ROOT, ROOT)).toBe('.');
    expect(() => toWorkspaceRelativePath(ROOT, '/other')).toThrow(InvalidPathError);
  });

  it('joins relative segments while keeping the root as "."-relative', () => {
    expect(joinWorkspaceRelative('.', 'a')).toBe('a');
    expect(joinWorkspaceRelative('', 'a')).toBe('a');
    expect(joinWorkspaceRelative('src', 'a')).toBe('src/a');
  });
});
