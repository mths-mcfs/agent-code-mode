// A host failure's text reaches record.json only through the sanitizer.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { main } from '../run.ts';
import { quiet } from './quiet.ts';

const LEAK = `${os.homedir()}/secret-project session 12345678-1234-4123-8123-123456789012`;

vi.mock('../lib/claude.ts', async (original) => ({
  ...(await original<typeof import('../lib/claude.ts')>()),
  parseClaudeTranscript: () => {
    throw new Error(`unexpected event in ${LEAK}`);
  },
}));

it('sanitizes the parse error and invalid reasons it records', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'acm-record-'));
  try {
    const out = path.join(work, 'results');
    const r = await quiet(() => main(['--dry-run', '--host', 'claude', '--arms', 'A', '--tasks', 'T1', '--runs', '1', '--seed', '1', '--work-dir', work, '--out', out, '--date', '2026-01-05']));
    expect(r.value).toBe(1);
    const file = (await readdir(out, { recursive: true })).find((f) => f.endsWith('record.json'));
    const text = await readFile(path.join(out, file ?? ''), 'utf8');
    expect(text).toContain('~/secret-project session 00000000-0000-4000-8000-000000000001');
    expect(text).not.toContain(os.homedir());
    expect(text).not.toContain('12345678-1234-4123-8123-123456789012');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
