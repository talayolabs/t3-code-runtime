import { describe, expect, it } from 'vitest';

import {
  CommandFailedError,
  FileNotFoundError,
  IsADirectoryError,
  NotADirectoryError,
  PermissionDeniedError,
} from '@t3-code/runtime-protocol';

import { mapFileCommandError, toError } from './error-mapping.js';

describe('mapFileCommandError', () => {
  const argv = ['cat', '--', '/workspace/repo/missing.txt'];

  it('maps busybox and GNU "no such file" messages', () => {
    const busybox = mapFileCommandError({
      argv,
      exitCode: 1,
      stderr: "cat: can't open '/workspace/repo/missing.txt': No such file or directory\n",
    });
    expect(busybox).toBeInstanceOf(FileNotFoundError);
    expect(busybox.code).toBe('FILE_NOT_FOUND');
    expect(busybox.message).toContain('/workspace/repo/missing.txt');

    const gnu = mapFileCommandError({
      argv,
      exitCode: 1,
      stderr: 'cat: /workspace/repo/missing.txt: No such file or directory',
    });
    expect(gnu).toBeInstanceOf(FileNotFoundError);
    expect(gnu.message).toContain('/workspace/repo/missing.txt');
  });

  it('prefers the caller supplied workspace-relative path', () => {
    const error = mapFileCommandError({
      argv,
      exitCode: 1,
      stderr: "cat: can't open '/workspace/repo/missing.txt': No such file or directory",
      path: 'missing.txt',
    });
    expect(error).toBeInstanceOf(FileNotFoundError);
    expect((error as FileNotFoundError).path).toBe('missing.txt');
  });

  it('maps directory and permission errors', () => {
    expect(mapFileCommandError({ argv, exitCode: 1, stderr: 'cat: read error: Is a directory' })).toBeInstanceOf(
      IsADirectoryError,
    );
    expect(mapFileCommandError({ argv, exitCode: 1, stderr: "ls: a/b: Not a directory" })).toBeInstanceOf(
      NotADirectoryError,
    );
    expect(mapFileCommandError({ argv, exitCode: 1, stderr: "sh: can't create /x: Permission denied" })).toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('falls back to a command failure carrying exit code and stderr', () => {
    const error = mapFileCommandError({ argv, exitCode: 42, stderr: 'something else\n' });
    expect(error).toBeInstanceOf(CommandFailedError);
    const failed = error as CommandFailedError;
    expect(failed.code).toBe('COMMAND_FAILED');
    expect(failed.exitCode).toBe(42);
    expect(failed.stderr).toBe('something else');
    expect(failed.command).toEqual(argv);
    expect(failed.command).not.toBe(argv);
    expect(failed.message).toContain('42');
    expect(failed.message).toContain('something else');
  });
});

describe('toError', () => {
  it('passes errors through and wraps other values', () => {
    const original = new Error('boom');
    expect(toError(original)).toBe(original);
    expect(toError('text').message).toBe('text');
    expect(toError({ code: 1 }).message).toBe('{"code":1}');
  });
});
