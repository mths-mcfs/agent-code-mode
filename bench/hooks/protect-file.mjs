#!/usr/bin/env node
// Example PreToolUse hook for the benchmark (task T8). Works for Claude Code and Codex CLI.
// Usage in a hook command: node protect-file.mjs <relative/path/to/protected.js> [...more]
// Blocks (exit 2, reason on stderr) any tool call whose input mentions a protected path or its
// file name: Write/Edit file paths, Bash commands and Codex apply_patch text alike.
import path from 'node:path';

const protectedPaths = process.argv.slice(2).map((p) => p.replace(/\\/g, '/'));

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value.replace(/\\/g, '/'));
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
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
  const texts = strings(input && typeof input === 'object' ? input.tool_input : undefined);
  for (const p of protectedPaths) {
    const base = path.posix.basename(p);
    if (texts.some((t) => t.includes(p) || new RegExp(`(^|[^A-Za-z0-9_.-])${base.replace(/[.]/g, '\\.')}($|[^A-Za-z0-9_.-])`).test(t))) {
      process.stderr.write(`${p} is protected by the repository policy; this change is denied.\n`);
      process.exit(2);
    }
  }
  process.exit(0);
});
