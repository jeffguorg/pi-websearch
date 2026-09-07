# Repository Conventions

Conventions for human contributors and AI agents working on this repository.

## Style

- Terse technical prose. No emojis in commits, issues, PR comments, or code.
- TypeScript strict mode. No `any`, no `unknown` casts where avoidable, no `@ts-ignore`, no `@ts-expect-error`, no enums.
- ESM modules with `.js` suffix in import paths (Node16 resolution).
- Tabs for indentation. Double quotes for strings.
- Tests use vitest with `#given .. #when .. #then` description style or plain `// given / // when / // then` body comments.

## Commands

- `npm install` — install dependencies.
- `npm test` — run vitest test suite once.
- `npm run typecheck` — strict TypeScript check.
- `npm run check` — type check + biome.
- `pi -e ./src/index.ts` — load the extension into a local pi session for manual smoke testing.

## Constraints

- No Bun APIs. Runtime is Node 22.19+.
- The extension is standalone and depends only on the public pi extension API.
- Provider configuration is explicit: with no config file the extension activates with the free duckduckgo-html default; an invalid or insufficient config file refuses activation and surfaces a TUI startup error.
- Exa, Tavily, Brave, Serper, Google CSE, Z.ai, OpenAI/Codex hosted search, Anthropic Messages search, Perplexity, and xAI require their documented credentials.
- `enableNative` (default `true`) prepends an implicit `native` entry when `ExtensionContext.model` matches a server-hosted-search-supported provider+model combo. Native entry inherits auth via `ExtensionContext.modelRegistry.getApiKeyAndHeaders`, preserves `model.baseUrl` (so any local gateway baseUrl override registered in the pi model registry flows through), and routes through the existing provider adapter; explicit `providers` remain the fallback chain. Recognized provider aliases: `zai` for `z-ai`, and `openrouter` model ids of the form `<upstream>/<model>` are unwrapped before matching.
- Routing is priority-ordered only: routes run as `[native?, ...providers sorted by ascending priority]`. `appendProvidersAsFallback` (default `true`) lets operational failures advance to the next route; per-call `retry_on_empty` extends the chain past successful empty responses. There is no `strategy`, `weight`, or per-call `use_fallback`. Config files are validated against a strict JSON Schema (ajv): unknown keys, wrong types, and out-of-range numbers are rejected with the offending key path, and legacy keys (`auto`, `strategy`, `weight`, `fallback`, `fallback_chain`, top-level `provider`/`backend`) are rejected with a migration hint. `maxResults` is per-entry only (integer 1-50, default 10); there is no request-level limit. Native-resolution failures (auth, endpoint) are soft under the default config: the chain runs without the native route and the diagnostic surfaces only as typed `details.warnings` for TUI rendering, never in tool text returned to the model.
- TUI rendering reads typed `details` returned by tool `execute`; renderers never parse formatted strings.
