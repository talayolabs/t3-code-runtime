import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceNotFoundError, type WorkspaceMetadata } from '@t3-code/runtime-protocol';

import { assertWorkspaceId, isNormalizedWorkspaceId } from './workspace-identity.js';
import { parseWorkspaceMetadata, serializeWorkspaceMetadata } from './workspace-metadata.js';

export const METADATA_FILE_NAME = 'metadata.json';
export const AGENT_LOCK_FILE_NAME = 'agent.lock';

/** Default state directory: `$T3_CODE_RUNTIME_HOME` or `~/.t3-code-runtime`. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['T3_CODE_RUNTIME_HOME'];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.t3-code-runtime');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Persists workspace metadata as one JSON file per workspace under a state
 * directory that lives outside of any source checkout:
 *
 * ```text
 * <stateDir>/workspaces/<workspaceId>/metadata.json
 * <stateDir>/workspaces/<workspaceId>/agent.lock
 * ```
 *
 * Writes are atomic (temp file + rename) so a crash never leaves a truncated
 * metadata document behind.
 */
export class WorkspaceMetadataStore {
  readonly stateDir: string;

  constructor(stateDir: string = defaultStateDir()) {
    this.stateDir = path.resolve(stateDir);
  }

  get workspacesDir(): string {
    return path.join(this.stateDir, 'workspaces');
  }

  workspaceDir(workspaceId: string): string {
    return path.join(this.workspacesDir, assertWorkspaceId(workspaceId));
  }

  metadataPath(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), METADATA_FILE_NAME);
  }

  agentLockPath(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), AGENT_LOCK_FILE_NAME);
  }

  async exists(workspaceId: string): Promise<boolean> {
    return (await this.read(workspaceId)) !== null;
  }

  /** Returns `null` when no metadata exists for the workspace. */
  async read(workspaceId: string): Promise<WorkspaceMetadata | null> {
    let content: string;
    try {
      content = await fs.readFile(this.metadataPath(workspaceId), 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    }
    return parseWorkspaceMetadata(JSON.parse(content));
  }

  async require(workspaceId: string): Promise<WorkspaceMetadata> {
    const metadata = await this.read(workspaceId);
    if (metadata === null) throw new WorkspaceNotFoundError(workspaceId);
    return metadata;
  }

  async write(metadata: WorkspaceMetadata): Promise<void> {
    const dir = this.workspaceDir(metadata.workspaceId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, METADATA_FILE_NAME);
    const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temp, serializeWorkspaceMetadata(metadata), { mode: 0o600 });
    await fs.rename(temp, target);
  }

  /** Apply a patch and bump `updatedAt`. */
  async update(
    workspaceId: string,
    patch: Partial<Omit<WorkspaceMetadata, 'workspaceId' | 'createdAt'>>,
    now: Date = new Date(),
  ): Promise<WorkspaceMetadata> {
    const current = await this.require(workspaceId);
    const next: WorkspaceMetadata = { ...current, ...patch, workspaceId: current.workspaceId, updatedAt: now.toISOString() };
    await this.write(next);
    return next;
  }

  /** Remove the whole per-workspace directory (metadata and lock). Idempotent. */
  async delete(workspaceId: string): Promise<void> {
    await fs.rm(this.workspaceDir(workspaceId), { recursive: true, force: true });
  }

  async list(): Promise<WorkspaceMetadata[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.workspacesDir);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const results: WorkspaceMetadata[] = [];
    for (const entry of entries.sort()) {
      if (!isNormalizedWorkspaceId(entry)) continue;
      const metadata = await this.read(entry);
      if (metadata !== null) results.push(metadata);
    }
    return results;
  }
}
