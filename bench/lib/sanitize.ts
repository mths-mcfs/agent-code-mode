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
  [/("(?:access_token|refresh_token|id_token|api_key|apiKey|token|password|secret)"\s*:\s*")[^"]+(")/gi, '$1<token>$2'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
];

/**
 * Removes what identifies the machine or the person from a transcript: known absolute paths
 * (workspace, repo, temp homes), the home directory, the username, the hostname, emails and
 * token-shaped strings. Tool names, workspace-relative arguments and usage numbers stay.
 */
export function sanitize(text: string, ctx: SanitizeContext): string {
  let out = text;
  const labeled = [...ctx.paths, ...(ctx.home.length > 1 ? [{ path: ctx.home, label: '~' }] : [])]
    .flatMap((p) => pathForms(p.path).map((form) => ({ form, label: p.label })))
    .sort((a, b) => b.form.length - a.form.length);
  for (const { form, label } of labeled) out = out.split(form).join(label);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  // Generic home-directory paths of any user (e.g. in error messages).
  out = out.replace(/\/(home|Users)\/[^/\s"'\\]+/g, '/$1/<user>');
  out = out.replace(/-(home|Users)-[^-\s"'/\\]+/g, '-$1-<user>');
  out = out.replace(/([A-Za-z]:\\\\?Users\\\\?)[^\\\s"']+/g, '$1<user>');
  for (const [word, label] of [[ctx.hostname, '<host>'], [ctx.username, '<user>']] as const) {
    if (word.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`, 'g'), label);
  }
  return out;
}
