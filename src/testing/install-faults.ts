import nodeFs from 'node:fs';
import path from 'node:path';
import type { VitestUtils } from 'vitest';

/** Rooted operations name an entry through a directory anchor, so faults match on the entry's name. */
const entryName = (file: unknown): string => path.basename(String(file));
const isTemp = (file: unknown): boolean => /^\.acm-[0-9a-f]+\.tmp$/.test(entryName(file));

/** Sets the mtime of each temp file a write creates to `time` (seconds) right before it is fsynced. */
export function pinTempMtime(vi: VitestUtils, time: number): void {
  const temps = new Set<number>();
  const openSync = nodeFs.openSync;
  vi.spyOn(nodeFs, 'openSync').mockImplementation((file, flags, mode) => {
    const fd = openSync(file, flags, mode);
    if (isTemp(file)) temps.add(fd);
    return fd;
  });
  const fsync = nodeFs.fsync;
  vi.spyOn(nodeFs, 'fsync').mockImplementation((fd, callback) => {
    if (temps.delete(fd)) nodeFs.futimesSync(fd, time, time);
    fsync(fd, callback);
  });
}

/**
 * Stops the process, as far as the file system can tell, right before the
 * temp file is renamed over `target`: the rename throws `message` and the
 * temp file is not cleaned up. `onCut` sees the temp file's absolute path
 * while the cut happens; `temp()` returns it afterwards.
 */
export function cutBeforeRename(vi: VitestUtils, target: string, message: string, onCut?: (temp: string) => void): { readonly temp: () => string } {
  let temp = '';
  const renameSync = nodeFs.renameSync;
  vi.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
    if (entryName(to) !== entryName(target) || !isTemp(from)) return renameSync(from, to);
    temp = path.join(path.dirname(target), entryName(from));
    onCut?.(temp);
    throw new Error(message);
  });
  const rmSync = nodeFs.rmSync;
  vi.spyOn(nodeFs, 'rmSync').mockImplementation((file, options) => {
    if (temp === '' || entryName(file) !== entryName(temp)) rmSync(file, options);
  });
  return { temp: () => temp };
}
