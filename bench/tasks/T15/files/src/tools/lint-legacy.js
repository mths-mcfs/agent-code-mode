/**
 * Source check used in CI: reports the lines of a source text that call one of the banned HTTP
 * helpers. It works on text, so the banned calls are spelled out as strings here.
 */
const BANNED = ['legacyFetch(', 'legacyJson('];

export function findBannedCalls(source) {
  const found = [];
  source.split('\n').forEach((line, index) => {
    for (const call of BANNED) {
      if (line.includes(call)) found.push({ line: index + 1, call: call.slice(0, -1) });
    }
  });
  return found;
}

export function describeBannedCall(hit) {
  return `line ${hit.line}: legacyFetch(url, opts) and legacyJson(url, opts) are deprecated (found ${hit.call})`;
}
