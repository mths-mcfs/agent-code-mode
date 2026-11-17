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
claude mcp add --scope user agent-code-mode -- npx -y agent-code-mode serve --host claude --hybrid
```

Install uses `--hybrid` by default because Claude Code keeps its native file and shell tools enabled next to `run`: the tool description then says when to batch calls with `run` and when a native tool is enough. Drop `--hybrid` only if you turn the native tools off and the model works through `run` alone.

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
for (const file of [...new Set(hits.rows.map(([file]) => file))]) {
  await edit({ path: file, oldString: 'TODO', newString: 'DONE', replaceAll: true });
}
const test = await bash({ command: 'npm test --silent' });
return { matches: hits.count, exitCode: test.exitCode };
```

| Binding | Returns |
| --- | --- |
| `bash({command, cwd?, timeoutMs?})` | `{exitCode, signal, stdout, stderr, truncated, timedOut}` |
| `read({path, offset?, limit?})` | `{path, content, startLine, totalLines, truncated}` |
| `write({path, content})` | `{path, created, diff}` |
| `edit({path, oldString, newString, replaceAll?})` | `{path, replacements, matchStrategy, diff}` |
| `grep({pattern, path?, glob?, ignoreCase?, maxResults?})` | `{columns: ['file', 'line', 'text'], rows: [[file, line, text]], count, truncated, filtered}` |
| `glob({pattern, path?, maxResults?})` | `{files, truncated, filtered}` |
| `readOverflow(id, offset?, limit?)` | `{text, offset, totalChars, truncated}`: a slice of a result a response cut |

`console.log/info/warn/error` go to `logs`. A denied call rejects with an `Error` named `PermissionDenied` (with `source` and `reason`); other failures reject with `ToolError` (with `code`). `read` returns the exact text of the lines, final newline included, and paths in results are relative to the working directory when inside it. `run` takes `{code, transaction?, timeoutMs?, verbose?}`. With `transaction: true`, file changes are rolled back if the script throws, times out, is cancelled or any call is denied; if the server process dies mid-run, the next start restores them from its journal (inside the roots of that run only). The response is a JSON block: `{ok, result | error, logs, calls: {total, byTool, denied, errors}, changedFiles, diff | diffStat, warnings}`, with empty fields left out. Every denied and failed call is listed with its reason, and every changed file is listed. A multi-line string result longer than 200 characters comes as plain text in a second block instead of an escaped JSON string. A diff above 1,500 characters becomes `diffStat` (lines added and removed for up to 10 files, plus the totals). A response stays under about 10,000 tokens (40,000 characters; 9,500 for an error): above that, the result and the logs keep their start and end, long lists keep their first entries, each cut is marked and `truncated: true` is set. Denied and failed calls are never cut by entry: when they do not fit whole, they are grouped by tool and reason as `{tool, reason, count, first}` (`first` is the summary of the first call), so every distinct reason shows with its exact count. Only with thousands of distinct reasons is each reason cut to 200 characters and, if that is still too much, the last groups replaced by a `…[N more reasons (M calls)]` marker. With `verbose: true`, a call log above the cap keeps its first entries and the compact calls come beside it as `callSummary`. Whenever something is left out, the whole result is kept in the server's memory for 30 minutes and the response carries `overflow: {id, chars}`; a later script reads it with `readOverflow(id)`. The id is random, works only in the same server process and nothing is written to disk. `verbose: true` returns the log of every call and the whole diff.

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
- **Globs in `bash` (Claude).** A relative glob read by `cat`, `head`, `tail`, `wc` or `ls` (with options from a fixed list, no `ls -R`, no redirection, no `..`, `~`, `$VAR`, `$(...)` or backticks) is expanded before authorization, and the command names each match literally, single-quoted after `--`: `wc -l src/*` becomes `wc -l -- 'src/a.js' 'src/b.js'`. Rules, hooks and the result (`command`) see that command. The matches and their order come from the same bash, in the same environment and locale, with startup files (`BASH_ENV`) left out so expanding runs no code; on Windows (Git Bash) globs are not expanded. Each match must resolve inside the workspace and be a regular file (or a directory for `ls`, whose listed children must pass your Read rules); otherwise the call fails. A glob that matches nothing, or any other command, stays as written. Right before the command starts, every match is checked again (device, inode and type, of the link and of what it points to); if one changed, nothing runs. What remains is the moment between that check and the reader opening the file, a few milliseconds in which a process that can write the workspace could swap a file. Native Claude Code checks a command's paths and then runs it with no second check at all, so that window is larger there.
- **`bash` containment** mirrors the host. When Claude's sandbox is enabled, or Codex runs `read-only`/`workspace-write`, commands run in an OS sandbox (bubblewrap on Linux, Seatbelt on macOS) with the host's writable roots. If that cannot be enforced, the call is refused, never run unconfined.
- **Protected-path watch.** Around every `bash` call, and once more at the end of the run, the server fingerprints the host policy files it reads (settings, hooks and agents, `.mcp.json`, Codex config, hooks and rules) and its state dir, and adds a `warnings` line naming any that changed, other than its own writes; the call keeps its result. This detects and reports, it does not prevent or restore: a change reverted before the comparison goes unseen, a change by another process (the host, another run) is reported too, Windows links and junctions are untested for this check, and if the fingerprint cannot be taken before a command (unreadable, too many entries, too slow) the command is refused. A new, well-formed companion-hook record in the state dir is not reported (parallel subagents write them all the time; a forged one would need the id of a tool call the host has not issued yet), while a changed existing record is. Files past the hashing budget are named as checked by metadata only.
- **Overlapping transactions.** Within one server, a transactional run may not write a file that another unfinished transactional run already changed: that write fails, so both runs can still roll back to the true original.
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

- **Claude Code's official Code Mode** applies the same per-call rules and hooks, but only in interactive sessions. agent-code-mode also works in `claude -p`, the Agent SDK and Codex, and every denied or failed call shows up in the result you get back (every call with `verbose: true`).
- **Codex's own code mode.** Codex 0.169 models already run in Codex's code mode by default (its `exec` tool calls nested tools). agent-code-mode gives Codex the same binding surface as Claude, with transactions, the call log and your hooks applied to file reads and edits made inside the script.

## Benchmark

`bench/` runs the same eight tasks on one fixture repository through each host with different tool surfaces, three runs per arm, and checks every result with a verifier. Claude Code: A = native tools, B = agent-code-mode only, C = native tools plus agent-code-mode, D = Claude Code's own experimental Code Mode (it exists only in an interactive session, so D runs in tmux and its cost is computed from the session transcript's usage with `bench/pricing.json`; needs `tmux`). Codex: A = native tools (forced through a custom model catalog), B = Codex's own code mode (the default in Codex 0.169), C = agent-code-mode only.

Run of 2026-11-16 on this branch at 35260ce: Claude Code 2.1.325 with `claude-sonnet-5-5`, Codex CLI 0.169.0 with `gpt-6.1-terra`, both at medium effort, seed 20261115. 120 runs, all valid, all passing; US$ 2.85 in total. Raw results, transcripts and the full table: [`bench/results/2026-11-16/`](bench/results/2026-11-16/) ([`summary.md`](bench/results/2026-11-16/summary.md)).

Median of 3 runs, turns · cost · wall time:

| Task | Claude A native | Claude B acm | Codex A native | Codex B code mode | Codex C acm |
|---|---|---|---|---|---|
| T1 read one config value | 2 · $0.006 · 4.2s | 2 · $0.006 · 4.3s | 2 · $0.007 · 6.3s | 2 · $0.007 · 7.5s | 2 · $0.011 · 6.0s |
| T2 fix a one-line bug | 5 · $0.018 · 10.6s | 4 · $0.024 · 9.2s | 8 · $0.026 · 20.7s | 6 · $0.040 · 23.1s | 5 · $0.023 · 21.5s |
| T3 report two signatures | 2 · $0.006 · 4.7s | 2 · $0.009 · 4.9s | 2 · $0.007 · 7.7s | 2 · $0.009 · 6.9s | 3 · $0.011 · 10.2s |
| T4 top customers across 50 files | 4 · $0.015 · 8.0s | 4 · $0.032 · 9.9s | 4 · $0.014 · 12.4s | 4 · $0.018 · 13.3s | 6 · $0.019 · 18.9s |
| T5 rename a symbol used in ~30 files | 3 · $0.019 · 6.4s | 3 · $0.045 · 7.1s | 4 · $0.020 · 13.6s | 4 · $0.021 · 16.7s | 3 · $0.013 · 13.8s |
| T6 add a field to 40 data files | 4 · $0.022 · 10.5s | 6 · $0.137 · 16.1s | 5 · $0.016 · 21.1s | 4 · $0.022 · 20.0s | 6 · $0.023 · 35.5s |
| T7 debug 5 failing tests (3 bugs) | 4 · $0.025 · 8.3s | 4 · $0.029 · 10.4s | 8 · $0.030 · 25.9s | 5 · $0.026 · 25.2s | 4 · $0.025 · 21.6s |
| T8 batch edit, one target protected by a hook | 22 · $0.070 · 21.4s | 3 · $0.030 · 8.4s | 5 · $0.019 · 24.1s | 5 · $0.020 · 23.1s | 4 · $0.014 · 14.3s |

What this shows:

- **Claude Code:** agent-code-mode cost more than native tools in 7 of 8 tasks. It cost less only in T8, where a hook denies one of the edits: native went through 22 turns, agent-code-mode 3 ($0.070 → $0.030). The largest loss is T6 ($0.022 → $0.137): each `run` result carries the call log and the combined diff of 40 edited files (17,000 to 20,000 characters per result), and that text stays in the cached context for every later turn.
- **Codex:** agent-code-mode was the cheapest of the three arms in T2, T5, T7 and T8, and more expensive than the cheapest arm in T1, T3, T4 and T6. Codex's own code mode is the default in 0.169, so arm B is the realistic baseline there.
- Fewer turns did not always mean lower cost: what matters is how much text each turn adds to the context.

Limits:

- One machine, three runs per arm, medium effort only.
- One small fixture repository with small tasks. Every arm passed every task, so this measures cost, turns and time, not correctness.
- Claude cost is the `total_cost_usd` Claude Code reports. It matches list prices once cache writes are priced at the 1-hour TTL Claude Code uses (`bench/pricing.json`). Codex cost is computed from list prices. Compare costs within a host, not across hosts.
- Codex arm A is forced to native tools through a custom model catalog; it is not how Codex 0.169 ships.
- Wall time includes host startup.

To run it yourself (uses your logged-in `claude` and `codex` and costs real tokens):

```sh
npm run bench -- --dry-run                                  # no model calls
npm run bench -- --host claude --arms A,B --tasks T1,T5 --runs 3
```

## Development

```sh
npm ci
npm run verify          # typecheck, tests (including test/attack), build
test/e2e/claude.sh <dir>   # real claude -p run with the example deny-rm hook (needs login)
test/e2e/codex.sh <dir>    # real codex exec run with the same hook (needs login)
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE), which lists the third-party code this project adapts.
