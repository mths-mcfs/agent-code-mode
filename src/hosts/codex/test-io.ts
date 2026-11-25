import path from 'node:path';
import type { ConfigIo } from './config.js';

export function memoryIo(opts: {
  /** Paths that are symbolic links (to what the other options say they are). */
  links?: string[];
  /** Size reported for a file instead of its byte length. */
  sizes?: Record<string, number>;
  /** Paths whose canonicalization fails. */
  uncanonical?: string[];
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
    canonical: (p) => (opts.uncanonical?.includes(p) ? undefined : p),
    entry: (p) => {
      const isFile = files.has(p);
      if (!isFile && !dirs.has(p)) return undefined;
      const size = opts.sizes?.[p] ?? (isFile ? Buffer.byteLength(files.get(p) ?? '', 'utf8') : 0);
      return { isFile, isDirectory: !isFile, isSymlink: opts.links?.includes(p) ?? false, size };
    },
    listFiles: (d) => [...files.keys()].filter((p) => path.posix.dirname(p) === d).map((p) => path.posix.basename(p)),
    parentArgv: () => opts.argv,
  };
}
