import * as vscode from 'vscode';
import * as path from 'path';
import { deriveTarget, ComponentTarget } from './names';
import { Usage, UsageKind } from './scanner';
import {
  buildProjectIndex,
  getScanOptions,
  indexUsagesForFile,
  readFileText,
  scanWorkspace,
} from './workspaceScan';
import {
  UsageIndex,
  VueCodeLensProvider,
  VueReferenceProvider,
} from './providers';
import { IndexCache } from './indexCache';
import { getComponentExtensions, setComponentExtensions } from './componentExt';
import {
  affectsUsageFilters,
  ALL_USAGE_FILTER,
  filterUsages,
  getConfiguredUsageFilter,
  IMPORTS_ONLY_USAGE_FILTER,
  REGISTRATIONS_ONLY_USAGE_FILTER,
  TEMPLATE_ONLY_USAGE_FILTER,
  UsageFilter,
} from './usageFilters';

const VUE_SELECTOR: vscode.DocumentSelector = { scheme: 'file', pattern: '**/*.vue' };

let usageIndex: UsageIndex;
let usageCache: IndexCache | undefined;
let cacheFileUri: vscode.Uri;
let extensionVersion = '0.0.0';
let activeIndexingCts: vscode.CancellationTokenSource | undefined;

/** Reads the configured component suffixes and applies them to this thread. */
function syncComponentExtensions(): void {
  const list = vscode.workspace
    .getConfiguration('vueFindUsages')
    .get<string[]>('componentExtensions', ['.vue']);
  setComponentExtensions(list);
}

/** Builds a cache whose version embeds the suffixes, so it invalidates on change. */
function makeCache(): IndexCache {
  const version = `${extensionVersion}#${getComponentExtensions().join('|')}`;
  return new IndexCache(cacheFileUri, version);
}

export function activate(context: vscode.ExtensionContext) {
  usageIndex = new UsageIndex();

  // Persistent cache so re-opening the project only re-parses changed files.
  const storageBase = context.storageUri ?? context.globalStorageUri;
  extensionVersion = context.extension?.packageJSON?.version ?? '0.0.0';
  cacheFileUri = vscode.Uri.joinPath(storageBase, 'index-cache.json');
  syncComponentExtensions();
  usageCache = makeCache();

  // Confirmation that the extension loaded. Appears in the Debug Console of the
  // window you launched from, and in Output → "Vue Find Usages".
  console.log('[vue-find-usages] extension activated');
  getOutputChannel().appendLine('[vue-find-usages] extension activated');

  context.subscriptions.push(
    usageIndex,
    vscode.commands.registerCommand('vueFindUsages.findUsages', (uri?: vscode.Uri) =>
      findUsages(uri),
    ),
    vscode.commands.registerCommand(
      'vueFindUsages.findTemplateUsages',
      (uri?: vscode.Uri) => findUsages(uri, TEMPLATE_ONLY_USAGE_FILTER),
    ),
    vscode.commands.registerCommand(
      'vueFindUsages.findImportUsages',
      (uri?: vscode.Uri) => findUsages(uri, IMPORTS_ONLY_USAGE_FILTER),
    ),
    vscode.commands.registerCommand(
      'vueFindUsages.findRegistrationUsages',
      (uri?: vscode.Uri) => findUsages(uri, REGISTRATIONS_ONLY_USAGE_FILTER),
    ),
    vscode.commands.registerCommand(
      'vueFindUsages.findAllUsages',
      (uri?: vscode.Uri) => findUsages(uri, ALL_USAGE_FILTER),
    ),
    vscode.commands.registerCommand('vueFindUsages.indexProject', () =>
      rebuildIndex(true, true),
    ),
    vscode.commands.registerCommand('vueFindUsages.cancelIndexing', () =>
      activeIndexingCts?.cancel(),
    ),
    vscode.languages.registerReferenceProvider(
      VUE_SELECTOR,
      new VueReferenceProvider(usageIndex),
    ),
    vscode.languages.registerCodeLensProvider(
      VUE_SELECTOR,
      new VueCodeLensProvider(usageIndex),
    ),
  );

  setupFileWatcher(context);

  // Re-index when the component suffixes change (names and cache keys depend on
  // them, so the whole index must be rebuilt with a fresh, invalidated cache).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vueFindUsages.componentExtensions')) {
        syncComponentExtensions();
        usageCache = makeCache();
        void rebuildIndex(false);
      }
      if (affectsUsageFilters(e)) {
        usageIndex.refresh();
      }
    }),
  );

  // Optionally index the whole project up front so lookups are instant.
  const config = vscode.workspace.getConfiguration('vueFindUsages');
  if (config.get<boolean>('indexOnOpen', true)) {
    rebuildIndex(false);
  }
}

export function deactivate() {}

/**
 * (Re)builds the whole-project index. Progress is shown as an unobtrusive status
 * bar item rather than a blocking notification, so indexing runs in the
 * background; clicking the item cancels the run.
 */
async function rebuildIndex(announce: boolean, force = false): Promise<void> {
  // Supersede any indexing already in flight.
  activeIndexingCts?.cancel();
  const cts = new vscode.CancellationTokenSource();
  activeIndexingCts = cts;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'vueFindUsages.cancelIndexing';
  status.tooltip = 'Vue: Find Component Usages — click to cancel indexing';
  status.text = '$(sync~spin) Indexing Vue usages…';
  status.show();

  if (usageCache) {
    if (force) {
      usageCache.clearEntries(); // ignore any cached parse and re-scan everything
    } else {
      await usageCache.load();
    }
  }

  let map: Map<string, Usage[]> | undefined;
  try {
    map = await buildProjectIndex(
      getScanOptions(),
      cts.token,
      (processed, total) => {
        status.text = `$(sync~spin) Indexing Vue usages ${processed}/${total}`;
      },
      usageCache,
      force,
    );
  } catch {
    map = undefined; // aborted or failed — fall back to lazy mode.
  } finally {
    status.dispose();
    cts.dispose();
    if (activeIndexingCts === cts) {
      activeIndexingCts = undefined;
    }
  }

  if (cts.token.isCancellationRequested || !map) {
    return; // cancelled — stay in lazy mode.
  }
  usageIndex.replaceAll(map);
  if (usageCache) {
    void usageCache.save();
  }
  getOutputChannel().appendLine(
    `[vue-find-usages] indexed ${map.size} component(s)`,
  );
  if (announce) {
    vscode.window.showInformationMessage(
      `Vue usage index built: ${map.size} component(s).`,
    );
  }
}

/** Keeps the index fresh as files change. */
function setupFileWatcher(context: vscode.ExtensionContext): void {
  const options = getScanOptions();
  const watcher = vscode.workspace.createFileSystemWatcher(options.include);

  const reindexFile = async (uri: vscode.Uri) => {
    if (!usageIndex.isBuilt()) {
      // Lazy mode: just drop stale per-component caches.
      usageIndex.clear();
      return;
    }
    const text = await readFileText(uri);
    if (text == null) {
      usageIndex.removeUri(uri);
      return;
    }
    usageIndex.updateFile(uri, indexUsagesForFile(uri, text, getScanOptions()));
  };

  watcher.onDidCreate(reindexFile);
  watcher.onDidChange(reindexFile);
  watcher.onDidDelete((uri) =>
    usageIndex.isBuilt() ? usageIndex.removeUri(uri) : usageIndex.clear(),
  );
  context.subscriptions.push(watcher);
}

async function findUsages(
  uri?: vscode.Uri,
  filterOverride?: UsageFilter,
): Promise<void> {
  const targetUri = await resolveTargetFile(uri);
  if (!targetUri) {
    return;
  }

  const target = deriveTarget(targetUri.fsPath);

  let allUsages: Usage[] | undefined;
  if (usageIndex.isBuilt()) {
    // Instant: the project is already indexed.
    allUsages = usageIndex.getUsages(target.key) ?? [];
  } else {
    allUsages = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Finding usages of <${target.pascal}>`,
        cancellable: true,
      },
      (progress, token) =>
        scanWorkspace(target, getScanOptions(), token, (processed, total, found) => {
          progress.report({ message: `${processed}/${total} files, ${found} matches` });
        }),
    );
    if (allUsages === undefined) {
      return;
    }
    usageIndex.setUsages(target.key, allUsages);
  }

  const usages = filterUsages(
    allUsages,
    filterOverride ?? getConfiguredUsageFilter(),
  );
  await presentResults(targetUri, target, usages);
}

async function presentResults(
  targetUri: vscode.Uri,
  target: ComponentTarget,
  usages: Usage[],
): Promise<void> {
  if (usages.length === 0) {
    vscode.window.showInformationMessage(`No usages of <${target.pascal}> found.`);
    return;
  }

  usages.sort((a, b) => {
    const byFile = a.uri.toString().localeCompare(b.uri.toString());
    return byFile !== 0 ? byFile : a.range.start.compareTo(b.range.start);
  });

  writeOutput(target, usages);

  const anchor = new vscode.Position(0, 0);
  const locations = usages.map((u) => new vscode.Location(u.uri, u.range));
  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    targetUri,
    anchor,
    locations,
  );
}

const KIND_LABEL: Record<UsageKind, string> = {
  tag: 'template tag',
  'dynamic-is': 'dynamic <component :is>',
  import: 'import',
  'dynamic-import': 'dynamic import',
  registration: 'registration',
};

function writeOutput(target: ComponentTarget, usages: Usage[]): void {
  const output = getOutputChannel();
  output.clear();
  output.appendLine(`Usages of <${target.pascal}> — ${usages.length} total`);

  const counts = new Map<UsageKind, number>();
  for (const u of usages) {
    counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind]}${n === 1 ? '' : 's'}`)
    .join(', ');
  output.appendLine(`  ${summary}`);
  output.appendLine('');

  for (const u of usages) {
    const rel = vscode.workspace.asRelativePath(u.uri);
    const line = u.range.start.line + 1;
    const col = u.range.start.character + 1;
    output.appendLine(`[${u.kind}] ${rel}:${line}:${col}  ${u.lineText}`);
  }
}

async function resolveTargetFile(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri && uri.fsPath.endsWith('.vue')) {
    return uri;
  }

  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.fsPath.endsWith('.vue')) {
    return active.document.uri;
  }

  const { exclude } = getScanOptions();
  const vueFiles = await vscode.workspace.findFiles('**/*.vue', exclude);
  if (vueFiles.length === 0) {
    vscode.window.showWarningMessage('No .vue files found in this workspace.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    vueFiles
      .map((f) => ({
        label: path.basename(f.fsPath),
        description: vscode.workspace.asRelativePath(f),
        uri: f,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { placeHolder: 'Pick a Vue component to find usages of' },
  );
  return picked?.uri;
}

let channel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Vue Find Usages');
  }
  return channel;
}
