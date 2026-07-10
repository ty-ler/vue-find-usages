import * as vscode from 'vscode';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate, NodeTypes, ElementTypes } from '@vue/compiler-dom';
import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { ComponentTarget } from './names';
import {
  extractRawUsages,
  ImportResolver,
  RawUsage,
  UsageKind,
} from './scanCore';

const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

export type { UsageKind, ImportResolver, RawUsage } from './scanCore';

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

/** Converts plain scan output into a vscode-typed usage for a given file. */
export function rawToUsage(uri: vscode.Uri, raw: RawUsage): Usage {
  const [sl, sc, el, ec] = raw.range;
  return {
    uri,
    range: new vscode.Range(sl, sc, el, ec),
    kind: raw.kind,
    lineText: raw.lineText,
  };
}

/**
 * Parses one file's text and returns EVERY component usage it contains, each
 * keyed by the normalized component name.
 */
export function extractComponentUsages(
  uri: vscode.Uri,
  text: string,
  resolver?: ImportResolver,
): IndexedUsage[] {
  return extractRawUsages(text, uri.fsPath, resolver).map((raw) => ({
    key: raw.key,
    usage: rawToUsage(uri, raw),
  }));
}

/**
 * Returns the usages of one specific component in a file. Keeps a cheap text
 * pre-filter so the lazy (non-indexed) path can skip parsing files that can't
 * possibly mention the component.
 */
export function findUsagesInDocument(
  uri: vscode.Uri,
  text: string,
  target: ComponentTarget,
  resolver?: ImportResolver,
): Usage[] {
  const lower = text.toLowerCase();
  if (!lower.includes(target.kebab) && !lower.includes(target.pascal.toLowerCase())) {
    return [];
  }
  return extractComponentUsages(uri, text, resolver)
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
 * user means, so "Find All References" targets the right thing.
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
    return { name: ownComponentName, source: 'own' };
  }

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

  return { name: ownComponentName, source: 'own' };
}

function withinBlock(
  offset: number,
  loc: { start: { offset: number }; end: { offset: number } },
): boolean {
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
