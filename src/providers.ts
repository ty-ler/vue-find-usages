import * as vscode from 'vscode';
import {
  ComponentTarget,
  deriveTarget,
  targetFromName,
} from './names';
import { IndexedUsage, resolveComponentAt, Usage } from './scanner';
import { getScanOptions, scanWorkspace } from './workspaceScan';
import { filterUsages, getConfiguredUsageFilter } from './usageFilters';

/**
 * The shared usage index: a map of normalized-component-key -> usages, read by
 * the CodeLens and reference providers. It has two modes:
 *  - "built" (the whole project was indexed in one pass) — lookups are complete;
 *    a missing key means the component is genuinely unused.
 *  - "not built" (lazy) — the map only holds components someone has already
 *    looked up; a missing key just means "not scanned yet".
 */
export class UsageIndex {
  private map = new Map<string, Usage[]>();
  private built = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  isBuilt(): boolean {
    return this.built;
  }

  getUsages(key: string): Usage[] | undefined {
    return this.map.get(key);
  }

  /** Store the result of a single-component lazy scan. */
  setUsages(key: string, usages: Usage[]): void {
    this.map.set(key, usages);
    this._onDidChange.fire();
  }

  /** Replace the entire index with a freshly built one. */
  replaceAll(map: Map<string, Usage[]>): void {
    this.map = map;
    this.built = true;
    this._onDidChange.fire();
  }

  /** Incrementally re-index a single file: drop its old entries, add new ones. */
  updateFile(uri: vscode.Uri, usages: IndexedUsage[]): void {
    this.removeUri(uri, false);
    for (const { key, usage } of usages) {
      const bucket = this.map.get(key);
      if (bucket) {
        bucket.push(usage);
      } else {
        this.map.set(key, [usage]);
      }
    }
    this._onDidChange.fire();
  }

  /** Remove every usage that lives in the given file. */
  removeUri(uri: vscode.Uri, fire = true): void {
    const target = uri.toString();
    for (const [key, usages] of this.map) {
      const kept = usages.filter((u) => u.uri.toString() !== target);
      if (kept.length === 0) {
        this.map.delete(key);
      } else if (kept.length !== usages.length) {
        this.map.set(key, kept);
      }
    }
    if (fire) {
      this._onDidChange.fire();
    }
  }

  clear(): void {
    if (this.map.size > 0 || this.built) {
      this.map.clear();
      this.built = false;
      this._onDidChange.fire();
    }
  }

  /** Notify consumers when presentation settings change without replacing data. */
  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/* --------------------------- Reference provider --------------------------- */

export class VueReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly index: UsageIndex) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    if (!isEnabled('references.enabled')) {
      return undefined;
    }

    const ownName = deriveTarget(document.uri.fsPath).pascal;
    const resolved = resolveComponentAt(document, position, ownName);
    if (!resolved) {
      return undefined; // not on a component — let other providers answer.
    }

    const target = targetFromName(resolved.name);

    let allUsages: Usage[];
    if (this.index.isBuilt()) {
      allUsages = this.index.getUsages(target.key) ?? [];
    } else {
      allUsages = await scanWorkspace(target, getScanOptions(), token);
      this.index.setUsages(target.key, allUsages);
    }

    if (token.isCancellationRequested) {
      return undefined;
    }
    const usages = filterUsages(allUsages, getConfiguredUsageFilter());
    return usages.map((u) => new vscode.Location(u.uri, u.range));
  }
}

/* ---------------------------- CodeLens provider --------------------------- */

interface CountedLens extends vscode.CodeLens {
  target?: ComponentTarget;
  uri?: vscode.Uri;
}

export class VueCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly index: UsageIndex) {
    // When the index is invalidated (file changes) or filled, refresh lenses.
    this.index.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    if (!isEnabled('codeLens.enabled')) {
      return [];
    }
    const range = templateAnchor(document);
    const lens: CountedLens = new vscode.CodeLens(range);
    lens.target = deriveTarget(document.uri.fsPath);
    lens.uri = document.uri;
    return [lens];
  }

  async resolveCodeLens(
    lens: CountedLens,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens> {
    const target = lens.target;
    if (!target) {
      return lens;
    }

    let allUsages: Usage[];
    if (this.index.isBuilt()) {
      allUsages = this.index.getUsages(target.key) ?? [];
    } else {
      const cached = this.index.getUsages(target.key);
      if (cached !== undefined) {
        allUsages = cached;
      } else {
        allUsages = await scanWorkspace(target, getScanOptions(), token);
        this.index.setUsages(target.key, allUsages);
      }
    }
    const count = filterUsages(allUsages, getConfiguredUsageFilter()).length;

    lens.command = {
      title:
        count === 0
          ? '$(references)  No usages'
          : `$(references)  ${count} usage${count === 1 ? '' : 's'}`,
      tooltip: `Show all usages of <${target.pascal}> across the workspace`,
      command: 'vueFindUsages.findUsages',
      arguments: [lens.uri],
    };
    return lens;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}

/* -------------------------------- helpers -------------------------------- */

function isEnabled(key: string): boolean {
  return vscode.workspace.getConfiguration('vueFindUsages').get<boolean>(key, true);
}

/** Places the lens on the `<template>` line, falling back to the first line. */
function templateAnchor(document: vscode.TextDocument): vscode.Range {
  const text = document.getText();
  const idx = text.search(/<template(\s|>)/);
  const pos = idx >= 0 ? document.positionAt(idx) : new vscode.Position(0, 0);
  const line = pos.line;
  return new vscode.Range(line, 0, line, 0);
}
