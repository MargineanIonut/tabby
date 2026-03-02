# Copilot instructions for Tabby

## Build, lint, and test commands

### Install dependencies
Run from repository root:

Use Node 22 to match CI (`.github/workflows/build.yml`).

```bash
yarn
```

`yarn` triggers root `postinstall`, which runs `scripts/install-deps.mjs` (installs app/web/plugin deps) and `scripts/build-native.mjs` (rebuilds native modules against Electron).

### Build
- Full build (typings + app main + app renderer + all packages in `scripts/vars.mjs`):

```bash
yarn build
```

- Typings only:

```bash
yarn build:typings
```

- Build one package/module while iterating:

```bash
cd tabby-core && yarn build
```

(Use the same pattern for `app`, `tabby-terminal`, `tabby-local`, etc.)

### Run and lint
- Start desktop app in dev mode:

```bash
yarn start
```

- Rebuild on changes:

```bash
yarn watch
```

- Lint TypeScript (`*/src` + `*/lib`):

```bash
yarn lint
```

- Build API docs:

```bash
yarn build:typings && yarn docs
```

### Tests
There is currently no `test`/`test:*` script in repository `package.json` files, and there are no `*.spec.*` / `*.test.*` files in the repo.

CI (`.github/workflows/build.yml`) runs:

```bash
yarn build:typings && yarn lint
```

Single-test command: not available in the current codebase.

## High-level architecture

- **Electron shell (`app`)**
  - `app/lib/index.ts` is the Electron main-process entry point (CLI parsing, config load, single-instance handling, window lifecycle, `tabby://` protocol handling).
  - `app/src/entry.ts` is the renderer bootstrap entry (receives bootstrap data over IPC, discovers plugins, loads plugin modules, boots Angular).
  - If normal bootstrap fails, `app/src/entry.ts` retries in safe mode by loading built-in plugins only.

- **Plugin-first Angular composition**
  - `app/src/app.module.ts#getRootModule` builds the runtime Angular root module by importing all discovered plugin modules plus shared framework modules.
  - The root bootstrap component comes from plugin exports (`bootstrap` export), not a hard-coded app component.

- **Plugin discovery/loading path**
  - `app/src/plugins.ts` discovers packages from builtin paths, user plugin directory, and `TABBY_PLUGINS`.
  - Packages must pass keyword checks (`tabby-plugin`, `tabby-builtin-plugin`, `terminus-plugin`, or `terminus-builtin-plugin`) to load.
  - Runtime loads `default` export; if it has `forRoot`, loader calls it.

- **Build orchestration**
  - Root `scripts/build-modules.mjs` sequentially runs webpack configs for:
    1. `app/webpack.config.main.mjs`
    2. `app/webpack.config.mjs`
    3. every package listed in `scripts/vars.mjs#allPackages`
  - `scripts/vars.mjs#builtinPlugins` defines the built-in plugin set shipped with desktop builds.

## Key conventions in this repository

- **Extension pattern is DI multi-provider based:** plugins register behavior via `tabby-core` provider tokens (`ConfigProvider`, `HotkeyProvider`, `TabContextMenuItemProvider`, `ProfileProvider`, `CLIHandler`, etc.) with `multi: true`, as seen across `tabby-core`, `tabby-local`, `tabby-terminal`, and `tabby-settings`.

- **Plugin package contract matters:** package names are `tabby-*` (legacy `terminus-*` is still recognized), and plugin metadata must be in package keywords for discovery in `app/src/plugins.ts`.
- **Plugin module export contract is strict:** plugin loader expects a `default` export and will call `default.forRoot()` when present (`app/src/plugins.ts`); plugin bootstrap components are provided via a `bootstrap` export (`app/src/app.module.ts`).

- **Desktop runtime excludes web plugin module during normal app bootstrap:** `app/src/entry.ts` filters plugin list with `x.name !== 'web'`.

- **Formatting/linting expectations are strict and centralized:** TypeScript is 4-space indented with single quotes and no semicolons (`.editorconfig`, `.eslintrc.yml`), and CI uses root `yarn lint`.
