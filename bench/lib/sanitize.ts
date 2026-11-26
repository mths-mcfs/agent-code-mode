import os from 'node:os';

export interface SanitizeContext {
  readonly paths: readonly { readonly path: string; readonly label: string }[];
  readonly home: string;
  readonly username: string;
  readonly hostname: string;
  /** Real id to placeholder, shared by every file of one run so that ids still match across files. */
  readonly ids: Map<string, string>;
}

export function defaultSanitizeContext(paths: SanitizeContext['paths']): SanitizeContext {
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env['USER'] ?? process.env['USERNAME'] ?? '';
  }
  return { paths, home: os.homedir(), username, hostname: os.hostname(), ids: new Map() };
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
  // An Authorization header value is the whole rest of the line, however short (`Basic dXNlcjpwdw==`).
  [/\b((?:proxy-)?authorization)(\s*:\s*)(?!<redacted>)[^\r\n"\\]+/gi, '$1$2<redacted>'],
  // A value is a single- or double-quoted string (also with escaped quotes) or one unquoted word.
  [/\b((?:[A-Za-z0-9]+[_-])+(?:TOKEN|KEY)|(?:[A-Za-z0-9]+[_-])*(?:SECRET|PASSWORD|AUTHORIZATION)|token|apikey)(\s*[=:]\s*)(?!<redacted>)(?:(\\*)"(?:(?!\3").)*\3"|'[^']*'|[^\s"',;]+)/gi, '$1$2<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
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

// Session, thread, event and API ids (UUIDs, Anthropic `toolu_`, `req_` and `msg_` ids, and the `repl_` ids
// Claude Code's Code Mode gives the calls a script makes): the hosts' and the API's logs tie them to the
// account that made the run. A `repl_` id's length is unknown, so a shorter one counts too.
const ID_PATTERN = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:toolu|req|msg)_[A-Za-z0-9]{16,}|repl_[A-Za-z0-9]{8,})\b/gi;
const UUID_PLACEHOLDER = '00000000-0000-4000-8000-';

function placeholderId(id: string, ids: Map<string, string>): string {
  const prefix = /^(toolu|req|msg|repl)_/i.exec(id)?.[0];
  const isPlaceholder = prefix === undefined ? id.startsWith(UUID_PLACEHOLDER) : /^\d+$/.test(id.slice(prefix.length));
  if (isPlaceholder) return id;
  let mapped = ids.get(id);
  if (mapped === undefined) {
    const n = [...ids.values()].filter((v) => (prefix === undefined ? v.startsWith(UUID_PLACEHOLDER) : v.startsWith(prefix))).length + 1;
    mapped = prefix === undefined ? `${UUID_PLACEHOLDER}${String(n).padStart(12, '0')}` : `${prefix}${String(n).padStart(24, '0')}`;
    ids.set(id, mapped);
  }
  return mapped;
}

function sanitizeText(text: string, ctx: SanitizeContext): string {
  let out = urlDecode(text);
  const labeled = [...ctx.paths, ...(ctx.home.length > 1 ? [{ path: ctx.home, label: '~' }] : [])]
    .flatMap((p) => pathForms(p.path).map((form) => ({ form, label: p.label })))
    .sort((a, b) => b.form.length - a.form.length);
  for (const { form, label } of labeled) out = out.split(form).join(label);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(ID_PATTERN, (id) => placeholderId(id, ctx.ids));
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
