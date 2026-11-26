import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkScope, Checks, failedTests, readWorkspaceFile, runHiddenTests, runNodeTests } from '../checks.ts';
import { parseAst } from 'rolldown/parseAst';
import { filesFrom } from '../setup.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export const T10_FILES = path.join(import.meta.dirname, 'files');
const HIDDEN = Object.fromEntries(filesFrom(path.join(import.meta.dirname, 'hidden')));

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string' && 'start' in value && typeof value.start === 'number' && 'end' in value && typeof value.end === 'number';
}

function* nodes(value: unknown): Generator<AstNode> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
  } else if (isNode(value)) {
    yield value;
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') yield* nodes(child);
  }
}

/**
 * The arguments, as written, of each `formatPrice(...)` call in `source`, and of calls through an
 * `import { formatPrice as x }` alias. A real JavaScript parser finds them, so strings, comments,
 * regexes and template literals need no special case. Throws when `source` does not parse.
 */
export function formatPriceCalls(source: string): string[][] {
  const program = parseAst(source);
  const names = new Set(['formatPrice']);
  for (const node of nodes(program)) {
    const imported = node['imported'];
    const local = node['local'];
    if (node.type === 'ImportSpecifier' && isNode(imported) && imported['name'] === 'formatPrice' && isNode(local) && typeof local['name'] === 'string') names.add(local['name']);
  }
  const calls: { readonly at: number; readonly args: string[] }[] = [];
  for (const node of nodes(program)) {
    const callee = node['callee'];
    const args = node['arguments'];
    if (node.type !== 'CallExpression' || !isNode(callee) || callee.type !== 'Identifier' || !names.has(String(callee['name'])) || !Array.isArray(args)) continue;
    calls.push({ at: node.start, args: args.filter(isNode).map((arg) => source.slice(arg.start, arg.end)) });
  }
  return calls.sort((x, y) => x.at - y.at).map((c) => c.args);
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
    let calls: string[][];
    try {
      calls = formatPriceCalls((await readWorkspaceFile(ctx.workspace, file)) ?? '');
    } catch (err) {
      positional.push(`${file}: does not parse (${String(err instanceof Error ? err.message : err).split('\n')[0]})`);
      continue;
    }
    for (const args of calls) {
      const second = args[1];
      if (args.some((a) => a.startsWith('...')) || args.length > 2 || (second !== undefined && /^(['"`]|undefined$|null$|true$|false$|-?\d)/.test(second))) positional.push(`${file}: formatPrice(${args.join(', ')})`);
    }
  }
  checks.check(positional.length === 0, positional.length === 0 ? 'every formatPrice call in src/ uses the options form' : `positional formatPrice calls left: ${positional.join('; ')}`);
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => f.startsWith('src/'));
  return checks.result();
}
