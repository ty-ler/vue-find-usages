import * as os from 'os';
import { promises as fsp } from 'fs';
import * as vscode from 'vscode';
import { ComponentTarget } from './names';
import {
  extractComponentUsages,
  findUsagesInDocument,
  ImportResolver,
  IndexedUsage,
  rawToUsage,
  Usage,
} from './scanner';
import { extractRawUsages, RawUsage } from './scanCore';
import { IndexCache } from './indexCache';
import { ParsePool, recommendedWorkerCount } from './parsePool';
import { clearResolveCache, importResolvesToVue } from './resolve';

export interface ScanOptions {
  include: string;
  exclude: string;
  includeImports: boolean;
  parallel: boolean;
  resolver: ImportResolver;
}

export function getScanOptions(): ScanOptions {
  const config = vscode.workspace.getConfiguration('vueFindUsages');
  return {
    include: config.get<string>('include', '**/*.{vue,js,ts,jsx,tsx,mjs,cjs}'),
    exclude: config.get<string>('exclude', '**/{node_modules,dist,.git}/**'),
    includeImports: config.get<boolean>('includeImports', true),
    parallel: config.get<boolean>('parallelIndexing', true),
    resolver: importResolvesToVue,
  };
}

export type ProgressReporter = (processed: number, total: number, found: number) => void;

/** Concurrency for file reads — I/O bound, so a generous pool hides latency. */
const READ_CONCURRENCY = Math.max(8, os.cpus().length * 2);

/** Below this many files to parse, worker startup isn't worth it — parse inline. */
const WORKER_THRESHOLD = 200;

/**
 * Reads a file's text. Prefers the in-memory content of an already-open editor
 * (so unsaved edits are respected) and otherwise reads straight from disk —
 * much cheaper than materializing a full `vscode.TextDocument`.
 */
export async function readFileText(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  if (open) {
    return open.getText();
  }
  try {
    return await fsp.readFile(uri.fsPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Scans every workspace file matching the configured globs and returns all
 * usages of the target component.
 */
export async function scanWorkspace(
  target: ComponentTarget,
  options: ScanOptions,
  token?: vscode.CancellationToken,
  onProgress?: ProgressReporter,
): Promise<Usage[]> {
  const files = await vscode.workspace.findFiles(
    options.include,
    options.exclude,
    undefined,
    token,
  );

  const found: Usage[] = [];
  let processed = 0;

  await mapConcurrent(
    files,
    READ_CONCURRENCY,
    async (file) => {
      const text = await readFileText(file);
      if (text != null) {
        for (const usage of findUsagesInDocument(file, text, target, options.resolver)) {
          if (!isFilteredOut(usage, options)) {
            found.push(usage);
          }
        }
      }
      processed++;
      if (onProgress && processed % 25 === 0) {
        onProgress(processed, files.length, found.length);
      }
    },
    token,
  );

  return found;
}

/** The usages of one file, honoring the includeImports option. */
export function indexUsagesForFile(
  uri: vscode.Uri,
  text: string,
  options: ScanOptions,
): IndexedUsage[] {
  return extractComponentUsages(uri, text, options.resolver).filter(
    (u) => !isFilteredOut(u.usage, options),
  );
}

/**
 * Builds the whole-project index in one pass: every file is read and parsed once
 * and every component usage is grouped by its normalized key. When a cache is
 * supplied, files whose mtime is unchanged are served from it instead of being
 * re-parsed (`force` re-parses everything and refreshes the cache).
 */
export async function buildProjectIndex(
  options: ScanOptions,
  token?: vscode.CancellationToken,
  onProgress?: ProgressReporter,
  cache?: IndexCache,
  force = false,
): Promise<Map<string, Usage[]>> {
  clearResolveCache();

  const files = await vscode.workspace.findFiles(
    options.include,
    options.exclude,
    undefined,
    token,
  );

  const index = new Map<string, Usage[]>();
  const seen = new Set<string>();
  const mtimes = new Map<string, number>();
  let processed = 0;
  let total = 0;

  // Merging is synchronous (single-threaded), so no locking is needed even when
  // results arrive from multiple worker threads.
  const merge = (fsPath: string, raw: RawUsage[]) => {
    const uri = vscode.Uri.file(fsPath);
    for (const r of raw) {
      if (isRawFilteredOut(r, options)) {
        continue;
      }
      const usage = rawToUsage(uri, r);
      const bucket = index.get(r.key);
      if (bucket) {
        bucket.push(usage);
      } else {
        index.set(r.key, [usage]);
      }
      total++;
    }
  };
  const tick = () => {
    processed++;
    if (onProgress && processed % 25 === 0) {
      onProgress(processed, files.length, total);
    }
  };
  const cacheSet = (fsPath: string, raw: RawUsage[]) => {
    if (cache) {
      const m = mtimes.get(fsPath);
      if (m != null) {
        cache.set(fsPath, m, raw);
      }
    }
  };

  // Phase 1 — check the cache; anything unchanged is merged straight away and
  // everything else is queued for parsing.
  const misses: string[] = [];
  await mapConcurrent(
    files,
    READ_CONCURRENCY,
    async (file) => {
      const fsPath = file.fsPath;
      seen.add(fsPath);
      if (cache) {
        const mtime = await statMtime(fsPath);
        if (mtime != null) {
          mtimes.set(fsPath, mtime);
          if (!force) {
            const raw = cache.get(fsPath, mtime);
            if (raw !== undefined) {
              merge(fsPath, raw);
              tick();
              return;
            }
          }
        }
      }
      misses.push(fsPath);
    },
    token,
  );

  if (token?.isCancellationRequested) {
    return index;
  }

  // Phase 2 — parse the misses. Files open with unsaved edits are parsed inline
  // (so their in-memory text is honored); the rest go to the worker pool.
  const parseInline = async (fsPath: string) => {
    if (token?.isCancellationRequested) {
      return;
    }
    const text = await readFileText(vscode.Uri.file(fsPath));
    const raw = text != null ? extractRawUsages(text, fsPath, options.resolver) : [];
    cacheSet(fsPath, raw);
    merge(fsPath, raw);
    tick();
  };

  const dirty = new Set(
    vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.fsPath),
  );
  const cleanMisses = misses.filter((p) => !dirty.has(p));
  const dirtyMisses = misses.filter((p) => dirty.has(p));
  const useWorkers =
    options.parallel &&
    recommendedWorkerCount() > 1 &&
    cleanMisses.length >= WORKER_THRESHOLD;

  const inlineFiles = useWorkers ? dirtyMisses : misses;
  await mapConcurrent(inlineFiles, READ_CONCURRENCY, (p) => parseInline(p), token);

  if (useWorkers) {
    let pool: ParsePool | undefined;
    try {
      pool = new ParsePool(recommendedWorkerCount());
      const activePool = pool;
      const sub = token?.onCancellationRequested(() => void activePool.dispose());
      await pool.run(
        cleanMisses,
        ({ fsPath, raw }) => {
          cacheSet(fsPath, raw);
          merge(fsPath, raw);
          tick();
        },
        token,
      );
      sub?.dispose();
    } catch {
      // Worker threads unavailable in this host — parse inline as a fallback.
      await mapConcurrent(cleanMisses, READ_CONCURRENCY, (p) => parseInline(p), token);
    } finally {
      await pool?.dispose();
    }
  }

  // Only prune on a complete run — a cancelled run has an incomplete `seen` set.
  if (cache && !token?.isCancellationRequested) {
    cache.prune(seen);
  }

  return index;
}

async function statMtime(fsPath: string): Promise<number | null> {
  try {
    return (await fsp.stat(fsPath)).mtimeMs;
  } catch {
    return null;
  }
}

function isFilteredOut(usage: Usage, options: ScanOptions): boolean {
  return (
    !options.includeImports &&
    (usage.kind === 'import' || usage.kind === 'registration')
  );
}

function isRawFilteredOut(raw: RawUsage, options: ScanOptions): boolean {
  return (
    !options.includeImports &&
    (raw.kind === 'import' || raw.kind === 'registration')
  );
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Cancellation
 * stops scheduling new work but lets in-flight tasks settle.
 */
async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  token?: vscode.CancellationToken,
): Promise<void> {
  let next = 0;
  const runner = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length || token?.isCancellationRequested) {
        return;
      }
      await fn(items[i], i);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(pool);
}
