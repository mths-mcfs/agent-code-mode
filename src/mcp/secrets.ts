/** Values of a server's config that may be credentials, and their removal from what this server returns or logs. */

const SECRET_FLAG = /(token|key|secret|passw|auth|credential|bearer)/i;
const MIN_SECRET_CHARS = 4;
export const REDACTED = '<redacted>';

/**
 * The config-declared env values, the arguments `${VAR}` expansion produced,
 * and the value of every argument that a credential-like flag names
 * (`--token x`, `--api-key=x`).
 */
export function configSecrets(env: Readonly<Record<string, string>>, args: readonly string[], expandedArgs: readonly string[] = []): string[] {
  const out = [...Object.values(env), ...expandedArgs];
  args.forEach((arg, i) => {
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq !== -1 && SECRET_FLAG.test(arg.slice(0, eq))) out.push(arg.slice(eq + 1));
    else if (arg.startsWith('-') && SECRET_FLAG.test(arg) && args[i + 1] !== undefined) out.push(args[i + 1] ?? '');
  });
  return [...new Set(out.filter((s) => s.length >= MIN_SECRET_CHARS))].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/** `value` with every string in it redacted, keys included. */
export function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), redactDeep(v, secrets)]));
  return value;
}
