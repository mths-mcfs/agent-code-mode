# agent-code-mode

An MCP stdio server that exposes one tool, `run`: the model writes a JavaScript script that runs in an isolated QuickJS-ng WASM sandbox and calls async bindings (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `test`, `undo`).
Every binding call is prepared, authorized against the host's permission rules and PreToolUse hooks (Claude Code or Codex CLI, fail-closed), and only then committed exactly as authorized.

## Verification

`npm run verify` (typecheck, tests, build). It must pass before any change is considered done.

## Repo rules

- English only: code, comments, tests, commit messages, PRs, README.
- The repo is public: nothing private (personal names, emails, home-directory paths, machine names, personal hook or config names). Test fixtures use generic example hooks.
- No `docs/` folder and no extra markdown files; the only markdown files are README.md, CLAUDE.md and AGENTS.md.
- Validate outside data at the boundary with zod (MCP requests, sandbox IPC, hook stdout, config files, `_meta`); never use `as` on unvalidated data. Internal code trusts validated types.
- TypeScript strict, ESM, Node >= 22. Keep dependencies small and justified.

## Module map

- `src/core`: contracts (`types.ts`), boundary schemas, dispatcher (prepare, authorize, commit), run orchestration, output shaping, command hooks.
- `src/server`: MCP stdio server, host detection, runtime factory (real sandbox, tools and host adapters), the generic read-only policy.
- `src/cli.ts`, `src/install.ts`: `serve`, `hook` (Claude companion hook) and `install`.
- `src/sandbox`: QuickJS-ng WASM sandbox in a child process.
- `src/hosts/claude`: Claude Code host adapter (settings, permission rules, hooks).
- `src/hosts/codex`: Codex CLI host adapter (config, exec policy, hooks).
- `src/mcp`: upstream MCP servers of `serve --mcp-config` (config, name rules, connections and catalog, the `mcpCall` binding).
- `src/tools`: tool runtime (`bash`, `read`, `write`, `edit`, `grep`, `glob`), journal and rollback, undo, session directories (scratch).
- `src/testing`: fakes for tests (sandbox, host adapter, in-memory tool runtime).
- `test/attack`: attack suite through `run` with the real sandbox, tools and adapters (part of `npm test`).
- `test/e2e`: real-host end-to-end scripts (need a logged-in `claude`/`codex`; not in CI).
- `bench`: benchmark.
