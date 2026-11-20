import path from 'node:path';
import type { ConfigIo } from './config.js';

/**
 * In-memory `ConfigIo` for tests: files keyed by absolute POSIX path.
 * Directories are implied by file paths plus `dirs`.
 */
export function memoryIo(opts: {
  files?: Record<string, string>;
  dirs?: string[];
  home?: string;
  env?: Record<string, string | undefined>;
  argv?: string[] | undefined;
  platform?: NodeJS.Platform;
  systemDir?: string;
}): ConfigIo {
  const files = new Map(Object.entries(opts.files ?? {}));
  const dirs = new Set<string>(opts.dirs ?? []);
  for (const f of files.keys()) {
    let d = path.posix.dirname(f);
    while (!dirs.has(d)) {
      dirs.add(d);
      const parent = path.posix.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }
  return {
    env: opts.env ?? {},
    home: opts.home ?? '/home/u',
    platform: opts.platform ?? 'linux',
    systemDir: opts.systemDir ?? '/etc/codex',
    readFile: (f) => files.get(f),
    isDir: (d) => dirs.has(d),
    exists: (p) => files.has(p) || dirs.has(p),
    realpath: (p) => p,
    listDir: (d) => {
      const out = new Set<string>();
      for (const p of [...files.keys(), ...dirs]) {
        if (path.posix.dirname(p) === d) out.add(path.posix.basename(p));
      }
      return [...out];
    },
    listFiles: (d) => [...files.keys()].filter((p) => path.posix.dirname(p) === d).map((p) => path.posix.basename(p)),
    parentArgv: () => opts.argv,
  };
}
