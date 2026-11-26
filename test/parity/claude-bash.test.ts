import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  HOST_MODEL,
  HostHeaderSchema,
  HostRowSchema,
  SETUPS,
  adapterVerdicts,
  claudeVersion,
  hostRun,
  looser,
  matrix,
  removeWorld,
  scrub,
  type HostHeader,
  type HostRow,
  type Row,
} from './claude-bash.ts';

const DIR = import.meta.dirname;
const FIXTURE = path.join(DIR, 'claude-bash.host.jsonl');
const RECORD = process.env['ACM_PARITY_RECORD'] === '1';
const ONLY = process.env['ACM_PARITY_SETUPS']?.split(',').filter((s) => s !== '');
const MAX_USD = Number(process.env['ACM_PARITY_MAX_USD'] ?? '2');

function readFixture(): { header: HostHeader | undefined; rows: HostRow[] } {
  let text: string;
  try {
    text = readFileSync(FIXTURE, 'utf8');
  } catch {
    return { header: undefined, rows: [] };
  }
  const [first, ...rest] = text.trim().split('\n');
  return { header: HostHeaderSchema.parse(JSON.parse(first ?? '')), rows: rest.map((l) => HostRowSchema.parse(JSON.parse(l))) };
}

function writeFixture(header: HostHeader, rows: readonly HostRow[]): void {
  const order = (r: HostRow): number => SETUPS.findIndex((s) => s.id === r.setup) * COMMANDS.length + COMMANDS.indexOf(r.command);
  const sorted = [...rows].sort((a, b) => order(a) - order(b));
  writeFileSync(FIXTURE, `${[header, ...sorted].map((v) => JSON.stringify(v)).join('\n')}\n`);
}

/** Runs the setups through the installed Claude Code and merges their rows into the fixture. */
async function record(): Promise<void> {
  const version = claudeVersion();
  const old = readFixture();
  if (old.header !== undefined && old.header.claudeCode !== version) throw new Error(`the fixture was recorded on ${old.header.claudeCode}, this is ${version}: record every setup again from an empty fixture`);
  const setups = SETUPS.filter((s) => ONLY === undefined || ONLY.includes(s.id));
  let cost = old.header?.costUsd ?? 0;
  const rows = old.rows.filter((r) => !setups.some((s) => s.id === r.setup));
  for (const setup of setups) {
    let pending = [...COMMANDS];
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
      if (cost >= MAX_USD) throw new Error(`stopped before ${setup.id}: US$${cost.toFixed(4)} spent, the cap is US$${MAX_USD}`);
      const { parsed, world } = await hostRun(setup, pending, pending.length * 2 + 4);
      try {
        cost += parsed.costUsd;
        const missing: string[] = [];
        for (const [i, command] of pending.entries()) {
          const got = parsed.rows[i];
          if (got === undefined) missing.push(command);
          else rows.push({ setup: setup.id, command, host: got.verdict, ...(got.message === undefined ? {} : { message: scrub(got.message, world).slice(0, 300) }) });
        }
        process.stdout.write(`${setup.id} attempt ${attempt + 1}: ${pending.length - missing.length}/${pending.length} recorded, US$${parsed.costUsd.toFixed(4)} (total US$${cost.toFixed(4)})\n`);
        pending = missing;
      } finally {
        await removeWorld(world);
      }
    }
    if (pending.length > 0) throw new Error(`${setup.id}: the model never ran ${JSON.stringify(pending)} as written`);
    writeFixture({ claudeCode: version, model: HOST_MODEL, platform: process.platform, recorded: new Date().toISOString().slice(0, 10), costUsd: Number(cost.toFixed(4)) }, rows);
  }
}

describe.skipIf(process.platform === 'win32')('Claude bash parity with the installed Claude Code', () => {
  it('records the host when ACM_PARITY_RECORD=1', { timeout: 3 * 60 * 60_000 }, async () => {
    if (RECORD) await record();
  });

  it('the fixture covers every setup and command, recorded once', () => {
    const { header, rows } = readFixture();
    expect(header?.model).toBe(HOST_MODEL);
    const keys = rows.map((r) => `${r.setup}\t${r.command}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(SETUPS.flatMap((s) => COMMANDS.map((c) => `${s.id}\t${c}`)).sort());
  });

  it('the adapter is never looser than the host', { timeout: 120_000 }, async () => {
    const { header, rows: host } = readFixture();
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
    }
  });
});
