import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkScope, Checks, failedTests, readWorkspaceFile, runHiddenTests, runNodeTests } from '../checks.ts';
import { filesFrom } from '../setup.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export const T10_FILES = path.join(import.meta.dirname, 'files');
const HIDDEN = Object.fromEntries(filesFrom(path.join(import.meta.dirname, 'hidden')));

/** The top-level arguments of each `formatPrice(...)` call in `source` (strings and nesting respected). */
export function formatPriceCalls(source: string): string[][] {
  const calls: string[][] = [];
  // `import { formatPrice as money }` makes `money(` a call of it too.
  const aliases = [...source.matchAll(/\bformatPrice\s+as\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string);
  const re = new RegExp(`\\b(?:${['formatPrice', ...aliases].join('|')})\\s*\\(`, 'g');
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    // A declaration (`function formatPrice(`) is not a call.
    if (/(?:function|as)\s+$/.test(source.slice(0, m.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let cur = '';
    for (let i = m.index + m[0].length; i < source.length; i++) {
      const ch = source[i] as string;
      if (quote !== null) {
        cur += ch;
        if (ch === '\\') {
          cur += source[i + 1] ?? '';
          i++;
        } else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) {
          if (cur.trim() !== '') args.push(cur.trim());
          break;
        }
        depth--;
      }
      if (ch === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    calls.push(args);
  }
  return calls;
}

async function listJs(workspace: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(workspace, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listJs(workspace, rel)));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const visible = await runNodeTests(ctx.workspace);
  checks.check(visible.ok && visible.fail === 0, `node --test passes (pass ${visible.pass}, fail ${visible.fail})`);
  const hidden = await runHiddenTests(ctx.workspace, HIDDEN);
  checks.check(hidden.ok && hidden.fail === 0 && hidden.pass > 0, `hidden tests pass (pass ${hidden.pass}, fail ${hidden.fail}${hidden.fail > 0 ? `: ${failedTests(hidden.output).join('; ')}` : ''})`);
  // Callers inside the repo use the new form. A variable second argument may hold options (the hidden
  // tests judge its behavior); a third argument, a spread or a literal currency/undefined is the old form.
  const positional: string[] = [];
  for (const file of await listJs(ctx.workspace, 'src')) {
    if (file === 'src/index.js') continue;
    for (const args of formatPriceCalls((await readWorkspaceFile(ctx.workspace, file)) ?? '')) {
      const second = args[1];
      if (args.some((a) => a.startsWith('...')) || args.length > 2 || (second !== undefined && /^(['"`]|undefined$|null$|true$|false$|-?\d)/.test(second))) positional.push(`${file}: formatPrice(${args.join(', ')})`);
    }
  }
  checks.check(positional.length === 0, positional.length === 0 ? 'every formatPrice call in src/ uses the options form' : `positional formatPrice calls left: ${positional.join('; ')}`);
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => f.startsWith('src/'));
  return checks.result();
}
