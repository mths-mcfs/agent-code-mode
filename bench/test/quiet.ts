/** Runs `fn` with stdout and stderr captured; returns its value and what it wrote to each. */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; text: string; errors: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const capture = (sink: string[]) => ((chunk: string | Uint8Array) => {
    sink.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = capture(out);
  process.stderr.write = capture(err);
  try {
    return { value: await fn(), text: out.join(''), errors: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}
