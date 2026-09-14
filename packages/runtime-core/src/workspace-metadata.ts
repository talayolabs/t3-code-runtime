import {
  InvalidArgumentError,
  type RepositoryImportMode,
  type RuntimeKind,
  type WorkspaceMetadata,
  type WorkspaceStatus,
} from '@t3-code/runtime-protocol';

import { assertWorkspaceId } from './workspace-identity.js';
import { assertRepositoryRoot } from './workspace-path.js';

export const WORKSPACE_METADATA_VERSION = 1;

/** On-disk shape: metadata plus a schema version for future migrations. */
export interface WorkspaceMetadataFile extends WorkspaceMetadata {
  version: typeof WORKSPACE_METADATA_VERSION;
}

export interface NewWorkspaceMetadata {
  workspaceId: string;
  runtime: RuntimeKind;
  containerName: string;
  image: string;
  repositoryPath: string;
  branch: string;
  sourcePath?: string | null;
  importMode?: RepositoryImportMode | null;
  labels?: Record<string, string>;
  now?: Date;
}

export function createWorkspaceMetadata(input: NewWorkspaceMetadata): WorkspaceMetadata {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    workspaceId: assertWorkspaceId(input.workspaceId),
    runtime: input.runtime,
    containerId: null,
    containerName: input.containerName,
    image: input.image,
    repositoryPath: assertRepositoryRoot(input.repositoryPath),
    branch: input.branch,
    sourcePath: input.sourcePath ?? null,
    importMode: input.importMode ?? null,
    status: 'creating',
    createdAt: timestamp,
    updatedAt: timestamp,
    labels: { ...(input.labels ?? {}) },
  };
}

const STATUSES: readonly WorkspaceStatus[] = ['creating', 'created', 'running', 'stopped', 'removed', 'missing'];
const RUNTIMES: readonly RuntimeKind[] = ['docker', 'ssh'];
const IMPORT_MODES: readonly RepositoryImportMode[] = ['git-bundle', 'tar'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`workspace metadata field "${key}" must be a string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`workspace metadata field "${key}" must be a string or null`);
  }
  return value;
}

function requireOneOf<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = requireString(record, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`workspace metadata field "${key}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireIsoDate(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidArgumentError(`workspace metadata field "${key}" must be an ISO-8601 date`);
  }
  return value;
}

/** Parse and validate a metadata document read from disk. */
export function parseWorkspaceMetadata(raw: unknown): WorkspaceMetadata {
  if (!isRecord(raw)) {
    throw new InvalidArgumentError('workspace metadata must be a JSON object');
  }
  if (raw['version'] !== undefined && raw['version'] !== WORKSPACE_METADATA_VERSION) {
    throw new InvalidArgumentError(
      `unsupported workspace metadata version ${JSON.stringify(raw['version'])} (expected ${WORKSPACE_METADATA_VERSION})`,
    );
  }
  const labelsRaw = raw['labels'] ?? {};
  if (!isRecord(labelsRaw) || Object.values(labelsRaw).some((v) => typeof v !== 'string')) {
    throw new InvalidArgumentError('workspace metadata field "labels" must be a string map');
  }
  const importModeRaw = optionalString(raw, 'importMode');
  if (importModeRaw !== null && !(IMPORT_MODES as readonly string[]).includes(importModeRaw)) {
    throw new InvalidArgumentError(`workspace metadata field "importMode" must be one of ${IMPORT_MODES.join(', ')}`);
  }

  return {
    workspaceId: assertWorkspaceId(requireString(raw, 'workspaceId')),
    runtime: requireOneOf(raw, 'runtime', RUNTIMES),
    containerId: optionalString(raw, 'containerId'),
    containerName: requireString(raw, 'containerName'),
    image: requireString(raw, 'image'),
    repositoryPath: assertRepositoryRoot(requireString(raw, 'repositoryPath')),
    branch: requireString(raw, 'branch'),
    sourcePath: optionalString(raw, 'sourcePath'),
    importMode: importModeRaw as RepositoryImportMode | null,
    status: requireOneOf(raw, 'status', STATUSES),
    createdAt: requireIsoDate(raw, 'createdAt'),
    updatedAt: requireIsoDate(raw, 'updatedAt'),
    labels: labelsRaw as Record<string, string>,
  };
}

export function serializeWorkspaceMetadata(metadata: WorkspaceMetadata): string {
  const file: WorkspaceMetadataFile = { version: WORKSPACE_METADATA_VERSION, ...metadata };
  return `${JSON.stringify(file, null, 2)}\n`;
}
