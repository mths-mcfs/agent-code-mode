import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'protect-file.mjs');

function call(input: unknown): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, 'src/handlers/reports.js'], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

describe('protect-file hook', () => {
  it('blocks writes to the protected file from either host', () => {
    expect(call({ tool_name: 'Edit', tool_input: { file_path: '/w/src/handlers/reports.js' } }).status).toBe(2);
    expect(call({ tool_name: 'Write', tool_input: { file_path: 'src\\handlers\\reports.js' } }).status).toBe(2);
    expect(call({ tool_name: 'Bash', tool_input: { command: "cd src/handlers && sed -i 's/3000/5000/' reports.js" } }).status).toBe(2);
    const patch = call({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/handlers/reports.js\n' } });
    expect(patch.status).toBe(2);
    expect(patch.stderr).toContain('protected');
  });

  it('allows other files and fails closed on bad input', () => {
    expect(call({ tool_name: 'Edit', tool_input: { file_path: 'src/handlers/orders.js' } }).status).toBe(0);
    expect(call({ tool_name: 'Bash', tool_input: { command: 'cat old-reports.json' } }).status).toBe(0);
    const bad = spawnSync(process.execPath, [HOOK, 'x.js'], { input: 'not json', encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});
