import * as path from 'path';

/**
 * The set of file suffixes treated as Vue single-file components, e.g. `.vue`
 * and (for type-checked SFCs) `.ts.vue`. Kept as mutable module state so it can
 * be configured on the main thread and re-applied inside worker threads (which
 * receive the list over a message). Sorted longest-first so a `.ts.vue` file is
 * matched by `.ts.vue` rather than `.vue`.
 */
let suffixes: string[] = ['.vue'];

export function setComponentExtensions(list: readonly string[] | undefined): void {
  const cleaned = (list ?? [])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => (s.startsWith('.') ? s : '.' + s).toLowerCase());
  const unique = [...new Set(cleaned)].sort((a, b) => b.length - a.length);
  suffixes = unique.length > 0 ? unique : ['.vue'];
}

export function getComponentExtensions(): string[] {
  return suffixes;
}

/** True when a file name ends with one of the configured component suffixes. */
export function isComponentFile(fileName: string): boolean {
  const lower = path.basename(fileName).toLowerCase();
  return suffixes.some((suf) => lower.endsWith(suf));
}

/**
 * The component name for a file: the base name with its longest matching
 * component suffix removed (`HomepageView.ts.vue` -> `HomepageView`). Falls back
 * to stripping a single trailing extension for anything else.
 */
export function componentBaseName(fileName: string): string {
  const bn = path.basename(fileName);
  const lower = bn.toLowerCase();
  for (const suf of suffixes) {
    if (lower.endsWith(suf)) {
      return bn.slice(0, bn.length - suf.length);
    }
  }
  return bn.replace(/\.[^.]+$/, '');
}
