import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CommandFailedError, type ExecResult, type RepositoryImportMode } from '@t3-code/runtime-protocol';

import type { ContainerExec } from './container-files.js';
import type { DockerCli } from './docker-cli.js';

export interface RepositoryImportRequest {
  containerId: string;
  /** Absolute host directory that is only ever read. */
  sourcePath: string;
  /** Absolute container path of the checkout. */
  repositoryPath: string;
  branch: string;
  mode: RepositoryImportMode | 'auto';
}

export interface RepositoryImportResult {
  mode: RepositoryImportMode;
  /** Commit checked out inside the container. */
  head: string;
}

/** Identity used for the synthetic commit created when importing a plain folder. */
export const IMPORT_COMMIT_IDENTITY = {
  name: 'T3 Code Runtime',
  email: 't3-code-runtime@localhost',
} as const;

const IMPORT_TIMEOUT_MS = 10 * 60_000;

/**
 * Imports a host directory into the workspace container without mounting it.
 *
 * - Git repositories: `git bundle create --all` on the host, `docker cp` the
 *   bundle into the container, `git clone` it there and check out `branch`.
 *   Only committed history travels; the host working tree is never touched.
 * - Plain folders: `tar -c` on the host streamed into `docker cp -`, followed
 *   by `git init` + one import commit inside the container so Git operations
 *   work uniformly.
 *
 * Every host command runs with an argv array; nothing is shell-interpolated.
 */
export class RepositoryImporter {
  constructor(
    private readonly docker: DockerCli,
    private readonly gitBinary = 'git',
    private readonly tarBinary = 'tar',
  ) {}

  async detectMode(sourcePath: string, requested: RepositoryImportMode | 'auto'): Promise<RepositoryImportMode> {
    if (requested !== 'auto') return requested;
    const result = await runHost(this.gitBinary, ['-C', sourcePath, 'rev-parse', '--is-inside-work-tree']);
    if (result.exitCode !== 0 || result.stdout.trim() !== 'true') return 'tar';
    const head = await runHost(this.gitBinary, ['-C', sourcePath, 'rev-parse', '--verify', '-q', 'HEAD']);
    // A Git repository with no commits cannot be bundled.
    return head.exitCode === 0 ? 'git-bundle' : 'tar';
  }

  async import(request: RepositoryImportRequest, exec: ContainerExec): Promise<RepositoryImportResult> {
    const source = await fs.realpath(request.sourcePath);
    const stat = await fs.stat(source);
    if (!stat.isDirectory()) {
      throw new CommandFailedError(['import', source], 1, `${request.sourcePath} is not a directory`);
    }
    const mode = await this.detectMode(source, request.mode);
    const parent = path.posix.dirname(request.repositoryPath);
    await this.run(exec, 'mkdir', ['-p', parent]);

    if (mode === 'git-bundle') {
      await this.importGitBundle(request, source, exec);
    } else {
      await this.importTar(request, source, exec);
    }
    const head = await this.run(exec, 'git', ['-C', request.repositoryPath, 'rev-parse', 'HEAD']);
    return { mode, head: head.stdout.toString('utf8').trim() };
  }

  private async importGitBundle(request: RepositoryImportRequest, source: string, exec: ContainerExec): Promise<void> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-code-runtime-'));
    const bundlePath = path.join(tempDir, 'repo.bundle');
    const containerBundle = `/tmp/t3-import-${randomUUID()}.bundle`;
    try {
      const bundle = await runHost(this.gitBinary, ['-C', source, 'bundle', 'create', bundlePath, '--all']);
      if (bundle.exitCode !== 0) {
        throw new CommandFailedError(['git', 'bundle', 'create'], bundle.exitCode, bundle.stderr.trim());
      }
      const headRef = await runHost(this.gitBinary, ['-C', source, 'symbolic-ref', '--short', '-q', 'HEAD']);
      const sourceBranch = headRef.exitCode === 0 ? headRef.stdout.trim() : null;

      const cp = await this.docker.run(['cp', '--', bundlePath, `${request.containerId}:${containerBundle}`], {
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      if (cp.exitCode !== 0) {
        throw new CommandFailedError(['docker', 'cp', 'repo.bundle'], cp.exitCode, cp.stderr.toString('utf8').trim());
      }

      await this.run(exec, 'rm', ['-rf', '--', request.repositoryPath]);
      await this.run(exec, 'git', ['init', '--quiet', '--initial-branch', request.branch, '--', request.repositoryPath]);
      // Materialize every bundled branch and tag locally so `git log --all` matches the host.
      await this.run(exec, 'git', [
        '-C',
        request.repositoryPath,
        'fetch',
        '--quiet',
        '--update-head-ok',
        '--',
        containerBundle,
        '+refs/heads/*:refs/heads/*',
        '+refs/tags/*:refs/tags/*',
      ]);
      const startPoint = sourceBranch ?? (await this.bundleHead(exec, containerBundle));
      await this.run(exec, 'git', ['-C', request.repositoryPath, 'checkout', '--quiet', '-B', request.branch, startPoint]);
    } finally {
      await exec('rm', ['-f', '--', containerBundle]).catch(() => undefined);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  /** Commit the bundle's HEAD points at (detached HEAD on the host). */
  private async bundleHead(exec: ContainerExec, containerBundle: string): Promise<string> {
    const result = await this.run(exec, 'git', ['bundle', 'list-heads', '--', containerBundle, 'HEAD']);
    const line = result.stdout.toString('utf8').split('\n').find((entry) => entry.endsWith(' HEAD'));
    if (!line) throw new CommandFailedError(['git', 'bundle', 'list-heads'], 1, 'bundle has no HEAD');
    return line.split(' ')[0] ?? 'HEAD';
  }

  private async importTar(request: RepositoryImportRequest, source: string, exec: ContainerExec): Promise<void> {
    await this.run(exec, 'rm', ['-rf', '--', request.repositoryPath]);
    await this.run(exec, 'mkdir', ['-p', '--', request.repositoryPath]);
    await this.streamTarIntoContainer(source, `${request.containerId}:${request.repositoryPath}`);
    // `docker cp` keeps host uids; hand the tree to the user that runs commands in the container,
    // otherwise Git refuses the repository ("dubious ownership").
    await this.run(exec, 'sh', ['-c', 'chown -R "$(id -u):$(id -g)" "$1"', 't3-import', request.repositoryPath]);

    const git = (...args: string[]): Promise<unknown> =>
      this.run(exec, 'git', [
          '-C',
          request.repositoryPath,
          '-c',
          `user.name=${IMPORT_COMMIT_IDENTITY.name}`,
          '-c',
          `user.email=${IMPORT_COMMIT_IDENTITY.email}`,
          ...args,
        ]);
    await git('init', '--quiet', '--initial-branch', request.branch);
    await git('add', '--all');
    await git('commit', '--quiet', '--allow-empty', '--no-verify', '--message', `Import ${path.basename(source)}`);
  }

  /**
   * `tar -C <source> -cf - .` on the host piped into `docker cp - <container>:<dir>`.
   * A `.git` directory (e.g. a repository without commits) is left behind; tar mode
   * always starts a fresh history inside the container.
   */
  private streamTarIntoContainer(source: string, destination: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tar = spawn(this.tarBinary, ['-C', source, '--exclude=./.git', '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const cp = this.docker.spawn(['cp', '--', '-', destination], { stdin: 'pipe' });
      const stderr: Buffer[] = [];
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        tar.kill('SIGKILL');
        cp.kill('SIGKILL');
        reject(error);
      };

      tar.on('error', fail);
      cp.on('error', fail);
      tar.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      cp.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      tar.stdout?.pipe(cp.stdin as NodeJS.WritableStream);
      cp.stdin?.on('error', () => undefined);

      let tarCode: number | null = null;
      let cpCode: number | null = null;
      const check = (): void => {
        if (settled || tarCode === null || cpCode === null) return;
        settled = true;
        if (tarCode !== 0 || cpCode !== 0) {
          reject(
            new CommandFailedError(
              ['tar | docker cp'],
              tarCode !== 0 ? tarCode : cpCode,
              Buffer.concat(stderr).toString('utf8').trim(),
            ),
          );
          return;
        }
        resolve();
      };
      tar.on('close', (code) => {
        tarCode = code ?? 1;
        check();
      });
      cp.on('close', (code) => {
        cpCode = code ?? 1;
        check();
      });
    });
  }

  private async run(exec: ContainerExec, command: string, args: string[]): Promise<ExecResult> {
    const result = await exec(command, args, { timeoutMs: IMPORT_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new CommandFailedError([command, ...args], result.exitCode, result.stderr.toString('utf8').trim());
    }
    return result;
  }
}

interface HostCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHost(binary: string, args: string[]): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
