import os from 'node:os';

export interface SanitizeContext {
  /** Absolute paths replaced by a label, e.g. the workspace by `<workspace>`. Longest first wins. */
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
  // "key": "value" pairs, also inside JSON text that was escaped one or more times (\" or \\\").
  [/(\\*"(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|authorization|password|passwd|secret|client[_-]?secret|cookie|private[_-]?key)\\*"\s*:\s*(\\*)")(?:(?!\2").)*(\2")/gi, '$1<redacted>$3'],
  // key = value / key: value in TOML, env files and headers.
  [/\b((?:[A-Z0-9]+_)*(?:API_?KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|AUTHORIZATION)|api_?key|access_token|refresh_token|auth_token|secret|password|authorization)(\s*[=:]\s*)(?!<redacted>)("?)[^\s"',;]+/gi, '$1$2$3<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
];

/** Keys whose string values are always secrets or account identifiers, whatever they look like. */
const SECRET_KEYS = new Set([
  'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken', 'bearertoken',
  'authorization', 'auth', 'password', 'passwd', 'secret', 'clientsecret', 'cookie', 'setcookie', 'credential', 'credentials',
  'privatekey', 'accountid', 'creatoraccountid', 'creatoruserid', 'userid', 'email', 'useremail',
]);

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEYS.has(k) || /(apikey|secret|password|accesstoken|refreshtoken|authtoken)$/.test(k);
}

/** Decodes %XX runs (URL-encoded paths), leaving malformed runs as they are. */
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
  // Generic home-directory paths of any user (e.g. in error messages).
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
    // A string that is itself JSON (tool arguments, MCP results) is decoded and sanitized as a value.
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

/**
 * Removes what identifies the machine or the person from a transcript, after decoding it: each line
 * that is JSON is parsed (recursively, strings holding JSON included) and every string is sanitized;
 * values under secret-looking keys are redacted whatever they contain. Other lines are URL-decoded and
 * sanitized as text: known absolute paths (workspace, repo, temp homes), the home directory, the
 * username, the hostname, emails and token-shaped strings. Tool names, workspace-relative arguments and
 * usage numbers stay.
 */
export function sanitize(text: string, ctx: SanitizeContext): string {
  return text
    .split('\n')
    .map((line) => {
      const value = parseStructured(line);
      return value === undefined ? sanitizeText(line, ctx) : JSON.stringify(sanitizeValue(value, ctx, 0));
    })
    .join('\n');
}

/** `sanitize` for a JSON document: sanitized as one value, written back pretty-printed. */
export function sanitizeJsonDocument(text: string, ctx: SanitizeContext): string {
  const value = parseStructured(text);
  if (value === undefined) return sanitize(text, ctx);
  return `${JSON.stringify(sanitizeValue(value, ctx, 0), null, 2)}\n`;
}

/** Writes `text` to `file` after sanitizing it (JSON documents as values, everything else line by line). */
export async function writeSanitized(file: string, text: string, ctx: SanitizeContext): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, file.endsWith('.json') ? sanitizeJsonDocument(text, ctx) : sanitize(text, ctx));
}

/**
 * Sanitizes, in place, every text file under a results directory: the final pass the harness runs
 * over everything it wrote for commit, and the way to clean results written by an older harness
 * without re-running them. Compressed files are left alone. Returns the files it changed.
 */
export async function sanitizeTree(dir: string, ctx: SanitizeContext): Promise<string[]> {
  const { readdir, readFile, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const changed: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && !p.endsWith('.gz')) {
        const before = await readFile(p, 'utf8');
        const after = p.endsWith('.json') ? sanitizeJsonDocument(before, ctx) : sanitize(before, ctx);
        if (after !== before) {
          await writeFile(p, after);
          changed.push(p);
        }
      }
    }
  };
  await walk(dir);
  return changed;
}
