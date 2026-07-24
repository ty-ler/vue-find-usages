# Vue: Find Component Usages

A VS Code / Cursor extension that finds **all usages of a Vue component** across your
workspace and shows them in the native "peek references" panel.

Detection is **AST-based**, not text search: `.vue` templates are parsed with
[`@vue/compiler-sfc`](https://www.npmjs.com/package/@vue/compiler-sfc) /
`@vue/compiler-dom`, and `<script>` blocks and `.js/.ts` files with
[`@babel/parser`](https://www.npmjs.com/package/@babel/parser). Because Vue treats
`<MyComponent>` and `<my-component>` as the same tag, both PascalCase and kebab-case
forms resolve to one component — and a lookup for `Foo` will **not** falsely match
`<FooBar>`.

## What it finds

- **Template tags** — `<MyComponent>`, `<my-component>`, and self-closing
  `<MyComponent/>`, matched by walking the template AST (native HTML elements are
  ignored).
- **Dynamic components** — `<component is="MyComponent">` and
  `<component :is="'MyComponent'">` with a literal name. Genuinely dynamic bindings
  like `:is="someVar"` are correctly left out.
- **Lazy / dynamic imports** — `() => import('./MyComponent.vue')` in async
  components, `defineAsyncComponent`, and vue-router route definitions, matched by
  the imported file's path.
- **Imports** — `import MyComponent from './MyComponent.vue'`, aliased and named
  imports included. A `.vue` import always counts; a non-`.vue` import counts only
  if its path actually resolves to a `.vue` file on disk (relative paths and
  `tsconfig`/`jsconfig` `paths` aliases are resolved), so a type like
  `import { Board } from '@/types/board'` is never mistaken for the `<Board>`
  component.
- **Registrations** — `components: { MyComponent }` and `{ Alias: MyComponent }` in
  the Options API.

The component name is derived from the `.vue` file name. For `index.vue`, the parent
folder name is used instead (a common Vue convention). If your project uses a custom
SFC suffix such as `HomepageView.ts.vue` (type-checked SFCs), add it to
`vueFindUsages.componentExtensions` so the name resolves to `HomepageView` rather than
`HomepageView.ts`.

## How to use

The extension activates automatically when you open a folder containing `.vue`
files. There are three ways to look up usages:

1. **Command** — open a `.vue` file (or right-click it in the Explorer) and open
   the **"Vue: Find Component Usages"** submenu. Choose **Configured Filters**,
   **Template Usages Only**, **Import Usages Only**, **Registration Usages Only**,
   or **All Component Usages**. The four presets override your settings for that
   search only; they do not modify your configuration. The Command Palette
   (`Cmd/Ctrl+Shift+P`) also provides these commands. Run one with nothing focused
   to pick a component from a list. Results open in the peek-references view.
2. **Find All References (`Shift+F12`)** — put the cursor on a component tag in a
   template (e.g. `<MyComponent>`), or anywhere in the component's own `.vue` file,
   and press `Shift+F12`. Usages appear in the native References panel. Pressing it
   on a plain `<script>` symbol defers to the TypeScript language server, so it
   doesn't add noise to ordinary lookups.
3. **CodeLens** — a `↪ N usages` lens sits above `<template>` in every `.vue` file.
   Click it to open the full list.

A categorized, clickable breakdown of every match is also written to the
**Output → Vue Find Usages** channel each time the command runs.

## Project indexing

By default the extension **indexes the whole project once** when it opens: it parses
every file a single time and groups every component usage by name. After that, the
CodeLens counts, Find All References, and the command all resolve **instantly** from
the index instead of each kicking off its own workspace scan.

- The index updates **incrementally** as you edit — only the changed file is
  re-parsed, not the whole project.
- The index retains every detected usage. Filters are applied when results are
  displayed, so changing a setting or using a one-off preset does not require a
  rebuild.
- A **persistent cache** (keyed by file mtime) means re-opening a project only
  re-parses files that actually changed since last time — subsequent opens are
  near-instant.
- On large projects, files are parsed across **worker threads** so the CPU-bound
  parsing runs in parallel. Progress shows in the status bar and clicking it
  cancels; indexing runs in the background either way.
- Turn it off with `vueFindUsages.indexOnOpen: false` to scan lazily on demand
  instead, or `vueFindUsages.parallelIndexing: false` to index single-threaded.
- Rebuild it manually anytime with **"Vue: Index Component Usages (rebuild)"** from
  the Command Palette (this forces a full re-parse and refreshes the cache).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vueFindUsages.include` | `**/*.{vue,js,ts,jsx,tsx,mjs,cjs}` | Files to search. |
| `vueFindUsages.exclude` | `**/{node_modules,dist,.git,.nuxt,.output,coverage}/**` | Files/folders to skip. |
| `vueFindUsages.includeTemplateUsages` | `true` | Report component tags and literal dynamic components in templates. |
| `vueFindUsages.includeImports` | `true` | Report static and dynamic component imports. |
| `vueFindUsages.includeRegistrations` | `true` | Report Options API `components: {}` registrations. |
| `vueFindUsages.componentExtensions` | `[".vue"]` | File suffixes treated as SFCs; the component name is the file name with the matching suffix stripped. Add `.ts.vue` for type-checked SFCs (list every suffix, including `.vue`). |
| `vueFindUsages.indexOnOpen` | `true` | Index the whole project on open for instant lookups. |
| `vueFindUsages.parallelIndexing` | `true` | Parse files across worker threads when indexing large projects. |
| `vueFindUsages.codeLens.enabled` | `true` | Show the usage-count CodeLens above `<template>`. |
| `vueFindUsages.references.enabled` | `true` | Contribute to Find All References (`Shift+F12`). |

The three usage filters apply to the configured-filter command, CodeLens counts,
and Find All References. Context-menu presets are one-off overrides.

## Develop / run locally

```bash
npm install
npm run compile      # or: npm run watch
```

Then launch an Extension Development Host from the **Run & Debug** panel. Three
launch configs are provided:

- **Run Extension (sample fixture)** — opens the bundled `test-fixture/` sandbox
  (a `UserCard` component with 7 usages exercising every detection path). Good for a
  quick smoke test.
- **Run Extension (pick a project)** — prompts for one of your local Vue projects
  and opens it directly, so you land in a single window with the project loaded.
- **Run Extension (empty)** — an empty host you can open a folder into manually.

Open a `.vue` file in the host: you should see the CodeLens above `<template>` and
`[vue-find-usages] extension activated` in the Debug Console of the window you
launched from.

### Package as a `.vsix` (installable)

```bash
npm install -g @vscode/vsce
vsce package
```

Install the generated `.vsix` via **Extensions → … → Install from VSIX** (works in
both VS Code and Cursor).

## How it works

| Concern | Approach |
| --- | --- |
| `.vue` templates | `@vue/compiler-sfc` splits the SFC; `@vue/compiler-dom` parses the template to an element tree that is walked for component tags and `<component :is>`. |
| `<script>` / `.ts` / `.js` | `@babel/parser` + `@babel/traverse` find import declarations and `components` registrations. |
| Name equivalence | All names normalize to a single key, so PascalCase, kebab-case, and the file name all resolve to the same component. |
| Speed | Files are read via `fs` and parsed across worker threads into a one-pass index; a cheap byte pre-filter skips files with no component syntax, a persistent mtime cache reuses unchanged files across sessions, and the index updates per-file on change. |

## Limitations

- **Dynamic `:is` with a non-literal expression** (`<component :is="current">`)
  cannot be resolved to a specific component — only static strings and string
  literals are.
- **Bare and unresolvable imports** aren't counted — a non-`.vue` import is only
  treated as a component if its path resolves to a `.vue` file, so barrel
  re-exports (`import { Foo } from '@/components'` pointing at an `index.ts`) and
  package imports are skipped.
- Name resolution is by component name, so two different components that share a
  name in different folders are treated as the same for lookup purposes.

## License

MIT
