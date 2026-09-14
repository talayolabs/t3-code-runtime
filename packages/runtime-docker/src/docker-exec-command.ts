import { assertCommandArgv, assertEnvironment } from '@t3-code/runtime-core';

export interface DockerExecSpec {
  container: string;
  command: string;
  args?: readonly string[];
  /** Absolute container path. */
  workdir?: string;
  env?: Readonly<Record<string, string>>;
  user?: string;
  /** Keep stdin open (`-i`). */
  interactive?: boolean;
}

export interface DockerExecInvocation {
  /** Arguments for the `docker` binary. */
  argv: string[];
  /** Environment that must be present in the `docker` process for `-e NAME` pass-through. */
  env: Record<string, string>;
}

/**
 * Build a `docker exec` invocation. Environment values are passed to the
 * `docker` process environment and referenced as `-e NAME` so they never show
 * up in the argument vector (and therefore in `ps` output or logs).
 */
export function buildDockerExecInvocation(spec: DockerExecSpec): DockerExecInvocation {
  const command = assertCommandArgv(spec.command, spec.args ?? []);
  const env = assertEnvironment(spec.env);
  const argv: string[] = ['exec'];
  if (spec.interactive) argv.push('--interactive');
  if (spec.workdir !== undefined) argv.push('--workdir', spec.workdir);
  if (spec.user !== undefined) argv.push('--user', spec.user);
  for (const name of Object.keys(env).sort()) argv.push('--env', name);
  argv.push('--', spec.container, ...command);
  return { argv, env };
}
