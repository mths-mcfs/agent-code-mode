#!/usr/bin/env node
// Example PreToolUse hook for the benchmark (task T8). The same rule for Claude Code and Codex CLI,
// native tools and agent-code-mode's inner calls alike.
// Usage in a hook command: node protect-file.mjs <relative/path/to/protected.js> [...more]
//
// Blocks (exit 2, reason on stderr):
// - any tool call whose input mentions a protected path or its file name (Write/Edit file paths,
//   Codex apply_patch text, Bash commands);
// - Bash commands that can write files and reach the protected file through a directory: they name
//   its directory or an ancestor as a whole (`src/handlers`, `Path('src/handlers').rglob(...)`, `src/*`,
//   `cd src/handlers && sed -i ... *.js`) rather than a specific other file in it. Read-only commands
//   on the directory (`ls src/handlers`, `rg TIMEOUT_MS src`) stay allowed.
// It is a text match, an example policy: a shell command that builds the path at run time from parts
// that never appear in its text can still get past it (the T8 verifier then fails the run).
import path from 'node:path';

const protectedPaths = process.argv.slice(2).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value.replace(/\\/g, '/'));
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(text, p) {
  const base = path.posix.basename(p);
  return text.includes(p) || new RegExp(`(^|[^A-Za-z0-9_.-])${esc(base)}($|[^A-Za-z0-9_.-])`).test(text);
}

/** Commands that can change files: in-place editors, redirections, copy/move/remove, inline scripts. */
const MUTATING = /(\bsed\s+(-[A-Za-z]*\s+)*-[A-Za-z]*i|\bperl\s+(-[A-Za-z]*\s+)*-[A-Za-z]*i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bxargs\b|\bpatch\b|\bgit\s+(apply|checkout|restore)\b|>|\b(python3?|node|ruby|perl|deno|bun)(\s+-[A-Za-z]+)*\s+(-|-c|-e|--eval)(?=\s|$)|<<|write_bytes|write_text|writeFile|open\s*\()/;

/** True when a shell command names a directory that contains `p` as a whole (or with a glob). */
function reachesThroughDirectory(command, p) {
  const parts = p.split('/');
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const dir = parts.slice(0, depth).join('/');
    const next = parts[depth];
    const re = new RegExp(`(^|[^A-Za-z0-9_.\\-/]|\\./)${esc(dir)}(?![A-Za-z0-9_.-])`, 'g');
    let m;
    while ((m = re.exec(command)) !== null) {
      const after = command.slice(m.index + m[0].length);
      const child = /^\/([A-Za-z0-9_.-]+)/.exec(after);
      if (child === null) return true; // the directory itself, or `dir/` followed by a glob, quote or space
      if (child[1] === next) continue; // a path toward the protected file: judged at the deeper level
      if (/^[*?[{]/.test(after.slice(child[0].length))) return true; // `dir/x*`
    }
  }
  return false;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write('protect-file: hook input is not JSON\n');
    process.exit(2);
  }
  const toolInput = input && typeof input === 'object' ? input.tool_input : undefined;
  const texts = strings(toolInput);
  const shell = input && typeof input === 'object' && input.tool_name === 'Bash';
  const command = shell && toolInput && typeof toolInput.command === 'string' ? toolInput.command.replace(/\\/g, '/') : '';
  for (const p of protectedPaths) {
    if (texts.some((t) => mentions(t, p)) || (shell && MUTATING.test(command) && reachesThroughDirectory(command, p))) {
      process.stderr.write(`${p} is protected by the repository policy; this change is denied.\n`);
      process.exit(2);
    }
  }
  process.exit(0);
});
