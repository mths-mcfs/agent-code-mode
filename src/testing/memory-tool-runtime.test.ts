import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolicySnapshot, ReadResult, ToolRuntime } from '../core/types.js';
import { NodeToolRuntime } from '../tools/runtime.js';
import { makeContext } from './context.js';
import { MemoryToolRuntime } from './memory-tool-runtime.js';

const FILES: Record<string, string> = {
  'final.txt': 'a\nb\n',
  'nofinal.txt': 'a\nb\nc',
  'crlf.txt': 'a\r\nb\r\n',
  'empty.txt': '',
  'nl.txt': '\n',
  'blank.txt': 'a\n\n\n',
};
const POLICY: PolicySnapshot<null> = { host: 'generic', bashContainment: { mode: 'none' }, protectedPaths: [], payload: null };
const WINDOWS = [{}, { offset: 1, limit: 2 }, { offset: 2, limit: 1 }, { offset: 2 }, { offset: 3, limit: 5 }, { offset: 9 }];

async function readWith(tools: ToolRuntime<null>, root: string, file: string, window: { offset?: number; limit?: number }): Promise<ReadResult> {
  const prepared = await tools.prepare({ id: 'c1', tool: 'read', args: { path: file, ...window } }, makeContext(root), POLICY);
  const result = await tools.commit(prepared, new AbortController().signal);
  if (!('totalLines' in result)) throw new Error('not a read result');
  // The runtimes report real paths (the tmpdir is a symlink on macOS, a short 8.3 name on Windows); D5 is about line accounting, so compare the file name only.
  return { ...result, path: path.basename(result.path) };
}

describe('MemoryToolRuntime.read', () => {
  it('D5: counts lines, cuts windows and keeps the exact text like NodeToolRuntime', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acm-mem-'));
    try {
      for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(dir, name), text);
      const node = new NodeToolRuntime({ stateDir: path.join(dir, '.state') });
      const memory = new MemoryToolRuntime({ root: '/ws', files: FILES });
      for (const name of Object.keys(FILES)) {
        for (const window of WINDOWS) {
          expect({ name, window, ...(await readWith(memory, '/ws', name, window)) }).toEqual({ name, window, ...(await readWith(node, dir, name, window)) });
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
