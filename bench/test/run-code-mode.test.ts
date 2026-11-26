import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunRecordSchema, type RunRecord } from '../lib/record.ts';
import { tmuxVersion } from '../lib/tmux.ts';
import { main } from '../run.ts';
import { quiet } from './quiet.ts';

// A real (not dry) arm D run through main(), with a stand-in `claude` on PATH that opens the fake interactive
// host in the driver's tmux: the run's own config dir, seeded .claude.json, transcript lookup and record.
describe.skipIf(tmuxVersion() === null)('arm D through main()', () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'acm-armd-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(work, { recursive: true, force: true });
  });

  async function runWith(mode: string, extra: string[]): Promise<{ value: number; records: RunRecord[]; errors: string }> {
    const bin = path.join(work, 'bin');
    const config = path.join(work, 'claude-config');
    await mkdir(bin);
    await mkdir(config);
    await writeFile(path.join(config, '.credentials.json'), '{}');
    const host = path.join(import.meta.dirname, 'fake-interactive-host.mjs');
    const fixture = path.join(import.meta.dirname, '..', 'parser-fixtures', 'claude-D.jsonl');
    writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.326 (Claude Code)'); process.exit(0); }
const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'ws', args[args.indexOf('--session-id') + 1] + '.jsonl');
process.exit(spawnSync(process.execPath, [${JSON.stringify(host)}, transcript, ${JSON.stringify(fixture)}, ${JSON.stringify(mode)}], { stdio: 'inherit' }).status ?? 1);
`);
    chmodSync(path.join(bin, 'claude'), 0o755);
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    const out = path.join(work, 'results');
    const r = await quiet(() => main(['--host', 'claude', '--arms', 'D', '--tasks', 'T2', '--runs', '1', '--seed', '1', '--claude-model', 'claude-opus-5-5', '--work-dir', work, '--out', out, '--date', '2026-01-07', ...extra]));
    const files = (await readdir(out, { recursive: true })).filter((f) => f.endsWith('record.json') && !f.includes('warmup'));
    const records = await Promise.all(files.map(async (f) => RunRecordSchema.parse(JSON.parse(await readFile(path.join(out, f), 'utf8')))));
    return { value: r.value, records, errors: r.errors };
  }

  it('records a valid run priced from the transcript, with the session cost apart and nothing private', async () => {
    const { records } = await runWith('finish', []);
    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r?.invalidReasons).toEqual([]);
    expect(r?.valid).toBe(true);
    // The stand-in host edits nothing, so T2's check fails: the run is valid and unsolved.
    expect(r?.verify.pass).toBe(false);
    expect(r?.costSource).toBe('pricing.json');
    expect(r?.costUsd).toBeCloseTo(0.0533492, 9);
    expect(r?.hostSessionCostUsd).toBeCloseTo(0.0603898, 9);
    expect(r?.parsed?.innerCalls).toEqual({ total: 5, byTool: { Bash: 2, Read: 2, Edit: 1 } });
    const dir = path.join(work, 'results', '2026-01-07', 'claude', 'T2', 'D', r?.configHash ?? '', '1');
    const kept = (await readdir(dir)).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(kept).not.toContain(work);
    expect(kept).not.toContain(os.homedir());
    expect(kept).toMatch(/Code Mode \(experimental\) is on/);
  }, 120_000);

  it('counts a session that never gets ready as timed out, not as a host exit', async () => {
    const { records } = await runWith('never-ready', ['--timeout-min', '0.03']);
    const [r] = records;
    expect(r?.valid).toBe(false);
    expect(r?.timedOut).toBe(true);
    expect(r?.invalidReasons).toContain('timed out after 0.03 min');
    expect(r?.invalidReasons.join('\n')).not.toMatch(/host exited|did not exit/);
  }, 120_000);

  it('reports a dialog the seeded config missed as the reason, not the exit status of the host it killed', async () => {
    const { records } = await runWith('dialog', []);
    const [r] = records;
    expect(r?.valid).toBe(false);
    expect(r?.timedOut).toBe(false);
    expect(r?.invalidReasons).toContain('unexpected dialog before the prompt: Quick safety check: Is this a project you created or one you trust?');
    expect(r?.invalidReasons.join('\n')).not.toMatch(/host exited|did not exit/);
  }, 120_000);
});
