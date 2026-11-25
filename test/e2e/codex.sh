#!/usr/bin/env bash
# End-to-end check on a real Codex CLI (needs a logged-in `codex`; not run in CI).
#
#   test/e2e/codex.sh <empty work dir> [model]
#
# Builds the package, creates a temporary CODEX_HOME (the real auth.json is
# linked, never copied, and the real ~/.codex is never written) whose
# config.toml holds the block `agent-code-mode install --host codex --local`
# prints, plus hooks.json with the example deny-rm PreToolUse hook trusted the
# way Codex records trust ([hooks.state] trusted_hash). Then asks Codex
# (codex exec) to use the run tool to write a.txt, read it back and run
# `rm a.txt` with bash.
# Pass: write and read allowed, rm denied by the hook, a.txt still exists.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
work=${1:?usage: test/e2e/codex.sh <empty work dir> [model]}
model=${2:-gpt-6-luna}
mkdir -p "$work"
work=$(cd "$work" && pwd)
project="$work/project"
home="$work/codex-home"
log="$work/run-log.jsonl"
rm -rf "$project" "$home" "$log"
mkdir -p "$project" "$home"

real_home=${CODEX_HOME:-$HOME/.codex}
[ -f "$real_home/auth.json" ] || { echo "no $real_home/auth.json: log in to codex first" >&2; exit 2; }
ln -s "$real_home/auth.json" "$home/auth.json"

(cd "$repo" && npm run build >/dev/null)
cli="$repo/dist/cli.js"
cp "$repo/test/e2e/deny-rm.sh" "$home/deny-rm.sh"

CODEX_HOME="$home" node "$cli" install --host codex --scope user --local --write >"$work/install.txt"
hook_cmd="sh \"$home/deny-rm.sh\""
node - "$home" "$hook_cmd" "$log" "$model" "$repo" <<'JS'
const fs = require('node:fs');
const [home, command, log, model, repo] = process.argv.slice(2);
const hooksFile = `${home}/hooks.json`;
fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 30 }] }] } }, null, 2) + '\n');
import(`${repo}/dist/hosts/codex/hooks.js`).then(({ commandHookHash }) => {
  const hash = commandHookHash({ matcher: 'Bash', command, timeoutSec: 30, async: false });
  const configFile = `${home}/config.toml`;
  const installed = fs.readFileSync(configFile, 'utf8');
  const head = [`model = ${JSON.stringify(model)}`, 'model_reasoning_effort = "low"', 'approval_policy = "never"', 'sandbox_mode = "workspace-write"', '', '[features]', 'hooks = true', ''].join('\n');
  const tail = [`[mcp_servers.agent-code-mode.env]`, `AGENT_CODE_MODE_LOG = ${JSON.stringify(log)}`, '', `[hooks.state."${hooksFile}:pre_tool_use:0:0"]`, `trusted_hash = "${hash}"`, ''].join('\n');
  fs.writeFileSync(configFile, `${head}\n${installed}\n${tail}`);
});
JS

prompt='Use the agent-code-mode run tool exactly once, with one JavaScript script that: (1) writes the file a.txt with the content "hello\n"; (2) reads a.txt back; (3) runs the shell command "rm a.txt" with the bash binding, catching any error. Return each step result or error message, then report each result in one short line per step. Do not run any other command.'

status=0
CODEX_HOME="$home" codex exec --json -C "$project" --skip-git-repo-check "$prompt" </dev/null >"$work/transcript.jsonl" 2>"$work/stderr.txt" || status=$?
echo "codex exec exit status: $status"
[ "$status" -eq 0 ] || { echo "FAIL: codex exec failed, see $work/stderr.txt"; exit 1; }

echo "transcript: $work/transcript.jsonl"
echo "server log: $log"
[ -f "$log" ] || { echo "FAIL: the run tool was never called"; exit 1; }
node - "$log" "$project/a.txt" <<'JS'
const fs = require('node:fs');
const [log, file] = process.argv.slice(2);
const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.event === 'run');
for (const r of runs) {
  console.log(`run: host=${r.host} cwd source=${r.sources.cwd}`);
  for (const c of r.calls) console.log(`  ${c.id} ${c.summary} -> ${c.decision}${c.reason ? `: ${c.reason}` : ''}`);
}
// All three calls must come from one run: write and read allowed, rm denied by the hook.
const passed = runs.some((r) => {
  const write = r.calls.find((c) => c.summary.startsWith('write a.txt'));
  const read = r.calls.find((c) => c.summary.startsWith('read a.txt'));
  const rm = r.calls.find((c) => /^bash .*rm a\.txt/.test(c.summary));
  return write?.decision === 'allowed' && read?.decision === 'allowed' && rm?.decision === 'denied' && /^hook:/.test(rm.reason ?? '');
});
const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const ok = passed && content !== null && content.trim() === 'hello';
console.log(`a.txt exists: ${content !== null}, content: ${JSON.stringify(content)}`);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
JS
