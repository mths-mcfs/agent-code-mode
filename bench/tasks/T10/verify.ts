import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkScope, Checks, failedTests, readWorkspaceFile, runHiddenTests, runNodeTests } from '../checks.ts';
import { filesFrom } from '../setup.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export const T10_FILES = path.join(import.meta.dirname, 'files');
const HIDDEN = Object.fromEntries(filesFrom(path.join(import.meta.dirname, 'hidden')));

/**
 * `source` with the text of comments, strings and template literals blanked to spaces, the code inside
 * `${...}` kept. Same length, so an index into it is an index into `source`.
 */
function codeOnly(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let j = from; j < Math.min(to, out.length); j++) if (out[j] !== '\n') out[j] = ' ';
  };
  const templates: number[] = []; // brace depth outside each open `${`
  let depth = 0;
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const end = source[i + 1] === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 2;
      const stop = end < i + 2 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (ch === '`' || (ch === '}' && depth === 0 && templates.length > 0)) {
      if (ch === '}') depth = templates.pop() ?? 0;
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      if (source[j] === '$') {
        templates.push(depth);
        depth = 0;
        i = j + 2;
      } else i = j + 1;
    } else {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      i++;
    }
  }
  return out.join('');
}

/** The top-level arguments of each `formatPrice(...)` call in the code of `source` (strings and nesting respected). */
export function formatPriceCalls(source: string): string[][] {
  const calls: string[][] = [];
  const code = codeOnly(source);
  // `import { formatPrice as money }` makes `money(` a call of it too.
  const aliases = [...code.matchAll(/\bformatPrice\s+as\s+([A-Za-z_$][\w$]*)/g)].map((m) => (m[1] as string).replace(/\$/g, '\\$'));
  // An identifier may start with `$`, which `\b` does not see as part of a word.
  const re = new RegExp(`(?<![\\w$])(?:${['formatPrice', ...aliases].join('|')})\\s*\\(`, 'g');
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    // A declaration (`function formatPrice(`) is not a call.
    if (/(?:function|as)\s+$/.test(code.slice(0, m.index))) continue;
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
