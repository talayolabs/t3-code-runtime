import {
  CommandFailedError,
  FileNotFoundError,
  IsADirectoryError,
  NotADirectoryError,
  PermissionDeniedError,
  type RuntimeError,
} from '@t3-code/runtime-protocol';

export interface FailedCommand {
  argv: readonly string[];
  exitCode: number;
  stderr: string;
  /** Workspace-relative path the command operated on, used in the error message. */
  path?: string;
}

/**
 * Translate the stderr of a failed POSIX file command (`cat`, `stat`, `find`,
 * `sh -c 'cat > …'`, …) into a typed runtime error. Falls back to
 * {@link CommandFailedError} when the text is not recognized.
 */
export function mapFileCommandError(failed: FailedCommand): RuntimeError {
  const stderr = failed.stderr.trim();
  const target = failed.path ?? extractPath(stderr) ?? '<unknown>';
  if (/No such file or directory/i.test(stderr)) return new FileNotFoundError(target);
  if (/Not a directory/i.test(stderr)) return new NotADirectoryError(target);
  if (/Is a directory/i.test(stderr)) return new IsADirectoryError(target);
  if (/Permission denied/i.test(stderr)) return new PermissionDeniedError(target);
  return new CommandFailedError([...failed.argv], failed.exitCode, stderr);
}

function extractPath(stderr: string): string | null {
  // busybox/GNU coreutils: `cat: can't open '/x/y': No such file or directory`
  // (the quoted path is the one followed by `: `, not the apostrophe in "can't")
  const quoted = /'([^']+)': /.exec(stderr);
  if (quoted?.[1]) return quoted[1];
  // GNU: `cat: /x/y: No such file or directory`
  const colon = /^[^:]+: ([^:]+): /.exec(stderr);
  return colon?.[1] ?? null;
}

/** Convert anything thrown into an Error instance without losing information. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}
