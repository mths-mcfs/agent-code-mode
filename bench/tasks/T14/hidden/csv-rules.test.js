import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCsvParser, CsvError, parseCsv } from '../src/lib/csv.js';

/** Feeds the chunks and returns what each call returned: `{ pushes: [...], end }`, or `'CsvError'` in place of a call that threw one. */
function feed(chunks) {
  const parser = createCsvParser();
  const call = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CsvError) return 'CsvError';
      throw err;
    }
  };
  const pushes = chunks.map((chunk) => call(() => parser.push(chunk)));
  return { pushes, end: call(() => parser.end()) };
}

const show = (value) => JSON.stringify(value);

test('rule 2: fields, record ends and empty lines', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('a\r\nb\nc\r\n'), [['a'], ['b'], ['c']]);
  assert.deepEqual(parseCsv('a\n\nb\n'), [['a'], [''], ['b']]);
  assert.deepEqual(parseCsv('\n'), [['']]);
  assert.deepEqual(parseCsv('\r\n\r\n'), [[''], ['']]);
  assert.deepEqual(parseCsv(',\n,,\n'), [['', ''], ['', '', '']]);
  assert.deepEqual(parseCsv('a,b,c\nd\ne,f\n'), [['a', 'b', 'c'], ['d'], ['e', 'f']]);
});

test('rule 1: nothing is trimmed and no other character is special', () => {
  assert.deepEqual(parseCsv(' a , b\t\n'), [[' a ', ' b\t']]);
  assert.deepEqual(parseCsv('﻿id,x\n'), [['﻿id', 'x']]);
  assert.deepEqual(parseCsv("it's;a|b\\n,'q'\n"), [["it's;a|b\\n", "'q'"]]);
  assert.deepEqual(parseCsv('a,\u{1F600}é\0\n'), [['a', '\u{1F600}é\0']]);
});

test('rule 3: quoted fields', () => {
  assert.deepEqual(parseCsv('"a","b"\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv('"a,b",c\n'), [['a,b', 'c']]);
  assert.deepEqual(parseCsv('"say ""hi""",x\n'), [['say "hi"', 'x']]);
  assert.deepEqual(parseCsv('""""\n'), [['"']]);
  assert.deepEqual(parseCsv('"""",""""""\n'), [['"', '""']]);
  assert.deepEqual(parseCsv('"line 1\nline 2","cr\rlf\r\nend"\r\n'), [['line 1\nline 2', 'cr\rlf\r\nend']]);
  assert.deepEqual(parseCsv('"",""\n""\n'), [['', ''], ['']]);
  assert.deepEqual(parseCsv('a,"",b\n'), [['a', '', 'b']]);
  assert.deepEqual(parseCsv('" a "\n'), [[' a ']]);
  assert.deepEqual(parseCsv('"a"\r\n"b"'), [['a'], ['b']]);
});

test('rule 4: push returns the records completed by the chunk', () => {
  assert.deepEqual(feed(['a,b\nc,d\ne', ',f\n', 'g']), { pushes: [[['a', 'b'], ['c', 'd']], [['e', 'f']], []], end: [['g']] });
  assert.deepEqual(feed(['', 'a', '', '\n', '']), { pushes: [[], [], [], [['a']], []], end: [] });
  assert.deepEqual(feed(['a\r', '\n']), { pushes: [[], [['a']]], end: [] }, 'the record is completed by the line feed');
  assert.deepEqual(feed(['"a"', '\n']), { pushes: [[], [['a']]], end: [] });
  assert.deepEqual(feed(['"a\n', 'b"\n']), { pushes: [[], [['a\nb']]], end: [] }, 'a line feed inside quotes ends nothing');
  const parser = createCsvParser();
  const first = parser.push('a\n');
  first[0].push('changed');
  assert.deepEqual(parser.push('b\n'), [['b']]);
});

test('rule 1: a chunk may end anywhere', () => {
  assert.deepEqual(feed(['"a"', '"b"\n']), { pushes: [[], [['a"b']]], end: [] }, 'between the two quotes of ""');
  assert.deepEqual(feed(['"', '"', '"', '"', '\n']), { pushes: [[], [], [], [], [['"']]], end: [] });
  assert.deepEqual(feed(['"a"', ',b\n']), { pushes: [[], [['a', 'b']]], end: [] });
  assert.deepEqual(feed(['a\r', '\nb\r', '\n']), { pushes: [[], [['a']], [['b']]], end: [] }, 'between \\r and \\n');
  assert.deepEqual(feed(['"a"\r', '\n']), { pushes: [[], [['a']]], end: [] });
  assert.deepEqual(feed(['"a\r', '\nb"', '\r', '\n']), { pushes: [[], [], [], [['a\r\nb']]], end: [] });
  assert.deepEqual(feed(['x\uD83D', '\uDE00y\n']), { pushes: [[], [['x\u{1F600}y']]], end: [] }, 'inside a surrogate pair');
  assert.deepEqual(feed(['a,', '', 'b', ',', '\n']), { pushes: [[], [], [], [], [['a', 'b', '']]], end: [] });
  const text = 'id,"na""me"\r\n1,"x\r\ny"\r\n,\n"",z';
  const whole = parseCsv(text);
  assert.deepEqual(whole, [['id', 'na"me'], ['1', 'x\r\ny'], ['', ''], ['', 'z']]);
  const byChar = feed([...text].flatMap((c) => c.split('')));
  assert.deepEqual([...byChar.pushes.flat(), ...byChar.end], whole);
});

test('rule 5: end returns the unterminated last record, and a final newline adds nothing', () => {
  assert.deepEqual(feed([]), { pushes: [], end: [] });
  assert.deepEqual(feed(['']), { pushes: [[]], end: [] });
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(feed(['a,b\n']), { pushes: [[['a', 'b']]], end: [] });
  assert.deepEqual(feed(['a,b\r\n']), { pushes: [[['a', 'b']]], end: [] });
  assert.deepEqual(feed(['a,b']), { pushes: [[]], end: [['a', 'b']] });
  assert.deepEqual(feed(['a,']), { pushes: [[]], end: [['a', '']] });
  assert.deepEqual(feed([',']), { pushes: [[]], end: [['', '']] });
  assert.deepEqual(feed(['a\n""']), { pushes: [[['a']]], end: [['']] });
  assert.deepEqual(feed(['a\n"b"']), { pushes: [[['a']]], end: [['b']] });
  assert.deepEqual(feed(['a\n\n']), { pushes: [[['a'], ['']]], end: [] });
  assert.deepEqual(feed(['"a\n"']), { pushes: [[]], end: [['a\n']] });
});

test('rule 6: invalid input throws CsvError from the call that receives the offending character', () => {
  assert.deepEqual(feed(['a"b\n']), { pushes: ['CsvError'], end: 'CsvError' }, '(a)');
  assert.deepEqual(feed(['x\na', '"', 'b']), { pushes: [[['x']], 'CsvError', 'CsvError'], end: 'CsvError' }, '(a)');
  assert.deepEqual(feed([' "a"\n']), { pushes: ['CsvError'], end: 'CsvError' }, '(a) a space before the quote makes the field unquoted');
  assert.deepEqual(feed(['a,b"']), { pushes: ['CsvError'], end: 'CsvError' }, '(a)');
  assert.deepEqual(feed(['"a"b\n']), { pushes: ['CsvError'], end: 'CsvError' }, '(b)');
  assert.deepEqual(feed(['"a"', ' ', ',b\n']), { pushes: [[], 'CsvError', 'CsvError'], end: 'CsvError' }, '(b)');
  assert.deepEqual(feed(['"a""', '"x']), { pushes: [[], 'CsvError'], end: 'CsvError' }, '(b) "a"" then " closes the field, x follows');
  assert.deepEqual(feed(['a\rb\n']), { pushes: ['CsvError'], end: 'CsvError' }, '(c)');
  assert.deepEqual(feed(['a\r', 'b']), { pushes: [[], 'CsvError'], end: 'CsvError' }, '(c) the character after the \\r is the offending one');
  assert.deepEqual(feed(['a\r', '\r\n']), { pushes: [[], 'CsvError'], end: 'CsvError' }, '(c)');
  assert.deepEqual(feed(['"a"\r', ',']), { pushes: [[], 'CsvError'], end: 'CsvError' }, '(c)');
  assert.deepEqual(feed(['a\n', 'b\r']), { pushes: [[['a']], []], end: 'CsvError' }, '(c) at the end of the input');
  assert.deepEqual(feed(['\r']), { pushes: [[]], end: 'CsvError' }, '(c)');
  assert.deepEqual(feed(['a\n"b']), { pushes: [[['a']]], end: 'CsvError' }, '(d)');
  assert.deepEqual(feed(['"']), { pushes: [[]], end: 'CsvError' }, '(d)');
  assert.deepEqual(feed(['"a""']), { pushes: [[]], end: 'CsvError' }, '(d) the last two quotes are an escaped quote');
  assert.deepEqual(feed(['"a,b\n', 'c\n']), { pushes: [[], []], end: 'CsvError' }, '(d)');
  assert.throws(() => parseCsv('a,"b'), CsvError);
  assert.throws(() => parseCsv('a,b\n"c"d'), CsvError);
  assert.ok(new CsvError('x') instanceof Error);
});

test('rule 7: a failed or ended parser, and chunks that are not strings', () => {
  const failed = createCsvParser();
  assert.throws(() => failed.push('a"'), CsvError);
  assert.throws(() => failed.push('ok\n'), CsvError);
  assert.throws(() => failed.push(''), CsvError);
  assert.throws(() => failed.end(), CsvError);
  assert.throws(() => failed.end(), CsvError);

  const ended = createCsvParser();
  assert.deepEqual(ended.push('a\n'), [['a']]);
  assert.deepEqual(ended.end(), []);
  assert.throws(() => ended.push('b\n'), CsvError);
  assert.throws(() => ended.push(''), CsvError);
  assert.throws(() => ended.end(), CsvError);

  const endFailed = createCsvParser();
  endFailed.push('"open');
  assert.throws(() => endFailed.end(), CsvError);
  assert.throws(() => endFailed.push('"'), CsvError);
  assert.throws(() => endFailed.end(), CsvError);

  const parser = createCsvParser();
  assert.deepEqual(parser.push('a,"b'), []);
  for (const bad of [undefined, null, 1, ['x'], { length: 1, 0: 'x' }, Buffer.from('x'), new String('x')]) {
    assert.throws(() => parser.push(bad), (err) => err instanceof TypeError && !(err instanceof CsvError), `push(${show(bad)})`);
  }
  assert.deepEqual(parser.push('"\n'), [['a', 'b']], 'the parser is as it was before the bad chunks');
  assert.deepEqual(parser.end(), []);
});

test('rule 8: parseCsv is one push and end', () => {
  assert.deepEqual(parseCsv('a,b\n"c\n""d""",e'), [['a', 'b'], ['c\n"d"', 'e']]);
  assert.throws(() => parseCsv('a\r'), CsvError);
});

// ---- Seeded fuzz ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (random, min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (random, items) => items[int(random, 0, items.length - 1)];

/** Cuts `text` into chunks at random UTF-16 offsets; some chunks are empty. */
function cut(random, text) {
  const style = random();
  if (style < 0.15) return text.split('');
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const size = random() < 0.15 ? 0 : int(random, 1, style < 0.6 ? 3 : 9);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  if (random() < 0.2) chunks.push('');
  return chunks;
}

/**
 * Reference reading of the rules over the whole text at once, by searching for delimiters instead
 * of stepping through states. Returns the records, each with the offset just past its record end
 * (or 'end' for an unterminated last record), and where the input is invalid: the offset of the
 * offending character, 'end' when only the end of the input reveals it, or null.
 */
function wholeText(text) {
  const records = [];
  const n = text.length;
  const plain = /[^,"\r\n]*/y;
  let i = 0;
  while (i < n) {
    const fields = [];
    for (;;) {
      let value = '';
      if (text[i] === '"') {
        let from = i + 1;
        for (;;) {
          const quote = text.indexOf('"', from);
          if (quote === -1) return { records, error: 'end' };
          value += text.slice(from, quote);
          if (text[quote + 1] !== '"') {
            i = quote + 1;
            break;
          }
          value += '"';
          from = quote + 2;
        }
        if (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') return { records, error: i };
      } else {
        plain.lastIndex = i;
        value = plain.exec(text)[0];
        i += value.length;
        if (text[i] === '"') return { records, error: i };
      }
      fields.push(value);
      if (i >= n) {
        records.push({ fields, end: 'end' });
        return { records, error: null };
      }
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '\r') {
        if (i + 1 >= n) return { records, error: 'end' };
        if (text[i + 1] !== '\n') return { records, error: i + 1 };
        i += 1;
      }
      i += 1;
      break;
    }
    records.push({ fields, end: i });
  }
  return { records, error: null };
}

/** What each call must return for these chunks, from the whole-text reading. */
function expectedCalls(chunks) {
  const { records, error } = wholeText(chunks.join(''));
  let start = 0;
  let failed = false;
  const pushes = chunks.map((chunk) => {
    const stop = start + chunk.length;
    if (failed || (typeof error === 'number' && error >= start && error < stop)) {
      failed = true;
      start = stop;
      return 'CsvError';
    }
    const done = records.filter((r) => r.end !== 'end' && r.end > start && r.end <= stop).map((r) => r.fields);
    start = stop;
    return done;
  });
  const end = failed || error === 'end' ? 'CsvError' : records.filter((r) => r.end === 'end').map((r) => r.fields);
  return { pushes, end };
}

test('the whole-text reading used by the fuzz agrees with the rules', () => {
  assert.deepEqual(wholeText('a,"b""c"\r\n\n,x'), { records: [{ fields: ['a', 'b"c'], end: 10 }, { fields: [''], end: 11 }, { fields: ['', 'x'], end: 'end' }], error: null });
  assert.equal(wholeText('a\n"b"c').error, 5);
  assert.equal(wholeText('ab"').error, 2);
  assert.equal(wholeText('a\rb').error, 2);
  assert.equal(wholeText('a\r').error, 'end');
  assert.equal(wholeText('"a').error, 'end');
});

test('fuzz: built records, serialized with random quoting and record ends, in random chunks', () => {
  const random = mulberry32(0x5eed01);
  const pieces = ['a', 'b', 'xyz', ' ', ',', '"', '""', '\r', '\n', '\r\n', 'é', '\u{1F600}', '\t', "'"];
  for (let round = 0; round < 1500; round += 1) {
    const records = Array.from({ length: int(random, 0, 5) }, () =>
      Array.from({ length: int(random, 1, 4) }, () => Array.from({ length: int(random, 0, 4) }, () => pick(random, pieces)).join('')),
    );
    const terminated = random() < 0.5;
    let text = '';
    records.forEach((fields, r) => {
      const last = r === records.length - 1;
      const loneEmpty = fields.length === 1 && fields[0] === '';
      text += fields.map((f) => (/[,"\r\n]/.test(f) || random() < 0.25 || (loneEmpty && last && !terminated) ? `"${f.replaceAll('"', '""')}"` : f)).join(',');
      if (!last || terminated) text += random() < 0.5 ? '\r\n' : '\n';
    });
    const chunks = cut(random, text);
    const got = feed(chunks);
    const where = `round ${round}, chunks ${show(chunks)}`;
    assert.ok(got.end !== 'CsvError' && !got.pushes.includes('CsvError'), `${where}: valid input threw CsvError`);
    assert.deepEqual([...got.pushes.flat(), ...got.end], records, where);
    assert.deepEqual(got, expectedCalls(chunks), `${where}: records per call`);
    assert.deepEqual(parseCsv(text), records, `round ${round}, text ${show(text)}`);
  }
});

test('fuzz: random text, valid or not, in random chunks', () => {
  const random = mulberry32(0x5eed02);
  const pieces = ['a', 'b', ',', ',', '"', '"', '""', '\r', '\n', '\n', '\r\n', '\r\n', ' ', '\u{1F600}'];
  let invalid = 0;
  for (let round = 0; round < 4000; round += 1) {
    const text = Array.from({ length: int(random, 0, 12) }, () => pick(random, pieces)).join('');
    const whole = wholeText(text);
    if (whole.error !== null) invalid += 1;
    for (let variant = 0; variant < 2; variant += 1) {
      const chunks = variant === 0 ? [text] : cut(random, text);
      assert.deepEqual(feed(chunks), expectedCalls(chunks), `round ${round}, chunks ${show(chunks)}`);
    }
    if (whole.error === null) assert.deepEqual(parseCsv(text), whole.records.map((r) => r.fields), `round ${round}, text ${show(text)}`);
    else assert.throws(() => parseCsv(text), CsvError, `round ${round}, text ${show(text)}`);
  }
  assert.ok(invalid > 500 && invalid < 3500, `the fuzz mixes valid and invalid inputs (invalid: ${invalid})`);
});
