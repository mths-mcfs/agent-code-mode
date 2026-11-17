/** Thrown for invalid CSV and for calls on a parser that has failed or ended. */
export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

// Where the parser stands between two characters. QUOTE and CR are the two states that need the
// next character to be decided, so they are what survives a chunk boundary.
const RECORD_START = 0; // nothing of the current record has been read
const FIELD_START = 1; // right after a comma
const UNQUOTED = 2;
const QUOTED = 3;
const QUOTE = 4; // a quote inside a quoted field: the closing quote, or the first half of ""
const CR = 5; // a carriage return outside quotes: must be followed by a line feed
const DEAD = 6; // failed or ended

/** Returns a streaming parser: `{ push(chunk), end() }`. */
export function createCsvParser() {
  let state = RECORD_START;
  let field = '';
  let record = [];

  const fail = (message) => {
    state = DEAD;
    throw new CsvError(message);
  };
  const endField = () => {
    record.push(field);
    field = '';
  };

  function push(chunk) {
    if (typeof chunk !== 'string') throw new TypeError('chunk must be a string');
    if (state === DEAD) throw new CsvError('the parser has failed or ended');
    const out = [];
    const endRecord = () => {
      out.push(record);
      record = [];
      state = RECORD_START;
    };
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk[i];
      switch (state) {
        case RECORD_START:
        case FIELD_START:
        case UNQUOTED:
          if (c === ',') {
            endField();
            state = FIELD_START;
          } else if (c === '\n') {
            endField();
            endRecord();
          } else if (c === '\r') {
            endField();
            state = CR;
          } else if (c === '"') {
            if (state === UNQUOTED) fail('quote inside an unquoted field');
            state = QUOTED;
          } else {
            field += c;
            state = UNQUOTED;
          }
          break;
        case QUOTED:
          if (c === '"') state = QUOTE;
          else field += c;
          break;
        case QUOTE:
          if (c === '"') {
            field += '"';
            state = QUOTED;
          } else if (c === ',') {
            endField();
            state = FIELD_START;
          } else if (c === '\n') {
            endField();
            endRecord();
          } else if (c === '\r') {
            endField();
            state = CR;
          } else fail('unexpected character after a closing quote');
          break;
        default: // CR
          if (c === '\n') endRecord();
          else fail('carriage return without a line feed');
      }
    }
    return out;
  }

  function end() {
    if (state === DEAD) throw new CsvError('the parser has failed or ended');
    if (state === QUOTED) fail('the input ends inside a quoted field');
    if (state === CR) fail('carriage return without a line feed');
    const out = [];
    if (state !== RECORD_START) {
      endField();
      out.push(record);
    }
    state = DEAD;
    return out;
  }

  return { push, end };
}

/** Parses a complete input and returns all its records. */
export function parseCsv(text) {
  const parser = createCsvParser();
  return [...parser.push(text), ...parser.end()];
}
