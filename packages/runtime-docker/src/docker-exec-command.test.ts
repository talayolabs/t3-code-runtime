import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '@t3-code/runtime-protocol';

import { buildDockerExecInvocation } from './docker-exec-command.js';

describe('buildDockerExecInvocation', () => {
  it('builds a minimal argv with a "--" guard before the container name', () => {
    expect(buildDockerExecInvocation({ container: 't3ws-demo', command: 'ls' })).toEqual({
      argv: ['exec', '--', 't3ws-demo', 'ls'],
      env: {},
    });
  });

  it('passes arguments verbatim without any shell interpretation', () => {
    const { argv } = buildDockerExecInvocation({
      container: 'abc',
      command: 'sh',
      args: ['-c', 'echo $HOME && rm -rf "/"; --privileged'],
      workdir: '/workspace/repo',
      user: '1000:1000',
      interactive: true,
    });
    expect(argv).toEqual([
      'exec',
      '--interactive',
      '--workdir',
      '/workspace/repo',
      '--user',
      '1000:1000',
      '--',
      'abc',
      'sh',
      '-c',
      'echo $HOME && rm -rf "/"; --privileged',
    ]);
  });

  it('references environment variables by name only', () => {
    const { argv, env } = buildDockerExecInvocation({
      container: 'abc',
      command: 'env',
      env: { ZED: '1', API_TOKEN: 'secret-value' },
    });
    expect(argv).toEqual(['exec', '--env', 'API_TOKEN', '--env', 'ZED', '--', 'abc', 'env']);
    expect(argv.join(' ')).not.toContain('secret-value');
    expect(env).toEqual({ ZED: '1', API_TOKEN: 'secret-value' });
  });

  it('rejects flag-like environment names and malformed argv', () => {
    expect(() => buildDockerExecInvocation({ container: 'abc', command: 'env', env: { '--privileged': '1' } })).toThrow(
      InvalidArgumentError,
    );
    expect(() => buildDockerExecInvocation({ container: 'abc', command: '' })).toThrow(InvalidArgumentError);
    expect(() => buildDockerExecInvocation({ container: 'abc', command: 'ls', args: ['a\0b'] })).toThrow(
      InvalidArgumentError,
    );
  });
});
