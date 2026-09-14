import { describe, expect, it } from 'vitest';

import { CLI_USAGE, parseFlags, runCli } from '@t3-code/runtime-docker';

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: { write: (chunk: string | Uint8Array) => (out.push(chunk.toString()), true) } as unknown as NodeJS.WritableStream,
    stderr: { write: (chunk: string | Uint8Array) => (err.push(chunk.toString()), true) } as unknown as NodeJS.WritableStream,
    stdin: process.stdin,
    env: {},
  };
  return { io, out, err };
}

describe('parseFlags', () => {
  it('separates positionals from value and boolean flags', () => {
    const parsed = parseFlags(['create', 'demo', '--source', '/tmp/x', '--json', '--image=alpine', '--no-start']);
    expect(parsed.positional).toEqual(['create', 'demo']);
    expect(parsed.flags.get('source')).toBe('/tmp/x');
    expect(parsed.flags.get('image')).toBe('alpine');
    expect(parsed.flags.get('json')).toBe(true);
    expect(parsed.flags.get('no-start')).toBe(true);
  });

  it('requires values for value flags', () => {
    expect(() => parseFlags(['create', '--source'])).toThrow(/--source requires a value/);
  });
});

describe('runCli argument handling', () => {
  it('prints usage without arguments and with --help', async () => {
    const a = fakeIo();
    expect(await runCli([], a.io)).toBe(2);
    expect(a.out.join('')).toBe(CLI_USAGE);

    const b = fakeIo();
    expect(await runCli(['--help'], b.io)).toBe(0);
    expect(b.out.join('')).toBe(CLI_USAGE);
  });

  it('rejects unknown commands and missing positionals before touching Docker', async () => {
    const a = fakeIo();
    expect(await runCli(['frobnicate'], a.io)).toBe(2);
    expect(a.err.join('')).toContain('unknown command "frobnicate"');

    const b = fakeIo();
    expect(await runCli(['exec', 'ws'], b.io)).toBe(2);
    expect(b.err.join('')).toMatch(/--/);

    const c = fakeIo();
    expect(await runCli(['ls'], c.io)).toBe(2);
    expect(c.err.join('')).toContain('missing <workspace>');

    const d = fakeIo();
    expect(await runCli(['create', 'demo', '--import', 'zip'], d.io)).toBe(2);
    expect(d.err.join('')).toContain('--import must be git-bundle or tar');
  });
});
