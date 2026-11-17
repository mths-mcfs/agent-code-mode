/** Thrown for invalid CSV and for calls on a parser that has failed or ended. */
export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

/** Returns a streaming parser: `{ push(chunk), end() }`. */
export function createCsvParser() {
  throw new Error('not implemented');
}

/** Parses a complete input and returns all its records. */
export function parseCsv(text) {
  const parser = createCsvParser();
  return [...parser.push(text), ...parser.end()];
}
