import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '@t3-code/runtime-protocol';

import { assertCommandArgv, assertEnvironment, formatCommandForLog, splitAtDoubleDash } from './command-line.js';

describe('assertCommandArgv', () => {
  it('returns a fresh argv array and keeps arguments verbatim', () => {
    const args = ['-c', 'echo "$HOME"; rm -rf / # not interpreted'];
    const argv = assertCommandArgv('sh', args);
    expect(argv).toEqual(['sh', '-c', 'echo "$HOME"; rm -rf / # not interpreted']);
    expect(argv).not.toBe(args);
  });

  it('defaults to no arguments', () => {
    expect(assertCommandArgv('ls')).toEqual(['ls']);
  });

  it('rejects empty commands, NUL bytes and non-string arguments', () => {
    expect(() => assertCommandArgv('')).toThrow(InvalidArgumentError);
    expect(() => assertCommandArgv('a\0b')).toThrow(InvalidArgumentError);
    expect(() => assertCommandArgv('ls', ['ok', 'bad\0'])).toThrow(/args\[1\]/);
    expect(() => assertCommandArgv('ls', [1 as unknown as string])).toThrow(/args\[0\]/);
    expect(() => assertCommandArgv('ls', 'x' as unknown as string[])).toThrow(InvalidArgumentError);
  });
});

describe('assertEnvironment', () => {
  it('accepts valid names and returns a copy', () => {
    const env = { PATH: '/bin', _X1: 'y' };
    expect(assertEnvironment(env)).toEqual(env);
    expect(assertEnvironment(env)).not.toBe(env);
    expect(assertEnvironment(undefined)).toEqual({});
  });

  it('rejects names that could be interpreted as flags or values with NUL bytes', () => {
    expect(() => assertEnvironment({ '--privileged': 'x' })).toThrow(InvalidArgumentError);
    expect(() => assertEnvironment({ 'A=B': 'x' })).toThrow(InvalidArgumentError);
    expect(() => assertEnvironment({ '1ABC': 'x' })).toThrow(InvalidArgumentError);
    expect(() => assertEnvironment({ OK: 'a\0b' })).toThrow(InvalidArgumentError);
  });
});

describe('formatCommandForLog', () => {
  it('quotes arguments that need it', () => {
    expect(formatCommandForLog(['git', 'commit', '-m', 'hello world'])).toBe('git commit -m "hello world"');
  });

  it('never prints environment values and flags secret-looking names', () => {
    const rendered = formatCommandForLog(['npm', 'publish'], { NPM_TOKEN: 'hunter2', HOME: '/root' });
    expect(rendered).toBe('[env: HOME=… NPM_TOKEN=<redacted>] npm publish');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('/root');
  });
});

describe('splitAtDoubleDash', () => {
  it('splits at the first "--" only', () => {
    expect(splitAtDoubleDash(['exec', 'ws', '--', 'sh', '-c', 'a -- b'])).toEqual({
      before: ['exec', 'ws'],
      after: ['sh', '-c', 'a -- b'],
    });
    expect(splitAtDoubleDash(['git', 'ws', '--', 'log', '--', 'file'])).toEqual({
      before: ['git', 'ws'],
      after: ['log', '--', 'file'],
    });
  });

  it('reports a missing separator as null', () => {
    expect(splitAtDoubleDash(['ls', 'ws', '.'])).toEqual({ before: ['ls', 'ws', '.'], after: null });
    expect(splitAtDoubleDash(['exec', 'ws', '--'])).toEqual({ before: ['exec', 'ws'], after: [] });
  });
});
