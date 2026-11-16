# agent-code-mode

A generic Code Mode for coding agents. The model writes one JavaScript script that makes many tool calls (`bash`, `read`, `write`, `edit`, `grep`, `glob`) in a single step. Every call inside the script still goes through your host's permission rules and PreToolUse hooks.
It is an MCP stdio server with one tool, `run`, and works in Claude Code (interactive CLI, `claude -p`, Claude Agent SDK) and in OpenAI Codex CLI.

## Install

Requires Node.js 22 or later. `install` prints the configuration; `--write` applies it after showing the diff.

### Claude Code

```sh
npx -y agent-code-mode install --host claude              # user scope (default)
npx -y agent-code-mode install --host claude --scope project
```

User scope prints the registration command and the companion hook for `~/.claude/settings.json`:

```sh
claude mcp add --scope user agent-code-mode -- npx -y agent-code-mode serve --host claude
```

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__agent-code-mode__run", "hooks": [{ "type": "command", "command": "npx -y agent-code-mode hook" }] }
    ]
  }
}
```

Project scope writes the same server entry to `.mcp.json` and the hook to `.claude/settings.json`. The companion hook prints nothing and never decides anything: it hands the server the live permission mode, cwd and subagent of each `run` call, which Claude Code does not send to MCP servers.

In `claude -p` and the Agent SDK, allow the tool as usual (`--allowedTools mcp__agent-code-mode__run`).

### Codex CLI

```sh
npx -y agent-code-mode install --host codex   # ~/.codex/config.toml (or $CODEX_HOME); --scope project for .codex/config.toml
```

```toml
[mcp_servers.agent-code-mode]
command = "npx"
args = ["-y", "agent-code-mode", "serve", "--host", "codex"]
tool_timeout_sec = 300

[mcp_servers.agent-code-mode.tools.run]
approval_mode = "approve"
```

`run` changes files, so it does not claim `readOnlyHint`. Under `approval_policy = "never"` (including `codex exec`) Codex only calls it with the per-tool approval above. That approval only lets `run` start: every call inside it is checked against your exec-policy rules, sandbox mode and hooks.

## Usage

The script is the body of an async function. All bindings are async globals; `return` a value to get it back.

```js
const hits = await grep({ pattern: 'TODO', glob: '*.ts' });
for (const file of [...new Set(hits.matches.map((m) => m.file))]) {
  await edit({ path: file, oldString: 'TODO', newString: 'DONE', replaceAll: true });
}
const test = await bash({ command: 'npm test --silent' });
return { files: hits.matches.length, exitCode: test.exitCode };
```

| Binding | Returns |
| --- | --- |
| `bash({command, cwd?, timeoutMs?})` | `{exitCode, signal, stdout, stderr, truncated, timedOut}` |
| `read({path, offset?, limit?})` | `{path, content, startLine, totalLines, truncated}` |
| `write({path, content})` | `{path, created, diff}` |
| `edit({path, oldString, newString, replaceAll?})` | `{path, replacements, matchStrategy, diff}` |
| `grep({pattern, path?, glob?, ignoreCase?, maxResults?})` | `{matches: [{file, line, text}], truncated, filtered}` |
| `glob({pattern, path?, maxResults?})` | `{files, truncated, filtered}` |

`console.log/info/warn/error` go to `logs`. A denied call rejects with an `Error` named `PermissionDenied` (with `source` and `reason`); other failures reject with `ToolError` (with `code`). `run` takes `{code, transaction?, timeoutMs?}`. With `transaction: true`, file changes are rolled back if the script throws, times out, is cancelled or any call is denied. The result holds the return value, logs, a call log, the changed files and a combined diff.

Edits that do not match exactly fall back through tolerant rungs (line endings, copied line numbers, trailing whitespace, indentation, typographic punctuation). `matchStrategy` says which rung matched.

## Security model and limits

The script runs in a QuickJS-ng WebAssembly VM inside a child Node process. The VM has no `require`, `process`, `fetch`, timers, filesystem, network or environment. Its only way out is the six bindings. Each binding call goes back to the server, which:

1. **prepares** the exact effect (real paths inside the workspace, the diff of a write, the command and cwd of `bash`) with no side effect;
2. **authorizes** it as the native tool: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob` in Claude Code; shell commands and `apply_patch` in Codex. Your permission rules (deny → ask → allow) apply, then your PreToolUse hooks run with the input the native tool would send. A hook rewrite (`updatedInput`) is re-validated, re-prepared and re-checked against the rules;
3. **commits** exactly what was authorized, re-checking that the file did not change in between.

Semantics:

- **Fail-closed.** A hook that crashes, times out, exits with an unexpected code or prints invalid output denies the call. So does a configuration the server cannot understand: a malformed rule, an unknown hook type or an unreadable settings file denies every call.
- **`ask` is denied.** The server has no way to prompt you. When the host would ask, the call is refused with source `ask-unavailable`. Allow what the script needs with your usual rules or permission mode.
- **Auto mode (Claude).** Claude's classifier reviews the whole `run` call once. Deny and ask rules still apply to every inner call. If an allow rule approves `run` itself, the classifier never saw the script, so inner calls no rule decides follow auto mode's fallback: reads and edits inside the working directories pass, everything else asks.
- **Paths.** Calls are confined to the session cwd, the client's roots and the host's additional directories. Symlinks leading out are refused. Host policy files (`.claude/settings*.json`, `.claude/hooks/`, `.mcp.json`, `.codex/`, `~/.claude/`, `$CODEX_HOME`, the server state dir) cannot be written. `grep` and `glob` drop files your Read rules deny and count them in `filtered`.
- **`bash` containment** mirrors the host. When Claude's sandbox is enabled, or Codex runs `read-only`/`workspace-write`, commands run in an OS sandbox (bubblewrap on Linux, Seatbelt on macOS) with the host's writable roots. If that cannot be enforced, the call is refused, never run unconfined.
- **Rollback covers files only.** Effects of `bash` (processes, network, files a command wrote) are never undone; the result warns when a rolled-back run had committed `bash` calls.
- **Network on Node 22/24.** Node's permission model blocks sockets in the sandbox child only from Node 25. On Node 22 and 24, network isolation of scripts rests on the QuickJS VM exposing no network API.
- **Windows.** `bash` needs Git Bash and is otherwise refused; OS containment is not available there.
- **Unknown clients.** When neither Claude Code nor Codex is detected and no `--host` is given, only `read`, `grep` and `glob` inside the workspace are allowed; every other call is denied with the reason.

What the server cannot see, so it cannot apply:

- CLI flags other than those it parses from the parent process (`--settings`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--setting-sources`, `--add-dir` for Claude; `-c`, `--profile`, `-s`, `-a` for Codex), and anything passed over the Agent SDK control channel;
- managed policies delivered by MDM or the Windows registry;
- Agent SDK `canUseTool` callbacks;
- Claude skill and agent frontmatter hooks, and `prompt`/`agent`/`mcp_tool` hook types (refused, not ignored).

Output is capped below the hosts' MCP limits (about 30,000 characters, less for errors). A larger result is written to a file in the state directory and its path is returned.

## Compared with the built-in code modes

- **Claude Code's official Code Mode** applies the same per-call rules and hooks, but only in interactive sessions. agent-code-mode also works in `claude -p`, the Agent SDK and Codex, and every call shows up in a call log you get back.
- **Codex's own code mode.** Codex 0.169 models already run in Codex's code mode by default (its `exec` tool calls nested tools). agent-code-mode gives Codex the same binding surface as Claude, with transactions, the call log and your hooks applied to file reads and edits made inside the script.

## Benchmark

`bench/` compares native tools, the host's own code mode and agent-code-mode on the same tasks, on both hosts. It uses your logged-in `claude` and `codex` and costs real tokens.

```sh
npm run bench -- --dry-run                                  # no model calls
npm run bench -- --host claude --arms A,C --tasks T1,T5 --runs 3
```

Results pending.

## Development

```sh
npm ci
npm run verify          # typecheck, tests (including test/attack), build
test/e2e/claude.sh <dir>   # real claude -p run with the example deny-rm hook (needs login)
test/e2e/codex.sh <dir>    # real codex exec run with the same hook (needs login)
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE), which lists the third-party code this project adapts.
