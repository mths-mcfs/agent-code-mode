import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Rng } from '../lib/rng.ts';

/**
 * Deterministic fixture repo for the benchmark tasks: a small ES-module
 * "orders" project (about 96 files) with tests that run under `node --test`
 * and need no install. The same seed gives byte-identical files everywhere.
 */

export const DEFAULT_FIXTURE_SEED = 1115;

/** Files of a workspace tree, keyed by POSIX relative path. */
export type Tree = Map<string, string>;

export interface CustomerTotal {
  readonly customer: string;
  readonly totalCents: number;
}

/** Facts the verifiers check answers and edits against. */
export interface FixtureFacts {
  readonly seed: number;
  /** T1: `service.retryLimit` in config/app.json. */
  readonly retryLimit: number;
  /** T3: the two functions whose signatures are asked. */
  readonly signatures: readonly { readonly name: string; readonly file: string; readonly signature: string }[];
  /** T4: customers by paid total, highest first (all of them). */
  readonly customerTotals: readonly CustomerTotal[];
  /** T5: the exported symbol to rename and the files that use it. */
  readonly renameFrom: string;
  readonly renameTo: string;
  readonly renameFiles: readonly string[];
  /** T4/T6: order files and which of them are paid. */
  readonly orderFiles: readonly string[];
  readonly paidOrderFiles: readonly string[];
  /** T8: handler files and the protected one. */
  readonly handlerFiles: readonly string[];
  readonly protectedFile: string;
}

export interface Fixture {
  readonly files: Tree;
  readonly facts: FixtureFacts;
}

const CUSTOMERS = [
  'Acme Corp', 'Globex', 'Initech', 'Umbrella Labs', 'Stark Supply', 'Wayne Freight', 'Hooli', 'Vandelay Imports',
  'Soylent Foods', 'Tyrell Systems', 'Cyberdyne Retail', 'Wonka Sweets',
];

const FEATURES = [
  'invoice', 'receipt', 'refund', 'quote', 'cart', 'checkout', 'coupon', 'gift-card', 'loyalty', 'payout',
  'statement', 'subscription', 'tax-summary', 'tip', 'wallet', 'budget', 'deposit', 'ledger',
];

const HANDLERS = ['orders', 'payments', 'shipping', 'returns', 'inventory', 'customers', 'reports', 'webhooks', 'search', 'health'];

const SKUS = ['SKU-APPLE', 'SKU-BREAD', 'SKU-CHEESE', 'SKU-DATES', 'SKU-EGGS', 'SKU-FLOUR', 'SKU-GRAPES', 'SKU-HONEY'];

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function pascal(name: string): string {
  const c = camel(name);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface Order {
  id: string;
  customer: string;
  status: 'paid' | 'refunded' | 'pending';
  createdAt: string;
  items: { sku: string; qty: number; unitPriceCents: number }[];
}

function orderTotal(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
}

function buildOrders(rng: Rng): Order[] {
  const notPaid = new Set(rng.shuffle(Array.from({ length: 50 }, (_v, i) => i)).slice(0, 10));
  const orders: Order[] = [];
  for (let i = 0; i < 50; i++) {
    const n = rng.int(1, 4);
    const items = Array.from({ length: n }, () => ({ sku: rng.pick(SKUS), qty: rng.int(1, 9), unitPriceCents: rng.int(150, 9_900) }));
    const day = String(rng.int(1, 28)).padStart(2, '0');
    const month = String(rng.int(1, 9)).padStart(2, '0');
    orders.push({
      id: `ORD-${String(i + 1).padStart(3, '0')}`,
      customer: rng.pick(CUSTOMERS),
      status: notPaid.has(i) ? (i % 2 === 0 ? 'refunded' : 'pending') : 'paid',
      createdAt: `2026-${month}-${day}`,
      items,
    });
  }
  return orders;
}

function customerTotals(orders: readonly Order[]): CustomerTotal[] {
  const totals = new Map<string, number>();
  for (const order of orders) if (order.status === 'paid') totals.set(order.customer, (totals.get(order.customer) ?? 0) + orderTotal(order));
  return [...totals.entries()]
    .map(([customer, totalCents]) => ({ customer, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents || a.customer.localeCompare(b.customer));
}

/** True when the top 4 totals are distinct, so "top 3" has one answer. */
function topIsUnambiguous(totals: readonly CustomerTotal[]): boolean {
  const top = totals.slice(0, 4).map((t) => t.totalCents);
  return new Set(top).size === top.length && top.length >= 4;
}

const MONEY_JS = `/** Money helpers. Amounts are integer cents. */

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

export function formatCurrency(cents, currency = 'USD') {
  const symbol = SYMBOLS[currency] ?? \`\${currency} \`;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return \`\${sign}\${symbol}\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, '0')}\`;
}

export function sumCents(values) {
  return values.reduce((sum, value) => sum + value, 0);
}
`;

const STRINGS_JS = `/** String helpers. */

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function titleCase(text) {
  return text.replace(/\\b([a-z])/g, (_m, c) => c.toUpperCase());
}

export function truncate(text, max, ellipsis = '…') {
  if (text.length <= max) return text;
  return text.slice(0, max - ellipsis.length) + ellipsis;
}
`;

function shippingJs(baseCents: number, perItemCents: number): string {
  return `/** Shipping quotes. */

const ZONE_FACTOR = { domestic: 1, nearby: 1.5, international: 3 };

export function computeShippingQuote(order, zone, options = {}) {
  const factor = ZONE_FACTOR[zone];
  if (factor === undefined) throw new Error(\`unknown zone: \${zone}\`);
  const items = order.items.reduce((n, item) => n + item.qty, 0);
  let cents = Math.round((${baseCents} + items * ${perItemCents}) * factor);
  if (options.express) cents *= 2;
  return cents;
}
`;
}

const SKU_JS = `/** SKU helpers. */

export function normalizeSku(raw, strict = false) {
  const value = String(raw).trim().toUpperCase().replace(/\\s+/g, '-');
  if (strict && !/^SKU-[A-Z0-9-]+$/.test(value)) throw new Error(\`invalid sku: \${raw}\`);
  return value.startsWith('SKU-') ? value : \`SKU-\${value}\`;
}

export function skuFamily(sku) {
  return normalizeSku(sku).split('-')[1] ?? '';
}
`;

const DATES_JS = `/** Date helpers (UTC). */

export function addBusinessDays(isoDate, days) {
  const date = new Date(\`\${isoDate}T00:00:00Z\`);
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return date.toISOString().slice(0, 10);
}
`;

const PARSE_JS = `/** Parses "sku;qty;unitPriceCents" lines. */

export function parseLine(line) {
  const [sku, qty, price] = line.split(';').map((part) => part.trim());
  return { sku, qty: Number(qty), unitPriceCents: Number(price) };
}

export function parseLines(text) {
  return text
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(parseLine);
}
`;

const VALIDATE_JS = `/** Drops lines that cannot be billed. */

export function isBillable(line) {
  return typeof line.sku === 'string' && line.sku !== '' && Number.isInteger(line.qty) && line.qty > 0 && line.unitPriceCents >= 0;
}

export function billable(lines) {
  return lines.filter(isBillable);
}
`;

const TOTAL_JS = `/** Totals with an optional percentage discount. */

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.qty * line.unitPriceCents, 0);
}

export function total(lines, discountPercent = 0) {
  const gross = subtotal(lines);
  const discount = Math.round((gross * discountPercent) / 100);
  return gross - discount;
}
`;

const PIPELINE_INDEX_JS = `import { parseLines } from './parse.js';
import { billable } from './validate.js';
import { total } from './total.js';

/** Parses a price list, keeps billable lines and returns the total in cents. */
export function runPipeline(text, discountPercent = 0) {
  const lines = billable(parseLines(text));
  return { lines: lines.length, totalCents: total(lines, discountPercent) };
}
`;

function featureJs(name: string, rng: Rng): string {
  const fn = `describe${pascal(name)}`;
  const fee = rng.int(0, 499);
  return `import { formatCurrency } from '../lib/money.js';

/** Human-readable ${name.replace(/-/g, ' ')} line. */
export function ${fn}(order) {
  const cents = order.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0) + ${fee};
  return \`${name} \${order.id}: \${formatCurrency(cents)}\`;
}
`;
}

function handlerJs(name: string): string {
  return `import { formatCurrency } from '../lib/money.js';

export const TIMEOUT_MS = 3000;

/** Handles ${name} requests. */
export function handle${pascal(name)}(request) {
  const amount = request.amountCents ?? 0;
  return { route: '/${name}', timeoutMs: TIMEOUT_MS, amount: formatCurrency(amount) };
}
`;
}

const MONEY_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency, sumCents } from '../src/lib/money.js';

test('formats dollars and cents', () => {
  assert.equal(formatCurrency(123456), '$1234.56');
  assert.equal(formatCurrency(5), '$0.05');
});

test('formats negative amounts and other currencies', () => {
  assert.equal(formatCurrency(-250, 'EUR'), '-€2.50');
  assert.equal(formatCurrency(100, 'JPY'), 'JPY 1.00');
});

test('sums cents', () => {
  assert.equal(sumCents([1, 2, 3]), 6);
});
`;

const STRINGS_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, titleCase, truncate } from '../src/lib/strings.js';

test('slugify collapses separators', () => {
  assert.equal(slugify('  Hello,  World! '), 'hello-world');
});

test('titleCase capitalizes words', () => {
  assert.equal(titleCase('fresh green apples'), 'Fresh Green Apples');
});

test('truncate keeps the result within max', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 5), 'abc');
});
`;

const PIPELINE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../src/pipeline/parse.js';
import { runPipeline } from '../src/pipeline/index.js';

const LIST = [
  '# sku;qty;unitPriceCents',
  'SKU-APPLE;2;150',
  'SKU-BREAD ; 1 ; 300',
  'SKU-EGGS;0;999',
  'SKU-HONEY;3;1000',
].join('\\n');

test('parseLine reads the three fields', () => {
  assert.deepEqual(parseLine('SKU-APPLE;2;150'), { sku: 'SKU-APPLE', qty: 2, unitPriceCents: 150 });
});

test('parseLine trims whitespace around fields', () => {
  assert.deepEqual(parseLine(' SKU-BREAD ; 1 ; 300 '), { sku: 'SKU-BREAD', qty: 1, unitPriceCents: 300 });
});

test('pipeline drops lines with zero quantity', () => {
  assert.equal(runPipeline(LIST).lines, 3);
});

test('pipeline applies the discount', () => {
  assert.equal(runPipeline(LIST, 10).totalCents, 3240);
});

test('pipeline totals the price list', () => {
  assert.equal(runPipeline(LIST).totalCents, 3600);
});
`;

function featuresTest(features: readonly string[]): string {
  const picked = features.slice(0, 3);
  const imports = picked.map((f) => `import { describe${pascal(f)} } from '../src/features/${f}.js';`).join('\n');
  const checks = picked.map((f) => `  assert.match(describe${pascal(f)}(order), /^${f} ORD-T: \\$\\d+\\.\\d\\d$/);`).join('\n');
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
${imports}

const order = { id: 'ORD-T', items: [{ sku: 'SKU-APPLE', qty: 2, unitPriceCents: 150 }] };

test('feature descriptions include a formatted amount', () => {
${checks}
});
`;
}

const HANDLERS_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOrders } from '../src/handlers/orders.js';
import { handleHealth } from '../src/handlers/health.js';

test('handlers report their route and a positive timeout', () => {
  const res = handleOrders({ amountCents: 1999 });
  assert.equal(res.route, '/orders');
  assert.equal(res.amount, '$19.99');
  assert.ok(handleHealth({}).timeoutMs > 0);
});
`;

/** Generates the fixture tree and its facts from a seed. */
export function generateFixture(seed: number = DEFAULT_FIXTURE_SEED): Fixture {
  const rng = new Rng(seed);
  const files: Tree = new Map();

  const retryLimit = rng.int(3, 12);
  files.set('package.json', json({ name: 'acme-orders', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }));
  files.set('README.md', '# acme-orders\n\nOrder tooling for the Acme storefront. Run the tests with `npm test` (Node >= 22, no install needed).\n');
  files.set(
    'config/app.json',
    json({
      service: { name: 'acme-orders', port: rng.int(3000, 9000), retryLimit, timeoutMs: rng.int(2, 9) * 1000 },
      features: { refunds: true, giftCards: rng.next() < 0.5, loyalty: true },
      logging: { level: 'info', retainDays: rng.int(7, 90) },
    }),
  );
  files.set('config/regions.json', json({ regions: ['domestic', 'nearby', 'international'], defaultRegion: 'domestic', retryLimit: retryLimit + 5 }));

  files.set('src/lib/money.js', MONEY_JS);
  files.set('src/lib/strings.js', STRINGS_JS);
  files.set('src/lib/shipping.js', shippingJs(rng.int(300, 900), rng.int(50, 250)));
  files.set('src/lib/sku.js', SKU_JS);
  files.set('src/lib/dates.js', DATES_JS);

  files.set('src/pipeline/parse.js', PARSE_JS);
  files.set('src/pipeline/validate.js', VALIDATE_JS);
  files.set('src/pipeline/total.js', TOTAL_JS);
  files.set('src/pipeline/index.js', PIPELINE_INDEX_JS);

  for (const feature of FEATURES) files.set(`src/features/${feature}.js`, featureJs(feature, rng));
  for (const handler of HANDLERS) files.set(`src/handlers/${handler}.js`, handlerJs(handler));

  files.set('test/money.test.js', MONEY_TEST);
  files.set('test/strings.test.js', STRINGS_TEST);
  files.set('test/pipeline.test.js', PIPELINE_TEST);
  files.set('test/features.test.js', featuresTest(FEATURES));
  files.set('test/handlers.test.js', HANDLERS_TEST);

  // Regenerate orders until the top 3 customers are unambiguous (deterministic: same rng stream).
  let orders = buildOrders(rng);
  while (!topIsUnambiguous(customerTotals(orders))) orders = buildOrders(rng);
  const orderFiles: string[] = [];
  for (const order of orders) {
    const file = `data/orders/${order.id.toLowerCase()}.json`;
    orderFiles.push(file);
    files.set(file, json(order));
  }

  const sorted = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const renameFiles = [...sorted.entries()].filter(([, text]) => /\bformatCurrency\b/.test(text)).map(([file]) => file);
  const protectedHandler = HANDLERS[rng.int(1, HANDLERS.length - 2)] ?? 'reports';

  return {
    files: sorted,
    facts: {
      seed,
      retryLimit,
      signatures: [
        { name: 'computeShippingQuote', file: 'src/lib/shipping.js', signature: 'computeShippingQuote(order, zone, options = {})' },
        { name: 'normalizeSku', file: 'src/lib/sku.js', signature: 'normalizeSku(raw, strict = false)' },
      ],
      customerTotals: customerTotals(orders),
      renameFrom: 'formatCurrency',
      renameTo: 'formatMoney',
      renameFiles,
      orderFiles,
      paidOrderFiles: orders.filter((o) => o.status === 'paid').map((o) => `data/orders/${o.id.toLowerCase()}.json`),
      handlerFiles: HANDLERS.map((h) => `src/handlers/${h}.js`),
      protectedFile: `src/handlers/${protectedHandler}.js`,
    },
  };
}

/** SHA-256 over the sorted (path, content) pairs. */
export function treeHash(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const file of [...files.keys()].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(files.get(file) ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Writes a tree under `dir` (which must exist or be creatable). */
export async function writeTree(dir: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const [file, text] of files) {
    const target = path.join(dir, ...file.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
}

// `node bench/fixture/generate.ts <dir> [seed]` writes the fixture and prints its hash.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write('usage: node bench/fixture/generate.ts <dir> [seed]\n');
    process.exitCode = 2;
  } else {
    const seed = process.argv[3] === undefined ? DEFAULT_FIXTURE_SEED : Number(process.argv[3]);
    const fixture = generateFixture(seed);
    await writeTree(dir, fixture.files);
    process.stdout.write(`${fixture.files.size} files, sha256 ${treeHash(fixture.files)}\n`);
  }
}
