/** Runs `fn` with stdout captured; returns its value and what it wrote. */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await fn(), text: writes.join('') };
  } finally {
    process.stdout.write = orig;
  }
}
