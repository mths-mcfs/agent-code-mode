import { describe, expect, it } from 'vitest';
import { configSecrets, redact, redactDeep } from './secrets.js';

describe('configSecrets', () => {
  it('takes every value under a credential-like name, whatever its length', () => {
    expect(configSecrets({ API_TOKEN: 'ab', DB_PASSWORD: 'x1', SESSION: 'z' }, ['--api-key', 'k1', '--auth=q'])).toEqual(expect.arrayContaining(['ab', 'x1', 'z', 'k1', 'q']));
  });

  it('takes a value expanded from a credential-like variable at any length', () => {
    expect(configSecrets({}, [], [{ name: 'API_TOKEN', value: 'ab12' }, { name: 'REGION', value: 'eu' }])).toEqual(['ab12']);
  });

  it('takes other values only from 8 characters, so ordinary output survives', () => {
    expect(configSecrets({ FORMAT: 'json', PORT: '8080', ENDPOINT_ID: 'abcd-1234-efgh' }, ['--port', '8080'], [{ name: 'A', value: 'short' }, { name: 'B', value: 'expanded-value' }]).sort()).toEqual(['abcd-1234-efgh', 'expanded-value']);
  });
});

describe('redact', () => {
  it('replaces every occurrence, the longest secret first, in strings and object keys', () => {
    expect(redact('a tok-12345 b tok-12345', ['tok-12345'])).toBe('a <redacted> b <redacted>');
    expect(redactDeep({ 'tok-12345': ['tok-12345'] }, ['tok-12345'])).toEqual({ '<redacted>': ['<redacted>'] });
  });
});
