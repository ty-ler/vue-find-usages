import * as path from 'path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate, NodeTypes, ElementTypes } from '@vue/compiler-dom';
import { parse as babelParse, ParserPlugin } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { normalizeKey } from './names';
import { componentBaseName, isComponentFile } from './componentExt';

// @babel/traverse ships as CommonJS; under esModuleInterop the callable lives on
// `.default` in some resolutions and is the module itself in others.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

export type UsageKind =
  | 'tag'
  | 'dynamic-is'
  | 'import'
  | 'dynamic-import'
  | 'registration';

/** Decides whether a non-`.vue` import specifier points at a Vue component. */
export type ImportResolver = (importerFsPath: string, specifier: string) => boolean;

/**
 * A component usage as plain, serializable data (no `vscode` types) so it can be
 * produced inside a worker thread and structured-cloned back to the main thread.
 * `range` is [startLine, startChar, endLine, endChar], all zero-based.
 */
export interface RawUsage {
  key: string;
  kind: UsageKind;
  range: [number, number, number, number];
  lineText: string;
}

/**
 * Cheap byte-level pre-filter: returns false only when a file provably contains
 * no component usage, so the expensive AST parse can be skipped. It must never
 * return false for a file that does contain a usage.
 */
export function mightContainComponents(text: string, isSfc: boolean): boolean {
  const hasScriptSignal = /\bimport\b/.test(text) || /\bcomponents\b/.test(text);
  if (!isSfc) {
    // Non-SFC files only contribute imports and `components: {}` registrations.
    return hasScriptSignal;
  }
  return (
    hasScriptSignal ||
    /<[A-Z]/.test(text) || // <PascalCase>
    /<[a-z][a-zA-Z0-9]*-/.test(text) || // <kebab-tag>
    /<component[\s/>]/i.test(text) // <component :is="...">
  );
}

type Collect = (
  displayName: string,
  kind: UsageKind,
  absStart: number,
  absEnd: number,
  altNames?: string[],
) => void;

/**
 * Parses one file's text and returns every component usage as plain data. This
 * is the vscode-free hot path shared by the main thread and the worker pool.
 */
export function extractRawUsages(
  text: string,
  fsPath: string,
  resolver?: ImportResolver,
): RawUsage[] {
  const isSfc = isComponentFile(fsPath);
  if (!mightContainComponents(text, isSfc)) {
    return [];
  }

  const lineStarts = computeLineStarts(text);
  const out: RawUsage[] = [];

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
    const [sl, sc] = offsetToPos(lineStarts, absStart);
    const [el, ec] = offsetToPos(lineStarts, absEnd);
    const lineText = lineTextAt(text, lineStarts, sl).trim();
    for (const key of keys) {
      out.push({ key, kind, range: [sl, sc, el, ec], lineText });
    }
  };

  if (isSfc) {
    scanVue(text, collect, fsPath, resolver);
  } else {
    scanScript(text, 0, scriptPlugins(path.extname(fsPath).toLowerCase()), collect, fsPath, resolver);
  }

  return out;
}

/* --------------------------- position mapping --------------------------- */

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToPos(lineStarts: number[], offset: number): [number, number] {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return [lo, offset - lineStarts[lo]];
}

function lineTextAt(text: string, lineStarts: number[], line: number): string {
  const start = lineStarts[line];
  const end = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length;
  return text.slice(start, end).replace(/\r?\n$/, '');
}

/* ------------------------------- Vue SFC ------------------------------- */

function scanVue(
  source: string,
  collect: Collect,
  importer: string,
  resolver?: ImportResolver,
): void {
  let descriptor;
  try {
    descriptor = parseSfc(source, { ignoreEmpty: true }).descriptor;
  } catch {
    return;
  }

  if (descriptor.template && descriptor.template.content) {
    const base = descriptor.template.loc.start.offset;
    try {
      const root = parseTemplate(descriptor.template.content, { comments: false });
      walkTemplate(root, base, collect);
    } catch {
      /* malformed template — skip */
    }
  }

  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const plugins = scriptPlugins('.' + (block.lang || 'js'));
    scanScript(block.content, block.loc.start.offset, plugins, collect, importer, resolver);
  }
}

function walkTemplate(node: any, base: number, collect: Collect): void {
  if (!node) {
    return;
  }

  if (node.type === NodeTypes.ELEMENT) {
    const tag: string = node.tag;
    if (tag && tag.toLowerCase() === 'component') {
      handleDynamicComponent(node, base, collect);
    } else if (tag && node.tagType === ElementTypes.COMPONENT) {
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
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'is' && prop.value) {
      const val: string = stripComponentPrefix(prop.value.content);
      const loc = prop.value.loc;
      collect(val, 'dynamic-is', base + loc.start.offset, base + loc.end.offset);
    }
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
  return s.replace(/^vue:/, '');
}

/* ------------------------------- Scripts ------------------------------- */

function scanScript(
  content: string,
  base: number,
  plugins: ParserPlugin[],
  collect: Collect,
  importer: string,
  resolver?: ImportResolver,
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
    // Dynamic / lazy imports: `() => import('./Foo.vue')`, in async components,
    // vue-router routes, defineAsyncComponent, etc. Keyed by the file stem since
    // a dynamic import has no local name.
    CallExpression(pathNode) {
      const node = pathNode.node;
      if (!t.isImport(node.callee)) {
        return;
      }
      const arg = node.arguments[0];
      if (!t.isStringLiteral(arg)) {
        return;
      }
      const source = arg.value;
      const isComponentSource = isComponentFile(source);
      const resolves =
        isComponentSource || (resolver ? resolver(importer, source) : false);
      if (!resolves) {
        return;
      }
      const stem = isComponentSource
        ? componentBaseName(source)
        : path.basename(source).replace(/\.\w+$/, '');
      if (arg.start != null && arg.end != null) {
        // Highlight the path text inside the quotes.
        collect(stem, 'dynamic-import', base + arg.start + 1, base + arg.end - 1);
      }
    },

    ImportDeclaration(pathNode) {
      const node = pathNode.node;
      const source = node.source.value;
      // An import whose path is itself a component file (e.g. `.vue`, `.ts.vue`).
      const isComponentSource = isComponentFile(source);
      // For component-file imports strip the full suffix (`.ts.vue` -> name).
      const stem = isComponentSource
        ? componentBaseName(source)
        : path.basename(source).replace(/\.\w+$/, '');

      const isComponentImport =
        isComponentSource || (resolver ? resolver(importer, source) : undefined);

      for (const spec of node.specifiers) {
        const localName = spec.local.name;
        const keep =
          isComponentImport ?? (!isComponentSource ? /^[A-Z]/.test(localName) : true);
        if (!keep) {
          continue;
        }
        let importedName = localName;
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
          importedName = spec.imported.name;
        }
        const anchor = spec.local;
        if (anchor.start != null && anchor.end != null) {
          const altNames = isComponentSource ? [importedName, stem] : [importedName];
          collect(localName, 'import', base + anchor.start, base + anchor.end, altNames);
        }
      }
    },

    ObjectProperty(pathNode) {
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
