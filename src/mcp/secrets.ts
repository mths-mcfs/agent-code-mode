/** Values of a server's config that may be credentials, and their removal from what this server returns or logs. */

const SECRET_NAME = /(token|key|secret|passw|auth|credential|bearer|cookie|session)/i;
/** Below this, a value under a plain name is ordinary output (`1`, `json`, a port), not a credential. */
const MIN_PLAIN_SECRET_CHARS = 8;
export const REDACTED = '<redacted>';

/** A value `${VAR}` expansion put into the config, with the variable it came from. */
export interface ExpandedValue {
  readonly name: string;
  readonly value: string;
}

/**
 * Values to redact: every value of an env key, flag or expanded variable
 * whose name looks like a credential (`API_TOKEN`, `--api-key x`,
 * `${API_TOKEN}`), whatever its length; and the other config env values and
 * expanded values of at least 8 characters.
 */
export function configSecrets(env: Readonly<Record<string, string>>, args: readonly string[], expanded: readonly ExpandedValue[] = []): string[] {
  const named: string[] = [];
  const plain: string[] = [];
  for (const { name, value } of expanded) (SECRET_NAME.test(name) ? named : plain).push(value);
  for (const [key, value] of Object.entries(env)) (SECRET_NAME.test(key) ? named : plain).push(value);
  args.forEach((arg, i) => {
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq !== -1 && SECRET_NAME.test(arg.slice(0, eq))) named.push(arg.slice(eq + 1));
    else if (arg.startsWith('-') && SECRET_NAME.test(arg) && args[i + 1] !== undefined) named.push(args[i + 1] ?? '');
  });
  const all = [...named.filter((s) => s !== ''), ...plain.filter((s) => s.length >= MIN_PLAIN_SECRET_CHARS)];
  return [...new Set(all)].sort((a, b) => b.length - a.length);
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
