import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkScope, Checks, readWorkspaceFile, runNodeTests } from '../checks.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

async function listJs(workspace: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(workspace, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listJs(workspace, rel)));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const { renameFrom, renameTo, renameFiles } = ctx.facts;
  const old = new RegExp(`\\b${renameFrom}\\b`);
  const files = [...(await listJs(ctx.workspace, 'src')), ...(await listJs(ctx.workspace, 'test'))];
  const leftovers: string[] = [];
  for (const f of files) if (old.test((await readWorkspaceFile(ctx.workspace, f)) ?? '')) leftovers.push(f);
  checks.check(leftovers.length === 0, leftovers.length === 0 ? `no ${renameFrom} left in src/ or test/` : `${renameFrom} still in: ${leftovers.join(', ')}`);
  const missing: string[] = [];
  for (const f of renameFiles) if (!new RegExp(`\\b${renameTo}\\b`).test((await readWorkspaceFile(ctx.workspace, f)) ?? '')) missing.push(f);
  checks.check(missing.length === 0, missing.length === 0 ? `${renameTo} used in all ${renameFiles.length} files` : `${renameTo} missing in: ${missing.join(', ')}`);
  const money = (await readWorkspaceFile(ctx.workspace, 'src/lib/money.js')) ?? '';
  checks.check(new RegExp(`export function ${renameTo}\\(`).test(money), `src/lib/money.js exports ${renameTo}`);
  const tests = await runNodeTests(ctx.workspace);
  checks.check(tests.ok && tests.fail === 0, `node --test passes (pass ${tests.pass}, fail ${tests.fail})`);
  const targets = new Set(renameFiles);
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => targets.has(f));
  return checks.result();
}
