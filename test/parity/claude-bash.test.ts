import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  HOST_MODEL,
  SETUPS,
  adapterVerdicts,
  claudeVersion,
  looser,
  makeWorld,
  matrix,
  readFixture,
  recordHost,
  scrub,
  type HostRunner,
  type Row,
} from './claude-bash.ts';

const DIR = import.meta.dirname;
const FIXTURE = path.join(DIR, 'claude-bash.host.jsonl');
const RECORD = process.env['ACM_PARITY_RECORD'] === '1';
const ONLY = process.env['ACM_PARITY_SETUPS']?.split(',').filter((s) => s !== '');
const MAX_USD = Number(process.env['ACM_PARITY_MAX_USD'] ?? '2');

describe.skipIf(process.platform === 'win32')('Claude bash parity with the installed Claude Code', () => {
  it('records the host when ACM_PARITY_RECORD=1', { timeout: 3 * 60 * 60_000 }, async () => {
    if (RECORD) await recordHost({ file: FIXTURE, setups: SETUPS.filter((s) => ONLY === undefined || ONLY.includes(s.id)), maxUsd: MAX_USD, version: claudeVersion() });
  });

  it('the fixture covers every setup and command, recorded once', () => {
    const { header, rows } = readFixture(FIXTURE);
    expect(header?.model).toBe(HOST_MODEL);
    const keys = rows.map((r) => `${r.setup}\t${r.command}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(SETUPS.flatMap((s) => COMMANDS.map((c) => `${s.id}\t${c}`)).sort());
  });

  it('the adapter is never looser than the host', { timeout: 120_000 }, async () => {
    const { header, rows: host } = readFixture(FIXTURE);
    const rows: Row[] = [];
    for (const setup of SETUPS) {
      const verdicts = await adapterVerdicts(setup);
      for (const [i, command] of COMMANDS.entries()) {
        const recorded = host.find((r) => r.setup === setup.id && r.command === command);
        const adapter = verdicts[i];
        if (recorded !== undefined && adapter !== undefined) rows.push({ setup: setup.id, command, host: recorded.host, adapter });
      }
    }
    process.stdout.write(`Host: ${header?.claudeCode ?? 'none'} (${header?.model ?? ''}, ${header?.platform ?? ''}, ${header?.recorded ?? ''})\n${matrix(rows)}\n`);
    expect(rows.filter(looser).map((r) => `${r.setup}: ${r.command} (host ${r.host}, adapter ${r.adapter})`)).toEqual([]);
  });

  it('every committed fixture is already sanitized', () => {
    for (const name of readdirSync(DIR).filter((n) => n.endsWith('.jsonl'))) {
      const text = readFileSync(path.join(DIR, name), 'utf8');
      expect(scrub(text, undefined), name).toBe(text);
      // Host messages are free text: no machine path may survive outside the {project}, {outside} and {base} placeholders.
      expect(text.match(/\/(home|Users|tmp|var|private)\/[^\s"']*/g) ?? [], name).toEqual([]);
    }
  });

  it('an interrupted recording keeps what it spent, so the cap holds across runs', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'acm-parity-record-')), 'host.jsonl');
    const paid = `${JSON.stringify({ type: 'result', total_cost_usd: 0.5, permission_denials: [] })}\n`;
    let calls = 0;
    const run: HostRunner = async (setup) => {
      calls++;
      return { world: await makeWorld(setup), transcript: paid, failure: calls === 2 ? 'claude was killed' : undefined };
    };
    const setups = SETUPS.slice(0, 1);
    try {
      await expect(recordHost({ file, setups, maxUsd: 2, version: 'v', run, log: () => {} })).rejects.toThrow('claude was killed');
      expect(readFixture(file).header?.costUsd).toBe(1);
      await expect(recordHost({ file, setups, maxUsd: 1, version: 'v', run, log: () => {} })).rejects.toThrow('US$1.0000 spent, the cap is US$1');
      expect(calls).toBe(2);
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
