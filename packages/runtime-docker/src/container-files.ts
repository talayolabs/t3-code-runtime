import { joinWorkspaceRelative, mapFileCommandError } from '@t3-code/runtime-core';
import { CommandFailedError, IsADirectoryError, type ExecResult, type FileEntry, type FileEntryKind } from '@t3-code/runtime-protocol';

/** Executes an argv inside the workspace container; provided by the runtime. */
export type ContainerExec = (
  command: string,
  args: string[],
  options?: { input?: Buffer | string; timeoutMs?: number },
) => Promise<ExecResult>;

/** `stat -c` format shared by every listing command: kind, size, mtime, name. */
export const STAT_FORMAT = '%F\t%s\t%Y\t%n';

/** Shell snippets are fixed strings; every dynamic value arrives through `$1`, `$2`, … */
const WRITE_FILE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
const LIST_DIRECTORY_SCRIPT = `cd -- "$1" && find . -mindepth 1 -maxdepth 1 -exec stat -c '${STAT_FORMAT}' {} +`;

export function fileKindFromStat(kind: string): FileEntryKind {
  if (kind === 'directory') return 'directory';
  if (kind === 'symbolic link') return 'symlink';
  if (kind === 'regular file' || kind === 'regular empty file') return 'file';
  return 'other';
}

/**
 * Parse `stat -c '%F\t%s\t%Y\t%n'` output into entries. `parentRelative` is
 * the workspace-relative directory the names belong to (`.` for the root).
 * File names containing tabs or newlines are not supported by this format.
 */
export function parseStatLines(output: string, parentRelative: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [kind, size, mtime, ...nameParts] = parts;
    const rawName = nameParts.join('\t');
    const name = rawName.startsWith('./') ? rawName.slice(2) : rawName;
    entries.push({
      name,
      path: joinWorkspaceRelative(parentRelative, name),
      kind: fileKindFromStat(kind ?? ''),
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export class ContainerFileSystem {
  constructor(private readonly exec: ContainerExec) {}

  async readFile(absolutePath: string, relativePath: string): Promise<Buffer> {
    const result = await this.exec('cat', [absolutePath]);
    if (result.exitCode !== 0) {
      throw mapFileCommandError({
        argv: ['cat', absolutePath],
        exitCode: result.exitCode,
        stderr: result.stderr.toString('utf8'),
        path: relativePath,
      });
    }
    return result.stdout;
  }

  async writeFile(absolutePath: string, relativePath: string, data: Buffer | string): Promise<void> {
    const argv = ['sh', '-c', WRITE_FILE_SCRIPT, 't3-write', absolutePath];
    const result = await this.exec(argv[0] ?? 'sh', argv.slice(1), { input: data });
    if (result.exitCode !== 0) {
      throw mapFileCommandError({
        argv,
        exitCode: result.exitCode,
        stderr: result.stderr.toString('utf8'),
        path: relativePath,
      });
    }
  }

  async listDirectory(absolutePath: string, relativePath: string): Promise<FileEntry[]> {
    const argv = ['sh', '-c', LIST_DIRECTORY_SCRIPT, 't3-ls', absolutePath];
    const result = await this.exec(argv[0] ?? 'sh', argv.slice(1));
    if (result.exitCode !== 0) {
      throw mapFileCommandError({
        argv,
        exitCode: result.exitCode,
        stderr: result.stderr.toString('utf8'),
        path: relativePath,
      });
    }
    return parseStatLines(result.stdout.toString('utf8'), relativePath);
  }

  async stat(absolutePath: string, relativePath: string): Promise<FileEntry> {
    const argv = ['stat', '-c', STAT_FORMAT, absolutePath];
    const result = await this.exec(argv[0] ?? 'stat', argv.slice(1));
    if (result.exitCode !== 0) {
      throw mapFileCommandError({
        argv,
        exitCode: result.exitCode,
        stderr: result.stderr.toString('utf8'),
        path: relativePath,
      });
    }
    const parent = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '.';
    const [entry] = parseStatLines(result.stdout.toString('utf8'), parent);
    if (!entry) {
      throw new CommandFailedError(argv, result.exitCode, 'stat produced no output');
    }
    const name = relativePath === '.' ? '.' : relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return { ...entry, name, path: relativePath };
  }

  /** Guard used before `cat`: reading a directory must fail with a typed error. */
  assertNotDirectory(entry: FileEntry, relativePath: string): void {
    if (entry.kind === 'directory') throw new IsADirectoryError(relativePath);
  }
}
