import { joinWorkspaceRelative } from '@t3-code/runtime-core';
import { CommandFailedError, type SearchQuery, type SearchResult } from '@t3-code/runtime-protocol';

import type { ContainerExec } from './container-files.js';

export const DEFAULT_SEARCH_MAX_RESULTS = 1000;

export type SearchTool = 'rg' | 'grep';

/**
 * `find | xargs grep` fallback that works with busybox as well as GNU tools.
 * The directory arrives as `$1`; grep flags and the pattern follow as `"$@"`.
 * `.git` is always pruned; other dot-entries are pruned unless hidden files
 * were requested.
 */
const GREP_SCRIPT_VISIBLE =
  'cd -- "$1" && shift && find . \\( -name .git -o -name ".*" -path "./*" \\) -prune -o -type f -print0 | xargs -0 grep -Hn "$@"';
const GREP_SCRIPT_HIDDEN =
  'cd -- "$1" && shift && find . -name .git -prune -o -type f -print0 | xargs -0 grep -Hn "$@"';

/**
 * Build the argv for a search. `rg` is preferred when the image ships it (it
 * honours `.gitignore` and prints NUL separated paths); otherwise a portable
 * `find | xargs grep` pipeline is used. Both run relative to the searched
 * directory so output paths are `./relative/path`.
 */
export function buildSearchArgv(tool: SearchTool, query: SearchQuery, absoluteDirectory: string): string[] {
  if (typeof query.pattern !== 'string' || query.pattern.length === 0) {
    throw new TypeError('search pattern must be a non-empty string');
  }
  const caseSensitive = query.caseSensitive ?? true;
  if (tool === 'rg') {
    const argv = ['rg', '--line-number', '--no-heading', '--color', 'never', '--null'];
    if (!caseSensitive) argv.push('--ignore-case');
    if (query.fixedString) argv.push('--fixed-strings');
    if (query.includeHidden) argv.push('--hidden');
    argv.push('--regexp', query.pattern, '--', absoluteDirectory);
    return argv;
  }
  const grepFlags: string[] = [];
  if (!caseSensitive) grepFlags.push('-i');
  grepFlags.push(query.fixedString ? '-F' : '-E');
  return ['sh', '-c', query.includeHidden ? GREP_SCRIPT_HIDDEN : GREP_SCRIPT_VISIBLE, 't3-search', absoluteDirectory, ...grepFlags, '-e', query.pattern];
}

/**
 * Parse search output into results.
 *
 * - `rg --null`: `<absolute path>\0<line>:<text>`
 * - `grep -Hn` (relative to the directory): `./<path>:<line>:<text>`
 *
 * For the grep format a file name containing `:` cannot be disambiguated;
 * such lines are attributed to the shortest prefix before a `:<digits>:` run.
 */
export function parseSearchOutput(
  output: string,
  absoluteDirectory: string,
  relativeDirectory: string,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of output.split('\n')) {
    if (results.length >= maxResults) break;
    if (line.length === 0) continue;
    const parsed = line.includes('\0') ? parseNulRecord(line) : parseColonRecord(line);
    if (!parsed) continue;
    let file = parsed.file;
    if (file.startsWith('./')) file = file.slice(2);
    if (file === absoluteDirectory) {
      file = relativeDirectory;
    } else if (file.startsWith(`${absoluteDirectory}/`)) {
      file = joinWorkspaceRelative(relativeDirectory, file.slice(absoluteDirectory.length + 1));
    } else {
      file = joinWorkspaceRelative(relativeDirectory, file);
    }
    results.push({ path: file, line: parsed.line, text: parsed.text });
  }
  return results;
}

function parseNulRecord(line: string): { file: string; line: number; text: string } | null {
  const nul = line.indexOf('\0');
  const rest = line.slice(nul + 1);
  const colon = rest.indexOf(':');
  if (colon === -1) return null;
  const lineNumber = Number(rest.slice(0, colon));
  if (!Number.isInteger(lineNumber)) return null;
  return { file: line.slice(0, nul), line: lineNumber, text: rest.slice(colon + 1) };
}

function parseColonRecord(line: string): { file: string; line: number; text: string } | null {
  const match = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  return { file: match[1] ?? '', line: Number(match[2]), text: match[3] ?? '' };
}

export class ContainerSearch {
  private toolPromise: Promise<SearchTool> | null = null;

  constructor(private readonly exec: ContainerExec) {}

  async search(query: SearchQuery, absoluteDirectory: string, relativeDirectory: string): Promise<SearchResult[]> {
    const tool = await this.detectTool();
    const argv = buildSearchArgv(tool, query, absoluteDirectory);
    const maxResults = query.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
    const result = await this.exec(argv[0] ?? tool, argv.slice(1));
    // Exit code 1 means "no matches" for rg, grep and xargs alike.
    if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 123) {
      throw new CommandFailedError(argv, result.exitCode, result.stderr.toString('utf8').trim());
    }
    return parseSearchOutput(result.stdout.toString('utf8'), absoluteDirectory, relativeDirectory, maxResults);
  }

  private detectTool(): Promise<SearchTool> {
    this.toolPromise ??= this.exec('sh', ['-c', 'command -v rg >/dev/null 2>&1']).then((result) =>
      result.exitCode === 0 ? 'rg' : 'grep',
    );
    return this.toolPromise;
  }
}
