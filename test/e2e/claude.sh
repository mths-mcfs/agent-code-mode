#!/usr/bin/env bash
# End-to-end check on a real Claude Code (needs a logged-in `claude`; not run in CI).
#
#   test/e2e/claude.sh <empty work dir> [extra claude flags...]
#
# Builds the package, creates a project in <work dir> configured with
# `agent-code-mode install --host claude --scope project --local --write` plus
# the example deny-rm PreToolUse hook and Claude's sandbox (bash inside run runs
# only contained or by an exact allow rule, and only then reaches the hook),
# then asks Claude (claude -p) to use the run tool to write a.txt, read it back
# and run `rm a.txt` with bash.
# Pass: write and read allowed, rm denied by the hook, a.txt still exists.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
work=${1:?usage: test/e2e/claude.sh <empty work dir> [extra claude flags...]}
shift
mkdir -p "$work"
work=$(cd "$work" && pwd)
project="$work/project"
log="$work/run-log.jsonl"
rm -rf "$project" "$log"
mkdir -p "$project/.claude"

(cd "$repo" && npm run build >/dev/null)
cli="$repo/dist/cli.js"

cp "$repo/test/e2e/deny-rm.sh" "$project/.claude/deny-rm.sh"
(cd "$project" && node "$cli" install --host claude --scope project --local --write >"$work/install.txt")

node - "$project" "$log" <<'JS'
const fs = require('node:fs');
const [project, log] = process.argv.slice(2);
const settingsFile = `${project}/.claude/settings.json`;
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `sh "${project}/.claude/deny-rm.sh"` }] });
settings.sandbox = { enabled: true };
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
const mcpFile = `${project}/.mcp.json`;
const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
mcp.mcpServers['agent-code-mode'].env = { AGENT_CODE_MODE_LOG: log };
fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n');
JS

prompt='Use the mcp__agent-code-mode__run tool exactly once, with one script that: (1) writes the file a.txt with the content "hello"; (2) reads a.txt back; (3) runs the shell command "rm a.txt" with bash, catching any error. Return each step result or error message. Then report each result in one short line per step. Do not use any other tool.'

cd "$project"
claude -p --model claude-haiku-5-5 --setting-sources project --strict-mcp-config --mcp-config "$project/.mcp.json" \
  --tools "" --allowedTools mcp__agent-code-mode__run Write \
  --output-format stream-json --verbose "$@" "$prompt" >"$work/transcript.jsonl"

echo "transcript: $work/transcript.jsonl"
echo "server log: $log"
node - "$log" "$project/a.txt" <<'JS'
const fs = require('node:fs');
const [log, file] = process.argv.slice(2);
const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.event === 'run');
for (const r of runs) {
  console.log(`run: host=${r.host} permissionMode=${r.permissionMode} (source ${r.sources.permissionMode})`);
  for (const c of r.calls) console.log(`  ${c.id} ${c.summary} -> ${c.decision}${c.reason ? `: ${c.reason}` : ''}`);
}
const calls = runs.flatMap((r) => r.calls);
const write = calls.find((c) => c.summary.startsWith('write a.txt'));
const read = calls.find((c) => c.summary.startsWith('read a.txt'));
const rm = calls.find((c) => /^bash .*rm a\.txt/.test(c.summary));
const ok = write?.decision === 'allowed' && read?.decision === 'allowed' && rm?.decision === 'denied' && /^hook:/.test(rm.reason ?? '') && fs.existsSync(file);
console.log(`a.txt exists: ${fs.existsSync(file)}`);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
JS
