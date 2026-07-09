import * as vscode from 'vscode';
import * as path from 'path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate, NodeTypes, ElementTypes } from '@vue/compiler-dom';
import { parse as babelParse, ParserPlugin } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { ComponentTarget, normalizeKey } from './names';

// @babel/traverse ships as CommonJS; under esModuleInterop the callable lives on
// `.default` in some resolutions and is the module itself in others.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

export type UsageKind = 'tag' | 'dynamic-is' | 'import' | 'registration';

export interface Usage {
  uri: vscode.Uri;
  range: vscode.Range;
  kind: UsageKind;
  lineText: string;
}

/** A usage tagged with the normalized component key it belongs to. */
export interface IndexedUsage {
  key: string;
  usage: Usage;
}

/**
 * A callback that records one usage under a component name (plus any alternate
 * names — e.g. an import's local name, imported name, and file stem — so a
 * lookup by any of them finds it).
 */
type Collect = (
  displayName: string,
  kind: UsageKind,
  absStart: number,
  absEnd: number,
  altNames?: string[],
) => void;

/**
 * Parses a single document and returns EVERY component usage it contains, each
 * keyed by the normalized component name. `.vue` files contribute template tags
 * + their own script imports; `.js/.ts/.jsx/.tsx` files contribute imports and
 * `components: {}` registrations. Best-effort: a syntax error in one block never
 * aborts the scan. This is the one pass the whole-project index is built from.
 */
export function extractComponentUsages(document: vscode.TextDocument): IndexedUsage[] {
  const text = document.getText();
  const ext = path.extname(document.uri.fsPath).toLowerCase();
  const out: IndexedUsage[] = [];

  const collect: Collect = (displayName, kind, absStart, absEnd, altNames = []) => {
    const keys = new Set<string>();
    for (const name of [displayName, ...altNames]) {
      const key = normalizeKey(name);
      if (key) {
        keys.add(key);
      }
    }
    if (keys.size === 0) {
      return;
    }
    const range = new vscode.Range(
      document.positionAt(absStart),
      document.positionAt(absEnd),
    );
    const usage: Usage = {
      uri: document.uri,
      range,
      kind,
      lineText: document.lineAt(range.start.line).text.trim(),
    };
    for (const key of keys) {
      out.push({ key, usage });
    }
  };

  if (ext === '.vue') {
    scanVue(text, collect);
  } else {
    scanScript(text, 0, scriptPlugins(ext), collect);
  }

  return out;
}

/**
 * Returns the usages of one specific component in a document. Keeps a cheap
 * text pre-filter so the lazy (non-indexed) path can skip parsing files that
 * can't possibly mention the component.
 */
export function findUsagesInDocument(
  document: vscode.TextDocument,
  target: ComponentTarget,
): Usage[] {
  const lower = document.getText().toLowerCase();
  if (!lower.includes(target.kebab) && !lower.includes(target.pascal.toLowerCase())) {
    return [];
  }
  return extractComponentUsages(document)
    .filter((u) => u.key === target.key)
    .map((u) => u.usage);
}

/* --------------------- Resolve component at a position --------------------- */

export interface ResolvedComponent {
  /** The component name the cursor is on (raw tag or identifier). */
  name: string;
  /** Where the name came from — useful for debugging / UX copy. */
  source: 'tag' | 'own' | 'script-import';
}

/**
 * Given a cursor position in a `.vue` document, work out which component the
 * user means, so "Find All References" targets the right thing:
 *  - on a component tag in the template  -> that tag's component
 *  - elsewhere in the template            -> the file's own component
 *  - on an identifier imported from a .vue -> that component
 *  - on a plain symbol in <script>        -> null (defer to the TS provider)
 */
export function resolveComponentAt(
  document: vscode.TextDocument,
  position: vscode.Position,
  ownComponentName: string,
): ResolvedComponent | null {
  if (!document.uri.fsPath.toLowerCase().endsWith('.vue')) {
    return null;
  }

  const source = document.getText();
  const offset = document.offsetAt(position);

  let descriptor;
  try {
    descriptor = parseSfc(source, { ignoreEmpty: true }).descriptor;
  } catch {
    return null;
  }

  // --- inside the template block? ---
  const tpl = descriptor.template;
  if (tpl && withinBlock(offset, tpl.loc)) {
    const base = tpl.loc.start.offset;
    let hit: ResolvedComponent | null = null;
    try {
      const root = parseTemplate(tpl.content, { comments: false });
      hit = findTagAtOffset(root, offset - base);
    } catch {
      /* ignore malformed template */
    }
    if (hit) {
      return hit;
    }
    // Inside the template but not on a component tag: mean the file's component.
    return { name: ownComponentName, source: 'own' };
  }

  // --- inside a <script> block? ---
  const scriptBlock = [descriptor.script, descriptor.scriptSetup].find(
    (b) => b && withinBlock(offset, b.loc),
  );
  if (scriptBlock) {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }
    const word = document.getText(wordRange);
    if (matchesName(word, ownComponentName)) {
      return { name: ownComponentName, source: 'own' };
    }
    if (isImportedFromVue(scriptBlock.content, word)) {
      return { name: word, source: 'script-import' };
    }
    return null; // a normal TS symbol — let the language server handle it.
  }

  // Outside any block (e.g. a custom block) — assume the file's component.
  return { name: ownComponentName, source: 'own' };
}

function withinBlock(offset: number, loc: { start: { offset: number }; end: { offset: number } }): boolean {
  return offset >= loc.start.offset && offset <= loc.end.offset;
}

function matchesName(a: string, b: string): boolean {
  return a.toLowerCase().replace(/-/g, '') === b.toLowerCase().replace(/-/g, '');
}

function findTagAtOffset(node: any, relOffset: number): ResolvedComponent | null {
  if (!node) {
    return null;
  }
  if (node.type === NodeTypes.ELEMENT) {
    const tag: string = node.tag;
    const isComponent =
      node.tagType === ElementTypes.COMPONENT && tag.toLowerCase() !== 'component';
    if (isComponent) {
      const nameStart = node.loc.start.offset + 1; // skip '<'
      const nameEnd = nameStart + tag.length;
      if (relOffset >= nameStart && relOffset <= nameEnd) {
        return { name: tag, source: 'tag' };
      }
    }
  }
  for (const child of node.children || []) {
    const hit = findTagAtOffset(child, relOffset);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function isImportedFromVue(scriptContent: string, word: string): boolean {
  let ast;
  try {
    ast = babelParse(scriptContent, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
    });
  } catch {
    return false;
  }
  let found = false;
  traverse(ast, {
    ImportDeclaration(pathNode) {
      const node = pathNode.node;
      if (!/\.vue$/i.test(node.source.value)) {
        return;
      }
      for (const spec of node.specifiers) {
        if (spec.local.name === word) {
          found = true;
          pathNode.stop();
          return;
        }
      }
    },
  });
  return found;
}

/* ------------------------------- Vue SFC ------------------------------- */

function scanVue(source: string, collect: Collect): void {
  let descriptor;
  try {
    descriptor = parseSfc(source, { ignoreEmpty: true }).descriptor;
  } catch {
    return;
  }

  // --- template: walk the element tree for tag usages ---
  if (descriptor.template && descriptor.template.content) {
    const base = descriptor.template.loc.start.offset;
    try {
      const root = parseTemplate(descriptor.template.content, { comments: false });
      walkTemplate(root, base, collect);
    } catch {
      /* malformed template — skip */
    }
  }

  // --- <script> and <script setup>: imports + registrations ---
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const plugins = scriptPlugins('.' + (block.lang || 'js'));
    scanScript(block.content, block.loc.start.offset, plugins, collect);
  }
}

function walkTemplate(node: any, base: number, collect: Collect): void {
  if (!node) {
    return;
  }

  if (node.type === NodeTypes.ELEMENT) {
    const tag: string = node.tag;

    if (tag && tag.toLowerCase() === 'component') {
      // <component is="Foo"> / <component :is="'Foo'"> — dynamic component.
      handleDynamicComponent(node, base, collect);
    } else if (tag && node.tagType === ElementTypes.COMPONENT) {
      // A component tag (not a native HTML element). Highlight the tag name.
      const start = base + node.loc.start.offset + 1; // skip '<'
      collect(tag, 'tag', start, start + tag.length);
    }
  }

  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      walkTemplate(child, base, collect);
    }
  }
}

function handleDynamicComponent(node: any, base: number, collect: Collect): void {
  for (const prop of node.props || []) {
    // Static:  is="Foo"
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'is' && prop.value) {
      const val: string = stripComponentPrefix(prop.value.content);
      const loc = prop.value.loc;
      collect(val, 'dynamic-is', base + loc.start.offset, base + loc.end.offset);
    }
    // Bound:   :is="'Foo'"  /  v-bind:is="'Foo'"
    if (
      prop.type === NodeTypes.DIRECTIVE &&
      prop.name === 'bind' &&
      prop.arg &&
      prop.arg.content === 'is' &&
      prop.exp
    ) {
      const raw: string = prop.exp.content.trim();
      const literal = raw.match(/^['"`](.*)['"`]$/);
      if (literal) {
        const loc = prop.exp.loc;
        collect(
          stripComponentPrefix(literal[1]),
          'dynamic-is',
          base + loc.start.offset,
          base + loc.end.offset,
        );
      }
    }
  }
}

function stripComponentPrefix(s: string): string {
  // Vue allows `is="vue:my-component"` for native-element disambiguation.
  return s.replace(/^vue:/, '');
}

/* ------------------------------- Scripts ------------------------------- */

function scanScript(
  content: string,
  base: number,
  plugins: ParserPlugin[],
  collect: Collect,
): void {
  if (!content) {
    return;
  }
  let ast;
  try {
    ast = babelParse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins,
    });
  } catch {
    return;
  }

  traverse(ast, {
    ImportDeclaration(pathNode) {
      const node = pathNode.node;
      const source = node.source.value;
      const isVue = /\.vue$/i.test(source);
      const stem = path.basename(source).replace(/\.\w+$/, '');

      for (const spec of node.specifiers) {
        const localName = spec.local.name;
        // Keep the index lean: only index imports that are plausibly components
        // — those from a `.vue` file, or with a PascalCase local name.
        if (!isVue && !/^[A-Z]/.test(localName)) {
          continue;
        }
        let importedName = localName;
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
          importedName = spec.imported.name;
        }
        const anchor = spec.local;
        if (anchor.start != null && anchor.end != null) {
          // A lookup by local name, imported name, or file stem all resolve here.
          collect(localName, 'import', base + anchor.start, base + anchor.end, [
            importedName,
            stem,
          ]);
        }
      }
    },

    ObjectProperty(pathNode) {
      // Match component registrations: `components: { Foo, Bar: Baz }`.
      const node = pathNode.node;
      const key = node.key;
      const keyName = t.isIdentifier(key)
        ? key.name
        : t.isStringLiteral(key)
          ? key.value
          : null;
      if (keyName !== 'components') {
        return;
      }
      if (!t.isObjectExpression(node.value)) {
        return;
      }
      for (const member of node.value.properties) {
        if (t.isObjectProperty(member)) {
          collectRegistrationMember(member, base, collect);
        }
      }
    },
  });
}

function collectRegistrationMember(
  member: t.ObjectProperty,
  base: number,
  collect: Collect,
): void {
  const key = member.key;
  const keyName = t.isIdentifier(key)
    ? key.name
    : t.isStringLiteral(key)
      ? key.value
      : null;
  // Shorthand `{ Foo }` and explicit value `{ FooAlias: Foo }` both point at a
  // component identifier worth indexing.
  const valueName = t.isIdentifier(member.value) ? member.value.name : null;

  const candidate = valueName || keyName;
  if (!candidate) {
    return;
  }
  const anchor = member.value && member.value.start != null ? member.value : member.key;
  if (anchor.start != null && anchor.end != null) {
    collect(candidate, 'registration', base + anchor.start, base + anchor.end);
  }
}

/* ------------------------------- Plugins ------------------------------- */

function scriptPlugins(ext: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = [
    'jsx',
    'decorators-legacy',
    'classProperties',
    'topLevelAwait',
    'importAssertions',
  ];
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    plugins.unshift('typescript');
  }
  return plugins;
}
