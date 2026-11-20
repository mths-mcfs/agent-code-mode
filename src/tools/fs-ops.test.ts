import { describe, expect, it } from 'vitest';
import { readRegularFile, syncDirStrict } from './fs-ops.js';

const failWith = (code: string) => async (): Promise<void> => {
  throw Object.assign(new Error(`${code}: directory fsync`), { code });
};

describe.skipIf(process.platform === 'win32')('syncDirStrict', () => {
  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])('treats %s as a file system without directory fsync', async (code) => {
    await expect(syncDirStrict('/any', failWith(code))).resolves.toBeUndefined();
  });

  it.each(['EIO', 'ENOSPC'])('rethrows %s', async (code) => {
    await expect(syncDirStrict('/any', failWith(code))).rejects.toMatchObject({ code });
  });

  it('flushes a real directory', async () => {
    await expect(syncDirStrict(process.cwd())).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'linux')('readRegularFile', () => {
  it('stops at the byte limit even when the file is larger than its reported size', async () => {
    // A /proc file reports size 0 and holds more.
    await expect(readRegularFile(`/proc/${process.pid}/status`, 16)).rejects.toThrow(/more than the 16-byte limit/);
  });
});
