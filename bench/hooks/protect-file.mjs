#!/usr/bin/env node
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

const MUTATING = /(\bsed\s+(-[A-Za-z]*\s+)*-[A-Za-z]*i|\bperl\s+(-[A-Za-z]*\s+)*-[A-Za-z]*i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bxargs\b|\bpatch\b|\bgit\s+(apply|checkout|restore)\b|>|\b(python3?|node|ruby|perl|deno|bun)(\s+-[A-Za-z]+)*\s+(-|-c|-e|--eval)(?=\s|$)|<<|write_bytes|write_text|writeFile|open\s*\()/;

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
      if (child === null) return true;
      if (child[1] === next) continue;
      if (/^[*?[{]/.test(after.slice(child[0].length))) return true;
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
