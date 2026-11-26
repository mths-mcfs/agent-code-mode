# agent-code-mode

A generic Code Mode for coding agents. The model writes one JavaScript script that makes many tool calls (`bash`, `read`, `write`, `edit`, `grep`, `glob`) in a single step. Every call inside the script still goes through your host's permission rules and PreToolUse hooks.
It is an MCP stdio server with one tool, `run`, and works in Claude Code (interactive CLI, `claude -p`, Claude Agent SDK) and in OpenAI Codex CLI.

Status: under construction, not published to npm yet. The `npx -y agent-code-mode` commands below work once it is. Until then, build a checkout and run its installer with `--local`, which registers `node <checkout>/dist/cli.js` instead of `npx`, in the server entry, the companion hook and the printed `claude mcp add` command alike:

```sh
npm ci && npm run build
node dist/cli.js install --host claude --local    # or --host codex; add --scope project and --write as below
```

## Install

Requires Node.js 22.12 or later. `install` prints the configuration; `--write` applies it after showing the diff.

### Claude Code

```sh
npx -y agent-code-mode install --host claude              # user scope (default)
npx -y agent-code-mode install --host claude --scope project
```

User scope prints the registration command and the companion hook for `~/.claude/settings.json`. It never edits `~/.claude.json`; run the command yourself:

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

Project scope writes the same server entry to `.mcp.json` and the hook to `.claude/settings.json`. The companion hook prints nothing and decides nothing: it hands the server the live permission mode, cwd and subagent of each `run` call, which Claude Code does not send to MCP servers. Without it the server assumes the `default` mode.

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

`run` changes files, so it does not claim `readOnlyHint`. Under `approval_policy = "never"` (including `codex exec`) Codex calls it only with the per-tool approval above. That approval only lets `run` start: every call inside it is checked against your exec-policy rules, sandbox mode and hooks. A run is capped at `tool_timeout_sec` minus 10 seconds, because Codex does not extend its tool timeout for progress. `--write` leaves an existing `[mcp_servers.agent-code-mode]` table alone and tells you to compare it by hand.

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

Edits that do not match exactly fall back through tolerant rungs (line endings, copied line numbers, trailing whitespace, indentation, typographic punctuation). `matchStrategy` names the rung that matched.

Under Codex, `grep` and `glob` run as one ripgrep command through the shell, so your rules and hooks judge exactly the search that runs; the tool description gives the pattern syntax.

## Security model and limits

The script runs in a QuickJS-ng WebAssembly VM inside a child Node process. The VM has no `require`, `process`, `fetch`, timers, filesystem, network or environment. Its only way out is the six bindings. Each binding call goes back to the server, which:

1. **prepares** the exact effect (real paths inside the workspace, the diff of a write, the command and cwd of `bash`) with no side effect;
2. **authorizes** it as the native tool: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob` in Claude Code; shell commands and `apply_patch` in Codex. Your permission rules (deny, then ask, then allow) apply, then your PreToolUse hooks run with the input the native tool would send. A hook rewrite (`updatedInput`) is re-validated, re-prepared and re-checked against the rules;
3. **commits** exactly what was authorized, re-checking that the file did not change in between.

Semantics:

- **Fail-closed.** A hook that crashes, times out, exits with an unexpected code or prints invalid output denies the call. So does a configuration the server cannot understand: a malformed rule, an unknown hook type or an unreadable settings file denies every call.
- **`ask` is denied.** The server has no way to prompt you. When the host would ask, the call is refused with source `ask-unavailable`. Allow what the script needs with your usual rules or permission mode.
- **Bash under Claude Code** runs only when an exact allow rule names the command (no wildcards) or inside Claude's sandbox (`sandbox.enabled`). A broad rule such as `Bash` or `Bash(npm:*)` does not approve a command inside a script, because the server cannot establish what such a command will touch. Deny and ask rules still apply to every command.
- **Permission modes (Claude).** Project and local settings cannot start `bypassPermissions` or `auto`, as in Claude Code; the live mode comes from the companion hook. In auto mode the classifier reviews the whole `run` call once; inner calls no rule decides follow auto mode's fallback: reads and edits inside the working directories pass, everything else asks.
- **Paths.** Calls are confined to the session cwd, the client's roots and the host's additional directories (Claude `additionalDirectories` and `--add-dir`, Codex writable roots in `workspace-write`). Symlinks leading out are refused, and path rules also match the path as the script wrote it. Host policy files (`.claude/settings*.json`, `.claude/hooks/`, `.mcp.json`, `.codex/`, `~/.claude/`, `$CODEX_HOME`, the server state dir) cannot be written. `grep` and `glob` skip files your Read deny and ask rules cover and count them in `filtered`.
- **`bash` containment** mirrors the host. When Claude's sandbox is enabled, or Codex runs `read-only` or `workspace-write`, commands run in an OS sandbox (bubblewrap on Linux, Seatbelt on macOS) with the host's writable roots. If that cannot be enforced, the call is refused, never run unconfined. On Ubuntu 24.04, AppArmor's unprivileged user-namespace restriction blocks bubblewrap until it is lifted (see `.github/workflows/ci.yml`).
- **Overlapping transactions.** Within one server, a transactional run may not write a file that another unfinished transactional run already wrote: that write fails, so both runs can still roll back to the true original. Separate server processes are not coordinated.
- **Crash recovery.** If the server dies mid-transaction, the next server restores the files from its journal: at start for its own cwd, and on the first run in each other workspace root. A file is restored only when it still is exactly the file the crashed run installed; anything else is reported as a conflict and left alone, and leftover temporary files are reported, never deleted. The run that follows gets the report in its warnings.
- **Rollback covers files only.** Effects of `bash` (processes, network, files a command wrote) are never undone; the result warns when a rolled-back run had committed `bash` calls.
- **Windows.** `read`, `write`, `edit`, `grep` and `glob` are refused for now, because Node offers no handle-relative file operations there (#28). `bash` needs Git Bash and has no OS sandbox.
- **macOS.** The host's launch flags (and, under Codex, its `CODEX_HOME`) are read from the parent process through the kernel, by the system `/usr/bin/perl`. Apple ships that perl only for compatibility with legacy software and may remove it. If it is missing or is not a root-owned file, the flags cannot be ruled out and Code Mode refuses every call on macOS.
- **Unknown clients.** When neither Claude Code nor Codex is detected and no `--host` is given, only `read`, `grep` and `glob` inside the workspace are allowed; every other call is denied with the reason.

What the server cannot see, so it cannot apply:

- CLI flags other than those it parses from the parent process (`--settings`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--setting-sources`, `--add-dir` for Claude; `-c`, `--profile`, `-s`, `-a`, `--add-dir` for Codex), and anything passed over the Agent SDK control channel;
- managed policies delivered by MDM or the Windows registry;
- Agent SDK `canUseTool` callbacks;
- Claude skill and agent frontmatter hooks, and `prompt`/`agent`/`mcp_tool` hook types (refused, not ignored).

Output is capped below the hosts' MCP limits (30,000 characters, 9,500 for errors). A larger result is written to a file in the state directory and its path is returned.

Set `AGENT_CODE_MODE_LOG=<absolute file>` in the server's environment to append one JSON line per run (context sources and the call log) and per crash recovery. It is off by default.

## Development

```sh
npm ci
npm run verify             # typecheck, tests (including test/attack), build
test/e2e/claude.sh <dir>   # real claude -p run with the example deny-rm hook (needs a logged-in claude)
test/e2e/codex.sh <dir>    # real codex exec run with the same hook (needs a logged-in codex)
```

## Benchmark

`bench/` runs the same tasks with native tools, the host's own code mode and agent-code-mode, on both hosts. A real run uses your logged-in `claude` and `codex` and costs real tokens. It needs Node.js 22.18 or later. The agent-code-mode arms need `npm run build`, and they do not run on Windows, where `run` refuses file operations.

```sh
npm run bench -- --dry-run                                   # reference solutions and recorded transcripts, no model calls
npm run bench -- --host claude --arms A,B --tasks T1,T5 --runs 3
npm run bench:report                                         # re-render the newest bench/results/<date>
```

The dry run exits non-zero when a planned run fails, is invalid or left no record. The task checks run the workspace's tests in the same OS sandbox as `bash` (writes only to the workspace, no network), so they need its dependencies (Bubblewrap and socat on Linux). On Windows they run unconfined.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE), which lists the third-party code this project adapts.
