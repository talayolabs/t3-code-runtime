export {
  AgentLockManager,
  DEFAULT_LOCK_STALE_AFTER_MS,
  isAgentLockStale,
  isProcessAlive,
  parseAgentLockOwner,
} from './agent-lock.js';
export type { AgentLockManagerOptions } from './agent-lock.js';
export { assertCommandArgv, assertEnvironment, formatCommandForLog, splitAtDoubleDash } from './command-line.js';
export { mapFileCommandError, toError } from './error-mapping.js';
export type { FailedCommand } from './error-mapping.js';
export {
  DEFAULT_CONTAINER_NAME_PREFIX,
  MAX_WORKSPACE_ID_LENGTH,
  assertWorkspaceId,
  containerNameForWorkspace,
  defaultBranchForWorkspace,
  isNormalizedWorkspaceId,
  normalizeWorkspaceId,
  workspaceIdFromContainerName,
} from './workspace-identity.js';
export {
  WORKSPACE_TRANSITIONS,
  assertTransition,
  canTransition,
  isOperable,
  isRetained,
} from './workspace-lifecycle.js';
export {
  WORKSPACE_METADATA_VERSION,
  createWorkspaceMetadata,
  parseWorkspaceMetadata,
  serializeWorkspaceMetadata,
} from './workspace-metadata.js';
export type { NewWorkspaceMetadata, WorkspaceMetadataFile } from './workspace-metadata.js';
export {
  AGENT_LOCK_FILE_NAME,
  METADATA_FILE_NAME,
  WorkspaceMetadataStore,
  defaultStateDir,
} from './workspace-metadata-store.js';
export {
  assertRepositoryRoot,
  joinWorkspaceRelative,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from './workspace-path.js';
export type { ResolvedWorkspacePath } from './workspace-path.js';
