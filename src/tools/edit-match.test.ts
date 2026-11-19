// Test cases ported from Turnpack's test/edit-match.test.mjs
// (https://github.com/OnlyTerp/turnpack, Copyright 2026 OnlyTerp, Apache-2.0).
// Modified by the agent-code-mode authors: vitest, typed, and checks of the
// `matched` text this port adds.
import { describe, expect, it } from 'vitest';
import { applySearchReplace, type EditApplied, type EditMiss, type EditOutcome } from './edit-match.js';

const apply = (text: string, search: string, replace: string, all = false): EditOutcome => applySearchReplace(text, search, replace, all);

function ok(out: EditOutcome): EditApplied {
  if (!out.ok) throw new Error(`expected a match: ${out.message}`);
  return out;
}
function miss(out: EditOutcome): EditMiss {
  if (out.ok) throw new Error(`expected no match, got ${out.how}`);
  return out;
}

describe('edit matching (ported from Turnpack)', () => {
  it('uses the exact text when it is there, and says where an ambiguous one occurs', () => {
    const text = 'a = 1\nb = 2\na = 1\n';
    const once = ok(apply(text, 'b = 2', 'b = 3'));
    expect([once.how, once.count, once.text, once.matched]).toEqual(['exact', 1, 'a = 1\nb = 3\na = 1\n', 'b = 2']);

    const twice = miss(apply(text, 'a = 1', 'a = 9'));
    expect(twice.kind).toBe('ambiguous');
    expect(twice.message).toMatch(/matches 2 places \(lines 1, 3\)/);

    const all = ok(apply(text, 'a = 1', 'a = 9', true));
    expect([all.count, all.text]).toEqual([2, 'a = 9\nb = 2\na = 9\n']);

    // The replacement is inserted as written: no "$&" or "$1" expansion.
    expect(ok(apply('x = 1\n', 'x = 1', "x = '$&$1'")).text).toBe("x = '$&$1'\n");
    expect(miss(apply('x\n', '', 'y')).kind).toBe('empty');
  });

  it("matches LF text against a CRLF file and keeps the file's line endings", () => {
    const out = ok(apply('a\r\nb\r\nc\r\n', 'a\nb', 'x\ny'));
    expect([out.how, out.text, out.matched]).toEqual(['line-endings', 'x\r\ny\r\nc\r\n', 'a\r\nb']);
  });

  it('finds a block whose indentation was remembered wrongly, and re-indents what replaces it', () => {
    const file = 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n';
    const out = ok(apply(file, 'if (x) {\n    return 1;\n}', 'if (x) {\n    log();\n    return 2;\n}'));
    expect(out.how).toBe('indentation');
    expect(out.text).toBe('function f() {\n    if (x) {\n        log();\n        return 2;\n    }\n}\n');
    expect(out.matched).toBe('    if (x) {\n        return 1;\n    }');

    // Spaces remembered where the file has tabs: converted level by level.
    const tabbed = 'class A {\n\trun() {\n\t\treturn 1;\n\t}\n}\n';
    const tabs = ok(apply(tabbed, '    run() {\n        return 1;\n    }', '    run() {\n        if (ok) {\n            return 2;\n        }\n    }'));
    expect(tabs.how).toBe('indentation');
    expect(tabs.text).toBe('class A {\n\trun() {\n\t\tif (ok) {\n\t\t\treturn 2;\n\t\t}\n\t}\n}\n');

    // And the other way round, in a CRLF file, with the trailing newline included in the search.
    const crlf = '  a();\r\n  b();\r\nend\r\n';
    const mixed = ok(apply(crlf, '\ta();\n\tb();\n', '\ta();\n\tc();\n'));
    expect(mixed.text).toBe('  a();\r\n  c();\r\nend\r\n');
  });

  it('ignores line numbers copied from a listing, trailing spaces, and typographic quotes', () => {
    const file = 'export const TAX = 0.08;\n\nexport function tax(n) {\n  return n * TAX;\n}\n';
    const listing = ok(
      apply(file, '3 | export function tax(n) {\n4 |   return n * TAX;\n5 | }', '3 | export function tax(n) {\n4 |   return round(n * TAX);\n5 | }'),
    );
    expect(listing.how).toBe('line-numbers');
    expect(listing.text).toBe('export const TAX = 0.08;\n\nexport function tax(n) {\n  return round(n * TAX);\n}\n');

    // A file that really does contain "12 | x" is matched exactly, not stripped.
    expect(ok(apply('12 | x\n', '12 | x', '13 | y')).how).toBe('exact');

    const spaced = ok(apply('foo();   \nbar();\n', 'foo();\nbar();', 'baz();'));
    expect([spaced.how, spaced.text, spaced.matched]).toEqual(['trailing-whitespace', 'baz();\n', 'foo();   \nbar();']);

    const quoted = ok(apply('  const s = “hello”; // it’s\n', 'const s = "hello"; // it\'s', 'const s = "bye";'));
    expect([quoted.how, quoted.text, quoted.matched]).toEqual(['punctuation', '  const s = "bye";\n', '  const s = “hello”; // it’s']);
  });

  it('never picks between two places that only match loosely', () => {
    const file = 'if (a) {\n  go();\n}\nif (b) {\n    go();\n}\n';
    const out = miss(apply(file, '      go();', '      stop();'));
    expect(out.kind).toBe('ambiguous');
    expect(out.message).toMatch(/matches 2 places \(lines 2, 5\) when indentation is ignored/);

    const all = ok(apply(file, '      go();', '      stop();', true));
    expect(all.text).toBe('if (a) {\n  stop();\n}\nif (b) {\n    stop();\n}\n');

    // Blank lines alone are not a place.
    expect(miss(apply('a\n\n\nb\n', '   \n  ', 'x')).kind).toBe('not-found');
  });

  it('shows the nearest text and the first difference when nothing matches', () => {
    const file = [
      "import { TAX } from './rates.js';",
      '',
      'export function invoiceTotal(subtotal) {',
      '  const tax = Number((subtotal * TAX).toFixed(2));',
      '  return subtotal + tax;',
      '}',
      '',
    ].join('\n');
    const out = miss(apply(file, 'export function invoiceTotal(subtotal) {\n  const tax = subtotal * TAX;\n  return subtotal + tax;\n}', 'x'));
    expect(out.kind).toBe('not-found');
    expect(out.message).toMatch(/closest text is lines 3-6 \(3 of 4 line\(s\) identical/);
    expect(out.message).toMatch(/ 4 \| {3}const tax = Number\(\(subtotal \* TAX\)\.toFixed\(2\)\);/);
    expect(out.message).toMatch(/First difference, at line 4:/);
    expect(out.message).toMatch(/search has: " {2}const tax = subtotal \* TAX;"/);
    expect(out.message).toMatch(/file has: {3}" {2}const tax = Number/);

    const nowhere = miss(apply(file, 'class Zebra extends Animal {}', 'x'));
    expect(nowhere.message).toMatch(/nothing close to it is in the file \(7 lines\)/);
  });
});
