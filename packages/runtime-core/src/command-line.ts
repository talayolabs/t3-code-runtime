import { InvalidArgumentError } from '@t3-code/runtime-protocol';

/**
 * Validate a program name and its arguments for argv-based execution. The
 * runtime never builds shell strings; every argument is passed verbatim to
 * `spawn`/`docker exec`, so the only things we reject are values that cannot
 * be represented in an argv vector at all.
 */
export function assertCommandArgv(command: string, args: readonly string[] = []): string[] {
  if (typeof command !== 'string' || command.length === 0) {
    throw new InvalidArgumentError('command must be a non-empty string');
  }
  if (command.includes('\0')) {
    throw new InvalidArgumentError('command must not contain NUL bytes');
  }
  if (!Array.isArray(args)) {
    throw new InvalidArgumentError('args must be an array of strings');
  }
  const checked: string[] = [command];
  (args as readonly unknown[]).forEach((arg, index) => {
    if (typeof arg !== 'string') {
      throw new InvalidArgumentError(`args[${index}] must be a string`);
    }
    if (arg.includes('\0')) {
      throw new InvalidArgumentError(`args[${index}] must not contain NUL bytes`);
    }
    checked.push(arg);
  });
  return checked;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate environment variable names; values are opaque and never logged. */
export function assertEnvironment(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (env === undefined) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) {
      throw new InvalidArgumentError(`invalid environment variable name ${JSON.stringify(name)}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new InvalidArgumentError(`environment variable ${name} must be a string without NUL bytes`);
    }
    result[name] = value;
  }
  return result;
}

const SECRET_NAME = /(token|secret|password|passwd|key|credential|auth|cookie)/i;

/**
 * Render a command for logs. Environment values are never included; names
 * that look like secrets are marked so they can be spotted in output without
 * revealing anything.
 */
export function formatCommandForLog(argv: readonly string[], env?: Readonly<Record<string, string>>): string {
  const rendered = argv.map((arg) => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
  if (!env || Object.keys(env).length === 0) return rendered;
  const names = Object.keys(env)
    .sort()
    .map((name) => (SECRET_NAME.test(name) ? `${name}=<redacted>` : `${name}=…`));
  return `[env: ${names.join(' ')}] ${rendered}`;
}

/**
 * Split CLI style arguments at the first `--`.
 * `runtime exec ws -- ls -la` → `{ before: ['exec','ws'], after: ['ls','-la'] }`.
 */
export function splitAtDoubleDash(argv: readonly string[]): { before: string[]; after: string[] | null } {
  const index = argv.indexOf('--');
  if (index === -1) return { before: [...argv], after: null };
  return { before: argv.slice(0, index), after: argv.slice(index + 1) };
}
