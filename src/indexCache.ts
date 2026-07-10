import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RawUsage } from './scanCore';

// Bump when the parse output or serialization format changes, so an old cache
// (produced by different parsing logic) is discarded rather than trusted.
const SCHEMA = 1;

interface CacheEntry {
  mtime: number;
  raw: RawUsage[];
}

/**
 * A persistent, mtime-keyed cache of each file's parsed component usages. On a
 * warm start the whole-project index is rebuilt by reusing entries for files
 * whose mtime is unchanged and only re-parsing what actually changed.
 */
export class IndexCache {
  private entries = new Map<string, CacheEntry>();
  private readonly version: string;

  constructor(
    private readonly file: vscode.Uri,
    extensionVersion: string,
  ) {
    this.version = `${extensionVersion}#${SCHEMA}`;
  }

  clearEntries(): void {
    this.entries.clear();
  }

  /** Loads the cache from disk; silently starts empty on any problem or version mismatch. */
  async load(): Promise<void> {
    this.entries.clear();
    try {
      const buf = await fsp.readFile(this.file.fsPath, 'utf8');
      const data = JSON.parse(buf);
      if (data && data.version === this.version && data.files) {
        for (const [fsPath, entry] of Object.entries<any>(data.files)) {
          if (entry && typeof entry.mtime === 'number' && Array.isArray(entry.raw)) {
            this.entries.set(fsPath, { mtime: entry.mtime, raw: entry.raw });
          }
        }
      }
    } catch {
      /* no cache yet, or unreadable/invalid — start empty */
    }
  }

  /** Returns cached usages if the file is present and its mtime is unchanged. */
  get(fsPath: string, mtime: number): RawUsage[] | undefined {
    const entry = this.entries.get(fsPath);
    return entry && entry.mtime === mtime ? entry.raw : undefined;
  }

  set(fsPath: string, mtime: number, raw: RawUsage[]): void {
    this.entries.set(fsPath, { mtime, raw });
  }

  /** Drops entries for files that no longer exist. */
  prune(keep: Set<string>): void {
    for (const key of [...this.entries.keys()]) {
      if (!keep.has(key)) {
        this.entries.delete(key);
      }
    }
  }

  async save(): Promise<void> {
    const files: Record<string, CacheEntry> = {};
    for (const [k, v] of this.entries) {
      files[k] = v;
    }
    const json = JSON.stringify({ version: this.version, files });
    try {
      await fsp.mkdir(path.dirname(this.file.fsPath), { recursive: true });
      await fsp.writeFile(this.file.fsPath, json, 'utf8');
    } catch {
      /* best-effort — a failed cache write just means a colder next start */
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
