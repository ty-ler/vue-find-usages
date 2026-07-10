import * as vscode from 'vscode';
import { ComponentTarget } from './names';
import {
  extractComponentUsages,
  findUsagesInDocument,
  ImportResolver,
  IndexedUsage,
  Usage,
} from './scanner';
import { clearResolveCache, importResolvesToVue } from './resolve';

export interface ScanOptions {
  include: string;
  exclude: string;
  includeImports: boolean;
  resolver: ImportResolver;
}

export function getScanOptions(): ScanOptions {
  const config = vscode.workspace.getConfiguration('vueFindUsages');
  return {
    include: config.get<string>('include', '**/*.{vue,js,ts,jsx,tsx,mjs,cjs}'),
    exclude: config.get<string>('exclude', '**/{node_modules,dist,.git}/**'),
    includeImports: config.get<boolean>('includeImports', true),
    resolver: importResolvesToVue,
  };
}

export type ProgressReporter = (processed: number, total: number, found: number) => void;

/**
 * Scans every workspace file matching the configured globs and returns all
 * AST-confirmed usages of the target component. No UI — callers add progress or
 * caching. Safe to call from providers with a CancellationToken.
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

  for (const file of files) {
    if (token?.isCancellationRequested) {
      break;
    }
    processed++;
    if (onProgress && processed % 25 === 0) {
      onProgress(processed, files.length, found.length);
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(file);
    } catch {
      continue;
    }

    for (const usage of findUsagesInDocument(document, target, options.resolver)) {
      if (isFilteredOut(usage, options)) {
        continue;
      }
      found.push(usage);
    }
  }

  return found;
}

/** The usages of one document, honoring the includeImports option. */
export function indexUsagesForDocument(
  document: vscode.TextDocument,
  options: ScanOptions,
): IndexedUsage[] {
  return extractComponentUsages(document, options.resolver).filter(
    (u) => !isFilteredOut(u.usage, options),
  );
}

/**
 * Builds the whole-project index in a single pass: every file is parsed once and
 * every component usage is grouped by its normalized key. This is what makes the
 * CodeLens and Find All References resolve instantly afterwards.
 */
export async function buildProjectIndex(
  options: ScanOptions,
  token?: vscode.CancellationToken,
  onProgress?: ProgressReporter,
): Promise<Map<string, Usage[]>> {
  const files = await vscode.workspace.findFiles(
    options.include,
    options.exclude,
    undefined,
    token,
  );

  clearResolveCache();

  const index = new Map<string, Usage[]>();
  let processed = 0;
  let total = 0;

  for (const file of files) {
    if (token?.isCancellationRequested) {
      break;
    }
    processed++;

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(file);
    } catch {
      continue;
    }

    for (const { key, usage } of indexUsagesForDocument(document, options)) {
      const bucket = index.get(key);
      if (bucket) {
        bucket.push(usage);
      } else {
        index.set(key, [usage]);
      }
      total++;
    }

    if (onProgress && processed % 25 === 0) {
      onProgress(processed, files.length, total);
    }
  }

  return index;
}

function isFilteredOut(usage: Usage, options: ScanOptions): boolean {
  return (
    !options.includeImports &&
    (usage.kind === 'import' || usage.kind === 'registration')
  );
}
