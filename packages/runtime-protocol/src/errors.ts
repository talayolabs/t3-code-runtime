import type { AgentLockOwner } from './agent-lock.js';
import type { WorkspaceStatus } from './workspace.js';

export type RuntimeErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_ALREADY_EXISTS'
  | 'INVALID_WORKSPACE_ID'
  | 'INVALID_PATH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'CONTAINER_MISSING'
  | 'CONTAINER_NOT_RUNNING'
  | 'AGENT_LOCK_HELD'
  | 'AGENT_LOCK_NOT_OWNED'
  | 'RUNTIME_UNAVAILABLE'
  | 'COMMAND_FAILED'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'IS_A_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'IMPORT_FAILED'
  | 'TIMEOUT'
  | 'INTERNAL';

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class WorkspaceNotFoundError extends RuntimeError {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super('WORKSPACE_NOT_FOUND', `Workspace "${workspaceId}" does not exist.`);
    this.workspaceId = workspaceId;
  }
}

export class WorkspaceAlreadyExistsError extends RuntimeError {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(
      'WORKSPACE_ALREADY_EXISTS',
      `Workspace "${workspaceId}" already exists. Pass reuseExisting: true to reconnect to its container.`,
    );
    this.workspaceId = workspaceId;
  }
}

export class InvalidWorkspaceIdError extends RuntimeError {
  constructor(value: string, reason: string) {
    super('INVALID_WORKSPACE_ID', `Invalid workspace id ${JSON.stringify(value)}: ${reason}`);
  }
}

export class InvalidPathError extends RuntimeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super('INVALID_PATH', `Invalid workspace path ${JSON.stringify(path)}: ${reason}`);
    this.path = path;
  }
}

export class InvalidArgumentError extends RuntimeError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message);
  }
}

export class InvalidWorkspaceStateError extends RuntimeError {
  readonly workspaceId: string;
  readonly from: WorkspaceStatus;
  readonly to: WorkspaceStatus;

  constructor(workspaceId: string, from: WorkspaceStatus, to: WorkspaceStatus) {
    super(
      'INVALID_STATE',
      `Workspace "${workspaceId}" cannot transition from "${from}" to "${to}".`,
    );
    this.workspaceId = workspaceId;
    this.from = from;
    this.to = to;
  }
}

export class ContainerMissingError extends RuntimeError {
  readonly workspaceId: string;
  readonly containerName: string;

  constructor(workspaceId: string, containerName: string) {
    super(
      'CONTAINER_MISSING',
      `The container "${containerName}" for workspace "${workspaceId}" no longer exists. ` +
        'Remove the workspace and create it again.',
    );
    this.workspaceId = workspaceId;
    this.containerName = containerName;
  }
}

export class ContainerNotRunningError extends RuntimeError {
  readonly workspaceId: string;

  constructor(workspaceId: string, status: WorkspaceStatus) {
    super(
      'CONTAINER_NOT_RUNNING',
      `Workspace "${workspaceId}" is ${status}. Start it before running commands.`,
    );
    this.workspaceId = workspaceId;
  }
}

export const AGENT_LOCK_HELD_MESSAGE =
  'This workspace already has an active agent session.\n' +
  'Create another workspace to run a second agent.';

export class AgentLockHeldError extends RuntimeError {
  readonly workspaceId: string;
  readonly owner: AgentLockOwner;

  constructor(workspaceId: string, owner: AgentLockOwner) {
    super(
      'AGENT_LOCK_HELD',
      `${AGENT_LOCK_HELD_MESSAGE}\n(workspace "${workspaceId}" is held by ${owner.ownerId} since ${owner.acquiredAt})`,
    );
    this.workspaceId = workspaceId;
    this.owner = owner;
  }
}

export class AgentLockNotOwnedError extends RuntimeError {
  constructor(workspaceId: string) {
    super(
      'AGENT_LOCK_NOT_OWNED',
      `The agent lock for workspace "${workspaceId}" is not owned by this handle.`,
    );
  }
}

export class RuntimeUnavailableError extends RuntimeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('RUNTIME_UNAVAILABLE', message, options);
  }
}

export class CommandFailedError extends RuntimeError {
  readonly exitCode: number;
  readonly stderr: string;
  readonly command: string[];

  constructor(command: string[], exitCode: number, stderr: string) {
    super(
      'COMMAND_FAILED',
      `Command ${JSON.stringify(command)} exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`,
    );
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.command = command;
  }
}

export class FileNotFoundError extends RuntimeError {
  readonly path: string;

  constructor(path: string) {
    super('FILE_NOT_FOUND', `No such file or directory: ${path}`);
    this.path = path;
  }
}

export class NotADirectoryError extends RuntimeError {
  readonly path: string;

  constructor(path: string) {
    super('NOT_A_DIRECTORY', `Not a directory: ${path}`);
    this.path = path;
  }
}

export class IsADirectoryError extends RuntimeError {
  readonly path: string;

  constructor(path: string) {
    super('IS_A_DIRECTORY', `Is a directory: ${path}`);
    this.path = path;
  }
}

export class PermissionDeniedError extends RuntimeError {
  readonly path: string;

  constructor(path: string) {
    super('PERMISSION_DENIED', `Permission denied: ${path}`);
    this.path = path;
  }
}

export class ImportFailedError extends RuntimeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('IMPORT_FAILED', message, options);
  }
}

export class TimeoutError extends RuntimeError {
  constructor(message: string) {
    super('TIMEOUT', message);
  }
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  return value instanceof RuntimeError;
}
