import os from 'node:os';

export interface SanitizeContext {
  readonly paths: readonly { readonly path: string; readonly label: string }[];
  readonly home: string;
  readonly username: string;
  readonly hostname: string;
}

export function defaultSanitizeContext(paths: SanitizeContext['paths']): SanitizeContext {
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env['USER'] ?? process.env['USERNAME'] ?? '';
  }
  return { paths, home: os.homedir(), username, hostname: os.hostname() };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Forms a path takes in transcripts: as is, with forward slashes (also inside file:// URLs),
 * JSON-escaped, and dash-encoded the way Claude Code names its per-project folders.
 */
function pathForms(p: string): string[] {
  const forms = new Set<string>([p, p.replace(/\\/g, '/'), JSON.stringify(p).slice(1, -1), p.replace(/[\\/.:]/g, '-')]);
  return [...forms].filter((f) => f.length > 1).sort((a, b) => b.length - a.length);
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '<token>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<token>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<token>'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '<token>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<token>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 <token>'],
  [/(\\*"(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|authorization|password|passwd|secret|client[_-]?secret|cookie|private[_-]?key)\\*"\s*:\s*(\\*)")(?:(?!\2").)*(\2")/gi, '$1<redacted>$3'],
  [/\b((?:[A-Z0-9]+_)*(?:API_?KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|AUTHORIZATION)|api_?key|access_token|refresh_token|auth_token|secret|password|authorization)(\s*[=:]\s*)(?!<redacted>)("?)[^\s"',;]+/gi, '$1$2$3<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  // Anthropic request and message ids: the API's logs tie them to the account that made the call.
  [/\b(req|msg)_[A-Za-z0-9]{16,}/g, '$1_<redacted>'],
];

const SECRET_KEYS = new Set([
  'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken', 'bearertoken',
  'authorization', 'auth', 'password', 'passwd', 'secret', 'clientsecret', 'cookie', 'setcookie', 'credential', 'credentials',
  'privatekey', 'accountid', 'creatoraccountid', 'creatoruserid', 'userid', 'email', 'useremail',
]);

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEYS.has(k) || /(apikey|secret|password|accesstoken|refreshtoken|authtoken)$/.test(k);
}

function urlDecode(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function sanitizeText(text: string, ctx: SanitizeContext): string {
  let out = urlDecode(text);
  const labeled = [...ctx.paths, ...(ctx.home.length > 1 ? [{ path: ctx.home, label: '~' }] : [])]
    .flatMap((p) => pathForms(p.path).map((form) => ({ form, label: p.label })))
    .sort((a, b) => b.form.length - a.form.length);
  for (const { form, label } of labeled) out = out.split(form).join(label);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\/(home|Users)\/[^/\s"'\\]+/g, '/$1/<user>');
  out = out.replace(/-(home|Users)-[^-\s"'/\\]+/g, '-$1-<user>');
  out = out.replace(/([A-Za-z]:(?:\\\\?|\/)Users(?:\\\\?|\/))[^\\/\s"']+/g, '$1<user>');
  for (const [word, label] of [[ctx.hostname, '<host>'], [ctx.username, '<user>']] as const) {
    if (word.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`, 'g'), label);
  }
  return out;
}

function parseStructured(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    const value: unknown = JSON.parse(t);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeValue(value: unknown, ctx: SanitizeContext, depth: number): unknown {
  if (typeof value === 'string') {
    const inner = depth < 8 ? parseStructured(value) : undefined;
    return inner === undefined ? sanitizeText(value, ctx) : JSON.stringify(sanitizeValue(inner, ctx, depth + 1));
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, ctx, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[sanitizeText(k, ctx)] = isSecretKey(k) && v !== null && typeof v !== 'number' && typeof v !== 'boolean' ? '<redacted>' : sanitizeValue(v, ctx, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitize(text: string, ctx: SanitizeContext): string {
  return text
    .split('\n')
    .map((line) => {
      const value = parseStructured(line);
      return value === undefined ? sanitizeText(line, ctx) : JSON.stringify(sanitizeValue(value, ctx, 0));
    })
    .join('\n');
}
