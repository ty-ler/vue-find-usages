import * as fs from 'fs';
import * as path from 'path';

/**
 * Best-effort module resolution used to decide whether a non-`.vue` import
 * actually points at a Vue component file. Handles relative specifiers and
 * `tsconfig`/`jsconfig` `paths` aliases; anything else (bare packages,
 * unresolvable aliases) is treated as "not a component".
 */

interface AliasConfig {
  /** Directory that alias targets resolve against (baseUrl). */
  baseDir: string;
  entries: Array<{ base: string; wildcard: boolean; targets: string[] }>;
}

const dirConfigCache = new Map<string, AliasConfig | null>();
const fileExistsCache = new Map<string, boolean>();

/** Clears cached tsconfig lookups and stat results (call before a full re-index). */
export function clearResolveCache(): void {
  dirConfigCache.clear();
  fileExistsCache.clear();
}

/** True when `specifier`, imported from `importerFsPath`, resolves to a `.vue` file. */
export function importResolvesToVue(importerFsPath: string, specifier: string): boolean {
  if (specifier.startsWith('.')) {
    const abs = path.resolve(path.dirname(importerFsPath), specifier);
    return existsAsVue(abs);
  }
  const config = findAliasConfig(path.dirname(importerFsPath));
  if (!config) {
    return false;
  }
  for (const abs of resolveAlias(specifier, config)) {
    if (existsAsVue(abs)) {
      return true;
    }
  }
  return false;
}

function existsAsVue(target: string): boolean {
  if (target.toLowerCase().endsWith('.vue')) {
    return fileExists(target);
  }
  return fileExists(target + '.vue') || fileExists(path.join(target, 'index.vue'));
}

function fileExists(p: string): boolean {
  const cached = fileExistsCache.get(p);
  if (cached !== undefined) {
    return cached;
  }
  let exists = false;
  try {
    exists = fs.statSync(p).isFile();
  } catch {
    exists = false;
  }
  fileExistsCache.set(p, exists);
  return exists;
}

function resolveAlias(specifier: string, config: AliasConfig): string[] {
  const out: string[] = [];
  for (const entry of config.entries) {
    if (entry.wildcard) {
      if (specifier.startsWith(entry.base)) {
        const rest = specifier.slice(entry.base.length);
        for (const target of entry.targets) {
          out.push(path.resolve(config.baseDir, target + rest));
        }
      }
    } else if (specifier === entry.base) {
      for (const target of entry.targets) {
        out.push(path.resolve(config.baseDir, target));
      }
    }
  }
  return out;
}

function findAliasConfig(startDir: string): AliasConfig | null {
  const cached = dirConfigCache.get(startDir);
  if (cached !== undefined) {
    return cached;
  }

  const visited: string[] = [];
  let dir = startDir;
  let result: AliasConfig | null = null;

  while (true) {
    visited.push(dir);
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(dir, name);
      if (fileExists(file)) {
        const config = loadAliasConfig(file, 0);
        if (config) {
          result = config;
          break;
        }
      }
    }
    if (result) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  for (const d of visited) {
    dirConfigCache.set(d, result);
  }
  return result;
}

function loadAliasConfig(tsconfigPath: string, depth: number): AliasConfig | null {
  if (depth > 5) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(tsconfigPath, 'utf8');
  } catch {
    return null;
  }
  const json = parseJsonc(raw);
  if (!json) {
    return null;
  }
  const co = json.compilerOptions || {};
  const tsDir = path.dirname(tsconfigPath);

  if (co.paths && typeof co.paths === 'object') {
    const baseDir = path.resolve(tsDir, typeof co.baseUrl === 'string' ? co.baseUrl : '.');
    const entries: AliasConfig['entries'] = [];
    for (const [pattern, targetsRaw] of Object.entries(co.paths)) {
      if (!Array.isArray(targetsRaw)) {
        continue;
      }
      const wildcard = pattern.endsWith('*');
      const base = wildcard ? pattern.replace(/\*$/, '') : pattern;
      const targets = (targetsRaw as unknown[])
        .filter((tg): tg is string => typeof tg === 'string')
        .map((tg) => (wildcard ? tg.replace(/\*$/, '') : tg));
      if (targets.length) {
        entries.push({ base, wildcard, targets });
      }
    }
    if (entries.length) {
      return { baseDir, entries };
    }
  }

  // Fall back to an extended config for the aliases.
  if (typeof json.extends === 'string') {
    let ext = json.extends;
    if (!ext.endsWith('.json')) {
      ext += '.json';
    }
    return loadAliasConfig(path.resolve(tsDir, ext), depth + 1);
  }
  return null;
}

function parseJsonc(text: string): any | null {
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(noTrailingCommas);
  } catch {
    return null;
  }
}
