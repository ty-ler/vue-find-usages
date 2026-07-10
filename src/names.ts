import * as path from 'path';
import { componentBaseName } from './componentExt';

export { componentBaseName } from './componentExt';

export interface ComponentTarget {
  /** The canonical PascalCase component name, e.g. "UserCard". */
  pascal: string;
  /** The kebab-case form, e.g. "user-card". */
  kebab: string;
  /** The normalized key used for equality comparisons. */
  key: string;
  /** The raw `.vue` file base name (no extension). */
  fileBase: string;
}

export function toPascalCase(s: string): string {
  return s
    .replace(/[-_ ]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

export function toKebabCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_ ]+/g, '-')
    .toLowerCase();
}

/** Normalizes any casing to a single comparable key (kebab, lowercased). */
export function normalizeKey(s: string): string {
  return toKebabCase(s).replace(/^-+|-+$/g, '');
}

/** Builds the component target from a `.vue` file path. */
export function deriveTarget(fsPath: string): ComponentTarget {
  let base = componentBaseName(fsPath);
  // index.vue conventionally takes the component name from its folder.
  if (base.toLowerCase() === 'index') {
    const dir = path.basename(path.dirname(fsPath));
    if (dir) {
      base = dir;
    }
  }
  const pascal = toPascalCase(base);
  return {
    pascal,
    kebab: toKebabCase(base),
    key: normalizeKey(base),
    fileBase: base,
  };
}

/** Builds a component target from a bare name (e.g. a tag or identifier). */
export function targetFromName(name: string): ComponentTarget {
  return {
    pascal: toPascalCase(name),
    kebab: toKebabCase(name),
    key: normalizeKey(name),
    fileBase: toPascalCase(name),
  };
}

/** True when a candidate tag / identifier / path stem refers to this component. */
export function matchesTarget(target: ComponentTarget, candidate: string): boolean {
  return normalizeKey(candidate) === target.key;
}
