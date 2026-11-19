import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCsvParser, parseCsv } from '../src/lib/csv.js';

test('parses plain and quoted fields', () => {
  assert.deepEqual(parseCsv('id,name\r\n1,"Doe, Jane"\r\n'), [['id', 'name'], ['1', 'Doe, Jane']]);
});

test('push returns the records each chunk completes', () => {
  const parser = createCsvParser();
  assert.deepEqual(parser.push('a,b\nc'), [['a', 'b']]);
  assert.deepEqual(parser.push(',d'), []);
  assert.deepEqual(parser.end(), [['c', 'd']]);
});
