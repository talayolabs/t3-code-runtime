/**
 * Ownership record stored in the durable agent lock. Everything in here is
 * safe to show to users; it never contains credentials.
 */
export interface AgentLockOwner {
  /** Caller supplied owner label (for example a session id). */
  ownerId: string;
  /** Random token proving ownership of the lock; required to release it. */
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  /** Last heartbeat written by the owner. */
  heartbeatAt: string;
  /** Milliseconds without heartbeat after which the lock is considered stale. */
  staleAfterMs: number;
}

export interface AcquireAgentLockOptions {
  /** Human readable owner id. Defaults to `pid@hostname`. */
  ownerId?: string;
  /**
   * Process whose liveness backs the lock. Defaults to the current process;
   * the CLI records its parent so the lock outlives the short-lived command.
   */
  ownerPid?: number;
  /**
   * A lock whose heartbeat is older than this is reclaimable. Default: 5 minutes.
   * Set to `0` to disable heartbeat based staleness (only dead local processes are stale).
   */
  staleAfterMs?: number;
  /** When `true` (default) a stale lock is reclaimed automatically. */
  reclaimStale?: boolean;
  /**
   * Interval of the automatic heartbeat timer. Defaults to a third of
   * `staleAfterMs`; `0` disables the timer (call `heartbeat()` manually).
   */
  heartbeatIntervalMs?: number;
}

export interface AgentLockHandle {
  readonly workspaceId: string;
  readonly owner: AgentLockOwner;
  /** Refresh the heartbeat so the lock is not considered stale. */
  heartbeat(): Promise<void>;
  /** Release the lock. Idempotent: releasing twice is a no-op. */
  release(): Promise<void>;
}

export interface AgentLockStatus {
  workspaceId: string;
  locked: boolean;
  owner: AgentLockOwner | null;
  /** `true` when a lock exists but its owner is considered gone. */
  stale: boolean;
}
