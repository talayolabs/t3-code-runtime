import { describe, expect, it } from 'vitest';

import { fileKindFromStat, parseStatLines } from './container-files.js';
import { buildSearchArgv, parseSearchOutput } from './container-search.js';
import { diffTreeSnapshots, parseTreeSnapshot } from './polling-watcher.js';
import { statusFromInspect } from './docker-workspace-runtime.js';
import type { DockerContainerInspect } from './docker-cli.js';

describe('parseStatLines', () => {
  it('parses busybox/GNU stat output into sorted entries', () => {
    const output = ['directory\t4096\t1700000000\t./src', 'regular file\t12\t1700000001\t./a.txt', 'symbolic link\t5\t1700000002\t./link', 'regular empty file\t0\t1700000003\t./empty', ''].join(
      '\n',
    );
    expect(parseStatLines(output, '.')).toEqual([
      { name: 'a.txt', path: 'a.txt', kind: 'file', size: 12, mtimeMs: 1700000001000 },
      { name: 'empty', path: 'empty', kind: 'file', size: 0, mtimeMs: 1700000003000 },
      { name: 'link', path: 'link', kind: 'symlink', size: 5, mtimeMs: 1700000002000 },
      { name: 'src', path: 'src', kind: 'directory', size: 4096, mtimeMs: 1700000000000 },
    ]);
  });

  it('prefixes paths with the parent directory and tolerates odd names', () => {
    const entries = parseStatLines('regular file\t1\t1\t./with\ttab\nfifo\t0\t1\t./pipe\nbroken', 'sub/dir');
    expect(entries).toEqual([
      { name: 'pipe', path: 'sub/dir/pipe', kind: 'other', size: 0, mtimeMs: 1000 },
      { name: 'with\ttab', path: 'sub/dir/with\ttab', kind: 'file', size: 1, mtimeMs: 1000 },
    ]);
    expect(fileKindFromStat('character special file')).toBe('other');
  });
});

describe('search', () => {
  it('builds rg argv with the pattern isolated behind --regexp and --', () => {
    expect(buildSearchArgv('rg', { pattern: '--version', caseSensitive: false, fixedString: true }, '/workspace/repo')).toEqual([
      'rg',
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--null',
      '--ignore-case',
      '--fixed-strings',
      '--regexp',
      '--version',
      '--',
      '/workspace/repo',
    ]);
  });

  it('builds a fixed grep pipeline with dynamic values as positional arguments', () => {
    const argv = buildSearchArgv('grep', { pattern: '$(rm -rf /)', includeHidden: true }, '/workspace/repo/src');
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(argv[2]).not.toContain('rm -rf');
    expect(argv[2]).not.toContain('/workspace');
    expect(argv.slice(3)).toEqual(['t3-search', '/workspace/repo/src', '-E', '-e', '$(rm -rf /)']);
    expect(() => buildSearchArgv('grep', { pattern: '' }, '/x')).toThrow(TypeError);
  });

  it('parses rg NUL separated output relative to the searched directory', () => {
    const output = '/workspace/repo/src/a.ts\u000012:const x: number = 1\n/workspace/repo/b.md\u00001:# title\n';
    expect(parseSearchOutput(output, '/workspace/repo', '.', 10)).toEqual([
      { path: 'src/a.ts', line: 12, text: 'const x: number = 1' },
      { path: 'b.md', line: 1, text: '# title' },
    ]);
  });

  it('parses grep output and honours the result limit', () => {
    const output = './x.txt:1:one\n./dir/y.txt:2:two: with colon\n./x.txt:3:three\n';
    expect(parseSearchOutput(output, '/workspace/repo/sub', 'sub', 2)).toEqual([
      { path: 'sub/x.txt', line: 1, text: 'one' },
      { path: 'sub/dir/y.txt', line: 2, text: 'two: with colon' },
    ]);
    expect(parseSearchOutput('garbage without numbers\n', '/w', '.', 5)).toEqual([]);
  });
});

describe('polling watcher snapshots', () => {
  it('parses snapshots and skips malformed lines', () => {
    const snapshot = parseTreeSnapshot('regular file\t3\t100\t./a\ndirectory\t4096\t100\t./d\nbroken\n');
    expect([...snapshot.entries()]).toEqual([
      ['a', { kind: 'file', size: 3, mtimeMs: 100_000 }],
      ['d', { kind: 'directory', size: 4096, mtimeMs: 100_000 }],
    ]);
  });

  it('reports create, modify, delete and heuristic rename events', () => {
    const before = parseTreeSnapshot(
      ['regular file\t3\t100\t./keep', 'regular file\t3\t100\t./changed', 'regular file\t9\t100\t./gone', 'regular file\t7\t100\t./old-name'].join('\n'),
    );
    const after = parseTreeSnapshot(
      ['regular file\t3\t100\t./keep', 'regular file\t4\t101\t./changed', 'regular file\t1\t102\t./fresh', 'regular file\t7\t100\t./new-name'].join('\n'),
    );
    expect(diffTreeSnapshots(before, after, 'src', 5)).toEqual([
      { type: 'modify', path: 'src/changed', kind: 'file', timestamp: 5 },
      { type: 'create', path: 'src/fresh', kind: 'file', timestamp: 5 },
      { type: 'delete', path: 'src/gone', kind: 'file', timestamp: 5 },
      { type: 'rename', path: 'src/new-name', previousPath: 'src/old-name', kind: 'file', timestamp: 5 },
    ]);
  });

  it('never pairs directories as renames and reports nothing for identical trees', () => {
    const before = parseTreeSnapshot('directory\t4096\t100\t./a');
    const after = parseTreeSnapshot('directory\t4096\t100\t./b');
    expect(diffTreeSnapshots(before, after, '.', 1)).toEqual([
      { type: 'delete', path: 'a', kind: 'directory', timestamp: 1 },
      { type: 'create', path: 'b', kind: 'directory', timestamp: 1 },
    ]);
    expect(diffTreeSnapshots(before, before, '.', 1)).toEqual([]);
  });
});

describe('statusFromInspect', () => {
  const inspect = (status: DockerContainerInspect['State']['Status']): DockerContainerInspect => ({
    Id: 'id',
    Name: '/t3ws-demo',
    Created: '2026-01-01T00:00:00Z',
    State: { Status: status, Running: status === 'running', Paused: false, Pid: 0, ExitCode: 0, StartedAt: '', FinishedAt: '' },
    Config: { Image: 'img', Labels: {}, WorkingDir: '/workspace/repo', Env: null },
    Image: 'sha256:abc',
  });

  it('maps docker states onto workspace states', () => {
    expect(statusFromInspect(inspect('running'))).toBe('running');
    expect(statusFromInspect(inspect('paused'))).toBe('running');
    expect(statusFromInspect(inspect('created'))).toBe('created');
    expect(statusFromInspect(inspect('exited'))).toBe('stopped');
    expect(statusFromInspect(inspect('dead'))).toBe('stopped');
    expect(statusFromInspect(inspect('removing'))).toBe('missing');
  });
});
