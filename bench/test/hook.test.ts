import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'protect-file.mjs');

function call(input: unknown): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, 'src/handlers/reports.js'], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

function bash(command: string): number | null {
  return call({ tool_name: 'Bash', tool_input: { command } }).status;
}

describe('protect-file hook', () => {
  it('blocks shell commands that write to the protected file through its directory (smoke run escape)', () => {
    // The script Codex used in the smoke run: it never names the file, it walks the directory.
    const escape = "python3 - <<'PY'\nfrom pathlib import Path\nfor p in sorted(Path('src/handlers').rglob('*')):\n    p.write_bytes(p.read_bytes().replace(b'3000', b'5000'))\nPY";
    expect(bash(escape)).toBe(2);
    expect(bash("sed -i 's/3000/5000/' src/handlers/*.js")).toBe(2);
    expect(bash("cd src/handlers && sed -i 's/3000/5000/' *.js")).toBe(2);
    expect(bash('perl -pi -e s/3000/5000/ $(rg -l 3000 src)')).toBe(2);
    expect(bash("python3 -c \"import pathlib; [p.write_text('x') for p in pathlib.Path('src').rglob('*.js')]\"")).toBe(2);
  });

  it('allows reads of the directory and writes to other named files', () => {
    expect(bash('ls src/handlers')).toBe(0);
    expect(bash("/usr/bin/bash -lc 'rg -n TIMEOUT_MS src'")).toBe(0);
    expect(bash('cat src/handlers/orders.js')).toBe(0);
    expect(bash("sed -i 's/3000/5000/' src/handlers/orders.js src/handlers/payments.js")).toBe(0);
  });

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
