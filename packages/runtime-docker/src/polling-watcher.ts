import { randomUUID } from 'node:crypto';

import { joinWorkspaceRelative, toError } from '@t3-code/runtime-core';
import type { FileChangeEvent, FileChangeListener, FileEntryKind, WatchHandle } from '@t3-code/runtime-protocol';

import type { ContainerExec } from './container-files.js';
import { STAT_FORMAT, fileKindFromStat } from './container-files.js';

export const DEFAULT_WATCH_INTERVAL_MS = 1_000;

/**
 * Snapshot of a directory tree keyed by workspace-relative path.
 * Symlinks are recorded but not followed; `.git` is skipped.
 */
export type TreeSnapshot = Map<string, TreeEntry>;

export interface TreeEntry {
  kind: FileEntryKind;
  size: number;
  mtimeMs: number;
}

const SNAPSHOT_SCRIPT = `cd -- "$1" && find . -name .git -prune -o -mindepth 1 -exec stat -c '${STAT_FORMAT}' {} +`;

export function parseTreeSnapshot(output: string): TreeSnapshot {
  const snapshot: TreeSnapshot = new Map();
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [kind, size, mtime, ...nameParts] = parts;
    const raw = nameParts.join('\t');
    const relative = raw.startsWith('./') ? raw.slice(2) : raw;
    snapshot.set(relative, {
      kind: fileKindFromStat(kind ?? ''),
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    });
  }
  return snapshot;
}

/**
 * Diff two snapshots. A delete and a create of entries with identical kind,
 * size and mtime within the same poll are reported as a single `rename`;
 * anything else becomes separate `delete`/`create` events. Modifications are
 * detected from size or mtime changes only (1s mtime resolution), so a
 * same-second rewrite that keeps the size is invisible to this watcher.
 */
export function diffTreeSnapshots(
  previous: TreeSnapshot,
  next: TreeSnapshot,
  baseRelative: string,
  timestamp: number,
): FileChangeEvent[] {
  const events: FileChangeEvent[] = [];
  const created: { path: string; entry: TreeEntry }[] = [];
  const deleted: { path: string; entry: TreeEntry }[] = [];

  for (const [relative, entry] of next) {
    const before = previous.get(relative);
    if (!before) {
      created.push({ path: relative, entry });
    } else if (before.kind !== entry.kind || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) {
      events.push({
        type: 'modify',
        path: joinWorkspaceRelative(baseRelative, relative),
        kind: entry.kind,
        timestamp,
      });
    }
  }
  for (const [relative, entry] of previous) {
    if (!next.has(relative)) deleted.push({ path: relative, entry });
  }

  for (const add of created) {
    const index = deleted.findIndex(
      (del) =>
        del.entry.kind === add.entry.kind &&
        del.entry.kind !== 'directory' &&
        del.entry.size === add.entry.size &&
        del.entry.mtimeMs === add.entry.mtimeMs,
    );
    if (index !== -1) {
      const [del] = deleted.splice(index, 1);
      events.push({
        type: 'rename',
        path: joinWorkspaceRelative(baseRelative, add.path),
        previousPath: joinWorkspaceRelative(baseRelative, del?.path ?? add.path),
        kind: add.entry.kind,
        timestamp,
      });
      continue;
    }
    events.push({ type: 'create', path: joinWorkspaceRelative(baseRelative, add.path), kind: add.entry.kind, timestamp });
  }
  for (const del of deleted) {
    events.push({ type: 'delete', path: joinWorkspaceRelative(baseRelative, del.path), kind: del.entry.kind, timestamp });
  }
  return events.sort((a, b) => a.path.localeCompare(b.path));
}

export interface PollingWatcherOptions {
  intervalMs?: number;
}

/**
 * Container-side polling watcher. Each tick runs a single `find | stat`
 * inside the container via `docker exec`; no long-lived Docker process is
 * kept, so closing the watcher cannot leak one. Ticks never overlap.
 */
export class PollingWatcher implements WatchHandle {
  readonly id = randomUUID();
  readonly strategy = 'polling' as const;

  private previous: TreeSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private closed = false;
  private readonly closeListeners = new Set<(error: Error | null) => void>();
  private readonly intervalMs: number;

  constructor(
    readonly path: string,
    private readonly absolutePath: string,
    private readonly exec: ContainerExec,
    private readonly listener: FileChangeListener,
    options: PollingWatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  }

  /** Take the initial snapshot; throws if the directory cannot be read. */
  async start(): Promise<void> {
    this.previous = await this.snapshot();
    this.schedule();
  }

  /** Run one poll immediately (used by tests and by `flush`-style callers). */
  async poll(): Promise<FileChangeEvent[]> {
    if (this.closed || this.polling) return [];
    this.polling = true;
    try {
      const next = await this.snapshot();
      const events = this.previous ? diffTreeSnapshots(this.previous, next, this.path, Date.now()) : [];
      this.previous = next;
      if (events.length > 0 && !this.closed) this.listener(events);
      return events;
    } finally {
      this.polling = false;
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.emitClose(null);
    }
    return Promise.resolve();
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.poll()
        .then(() => {
          this.schedule();
        })
        .catch((error: unknown) => {
          this.closed = true;
          this.emitClose(toError(error));
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  private emitClose(error: Error | null): void {
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }

  private async snapshot(): Promise<TreeSnapshot> {
    const result = await this.exec('sh', ['-c', SNAPSHOT_SCRIPT, 't3-watch', this.absolutePath]);
    if (result.exitCode !== 0) {
      throw new Error(`watcher snapshot failed (exit ${String(result.exitCode)}): ${result.stderr.toString('utf8').trim()}`);
    }
    return parseTreeSnapshot(result.stdout.toString('utf8'));
  }
}
