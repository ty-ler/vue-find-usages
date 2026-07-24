import * as vscode from 'vscode';
import { UsageKind } from './scanCore';

export interface UsageFilter {
  template: boolean;
  imports: boolean;
  registrations: boolean;
}

export const ALL_USAGE_FILTER: UsageFilter = {
  template: true,
  imports: true,
  registrations: true,
};

export const TEMPLATE_ONLY_USAGE_FILTER: UsageFilter = {
  template: true,
  imports: false,
  registrations: false,
};

export const IMPORTS_ONLY_USAGE_FILTER: UsageFilter = {
  template: false,
  imports: true,
  registrations: false,
};

export const REGISTRATIONS_ONLY_USAGE_FILTER: UsageFilter = {
  template: false,
  imports: false,
  registrations: true,
};

export function getConfiguredUsageFilter(): UsageFilter {
  const config = vscode.workspace.getConfiguration('vueFindUsages');
  return {
    template: config.get<boolean>('includeTemplateUsages', true),
    imports: config.get<boolean>('includeImports', true),
    registrations: config.get<boolean>('includeRegistrations', true),
  };
}

export function filterUsages<T extends { kind: UsageKind }>(
  usages: readonly T[],
  filter: UsageFilter,
): T[] {
  return usages.filter(({ kind }) => {
    switch (kind) {
      case 'tag':
      case 'dynamic-is':
        return filter.template;
      case 'import':
      case 'dynamic-import':
        return filter.imports;
      case 'registration':
        return filter.registrations;
      default:
        return assertNever(kind);
    }
  });
}

export function affectsUsageFilters(event: vscode.ConfigurationChangeEvent): boolean {
  return (
    event.affectsConfiguration('vueFindUsages.includeTemplateUsages') ||
    event.affectsConfiguration('vueFindUsages.includeImports') ||
    event.affectsConfiguration('vueFindUsages.includeRegistrations')
  );
}

function assertNever(value: never): never {
  throw new Error(`Unknown usage kind: ${value}`);
}
