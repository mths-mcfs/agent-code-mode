import { Rng } from '../../lib/rng.ts';

/**
 * T16 data: a small order system that lives only in the memory of the `orders` MCP server
 * (server.ts), generated from a seed, never written to the workspace. 16 customers with 6 to 12 orders
 * each; about one order in seven has refunds. A refund counts by its own date (it can belong to an order
 * placed months earlier) and only when it succeeded; refunds of other quarters and failed ones are the
 * decoys. Each record carries the kind of descriptive fields real APIs return, so a page of results is
 * several kilobytes: reading every page into the model's context is what a script avoids.
 */

export const T16_QUARTER = { label: 'Q2 2026', from: '2026-04-01', to: '2026-06-30' } as const;
/** Customers per `list_customers` page. */
export const CUSTOMER_PAGE_SIZE = 8;
/** Orders per `list_orders` page. */
export const ORDER_PAGE_SIZE = 8;

const CUSTOMERS = 16;
const FIRST = ['Ada', 'Bruno', 'Carla', 'Diego', 'Elena', 'Felix', 'Gina', 'Hugo', 'Iris', 'Jonas', 'Kara', 'Luis', 'Mira', 'Nico', 'Olga', 'Pablo', 'Quinn', 'Rosa'];
const LAST = ['Almeida', 'Becker', 'Costa', 'Dubois', 'Esposito', 'Fischer', 'Garcia', 'Hansen', 'Ivanova', 'Jensen', 'Kowalski', 'Lopez', 'Moreau', 'Novak', 'Oliveira', 'Petrov'];
const CITIES = ['Lisbon', 'Porto', 'Lyon', 'Turin', 'Gdansk', 'Leipzig', 'Ghent', 'Bilbao', 'Malmo', 'Brno'];
const PRODUCTS = [
  { sku: 'KB-101', name: 'Mechanical keyboard, tenkeyless', cents: 8900 },
  { sku: 'MS-220', name: 'Wireless mouse', cents: 3450 },
  { sku: 'MN-270', name: '27 inch monitor, IPS', cents: 23900 },
  { sku: 'HD-050', name: 'USB-C hub, 7 ports', cents: 4590 },
  { sku: 'CB-010', name: 'Braided cable, 2 m', cents: 1290 },
  { sku: 'DK-330', name: 'Standing desk frame', cents: 31900 },
  { sku: 'CH-410', name: 'Ergonomic chair', cents: 27900 },
  { sku: 'LP-090', name: 'Laptop stand, aluminium', cents: 3990 },
  { sku: 'HS-600', name: 'Headset with boom mic', cents: 7490 },
  { sku: 'WC-120', name: 'Webcam 1080p', cents: 5690 },
];
const STATUSES = ['delivered', 'delivered', 'delivered', 'shipped', 'processing', 'cancelled'] as const;
const REASONS = ['damaged in transit', 'wrong item', 'late delivery', 'not as described', 'changed mind'];
const CARRIERS = ['DHL', 'UPS', 'GLS', 'DPD', 'PostNL'];

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly tier: 'standard' | 'plus' | 'business';
  readonly createdAt: string;
  readonly address: { readonly street: string; readonly city: string; readonly postalCode: string; readonly country: string };
  readonly preferences: { readonly newsletter: boolean; readonly language: string; readonly currency: 'USD' };
  readonly notes: string;
  readonly contacts: readonly { readonly role: string; readonly name: string; readonly email: string; readonly phone: string }[];
  readonly billing: { readonly vatId: string; readonly paymentTerms: string; readonly creditLimitCents: number; readonly invoiceEmail: string };
}

export interface OrderItem {
  readonly line: number;
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPriceCents: number;
}

export interface Refund {
  readonly refundId: string;
  /** UTC date the refund was issued (YYYY-MM-DD). */
  readonly date: string;
  readonly amountCents: number;
  readonly status: 'succeeded' | 'failed';
  readonly reason: string;
  readonly lines: readonly number[];
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  /** UTC date the order was placed (YYYY-MM-DD). */
  readonly orderDate: string;
  readonly status: (typeof STATUSES)[number] | 'refunded' | 'partially_refunded';
  readonly currency: 'USD';
  readonly items: readonly OrderItem[];
  readonly refunds: readonly Refund[];
  readonly shipping: { readonly carrier: string; readonly trackingNumber: string; readonly city: string; readonly service: string };
  readonly events: readonly { readonly at: string; readonly type: string; readonly note: string }[];
  readonly payments: readonly { readonly paymentId: string; readonly method: string; readonly amountCents: number; readonly capturedAt: string; readonly processorReference: string }[];
}

export interface T16Data {
  readonly customers: readonly Customer[];
  readonly orders: readonly Order[];
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

/** A UTC date between 2026-01-02 and 2026-09-28. */
function dateIn(rng: Rng, fromDay: number, toDay: number): string {
  const day = rng.int(fromDay, toDay);
  return new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
}


function generate(seed: number): T16Data {
  const rng = new Rng(seed * 131 + 16);
  const customers: Customer[] = [];
  const orders: Order[] = [];
  let orderSeq = 1000;
  let refundSeq = 1;
  for (let c = 1; c <= CUSTOMERS; c++) {
    const first = FIRST[(c * 7 + seed) % FIRST.length] ?? 'Ada';
    const last = LAST[(c * 5 + seed) % LAST.length] ?? 'Almeida';
    const id = `C-${pad(c * 37 + rng.int(0, 30), 4)}`;
    customers.push({
      id,
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${c}@example.com`,
      tier: rng.pick(['standard', 'plus', 'business'] as const),
      createdAt: `202${rng.int(2, 5)}-${pad(rng.int(1, 12), 2)}-${pad(rng.int(1, 28), 2)}`,
      address: { street: `${rng.int(1, 240)} ${rng.pick(['Market', 'Harbour', 'Station', 'Garden', 'Mill'])} Street`, city: rng.pick(CITIES), postalCode: pad(rng.int(1000, 99999), 5), country: 'EU' },
      preferences: { newsletter: rng.next() < 0.5, language: rng.pick(['en', 'pt', 'de', 'fr', 'es']), currency: 'USD' },
      contacts: ['purchasing', 'finance', 'operations'].map((role, i) => ({
        role,
        name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
        email: `${role}.${c}.${i}@example.com`,
        phone: `+351 2${pad(rng.int(0, 99_999_999), 8)}`,
      })),
      billing: { vatId: `EU${pad(rng.int(0, 999_999_999), 9)}`, paymentTerms: rng.pick(['net 15', 'net 30', 'net 45', 'prepaid']), creditLimitCents: rng.int(5, 80) * 100_000, invoiceEmail: `invoices.${c}@example.com` },
      notes: `Account managed by the ${rng.pick(['north', 'south', 'central'])} desk. Prefers ${rng.pick(['email', 'phone', 'chat'])} contact; invoices consolidated monthly. Loyalty programme since onboarding; no open disputes on record.`,
    });
    const count = rng.int(5, 9);
    for (let o = 0; o < count; o++) {
      const orderDay = rng.int(1, 270);
      const orderDate = dateIn(rng, orderDay, orderDay);
      const items: OrderItem[] = [];
      const lines = rng.int(2, 6);
      for (let l = 1; l <= lines; l++) {
        const p = rng.pick(PRODUCTS);
        items.push({ line: l, sku: p.sku, name: p.name, qty: rng.int(1, 4), unitPriceCents: p.cents });
      }
      const refunds: Refund[] = [];
      let status: Order['status'] = rng.pick(STATUSES);
      if (rng.next() < 0.11) {
        const n = rng.int(1, 3);
        for (let r = 0; r < n; r++) {
          const line = rng.pick(items);
          const date = dateIn(rng, Math.min(orderDay + 3, 272), Math.min(orderDay + 110, 272));
          refunds.push({
            refundId: `RF-${pad(refundSeq++, 5)}`,
            date,
            amountCents: line.unitPriceCents * rng.int(1, line.qty),
            status: rng.next() < 0.2 ? 'failed' : 'succeeded',
            reason: rng.pick(REASONS),
            lines: [line.line],
          });
        }
        status = refunds.length > 1 || rng.next() < 0.4 ? 'refunded' : 'partially_refunded';
      }
      const carrier = rng.pick(CARRIERS);
      orders.push({
        id: `O-${orderSeq++}`,
        customerId: id,
        orderDate,
        status,
        currency: 'USD',
        items,
        refunds,
        shipping: { carrier, trackingNumber: `${carrier.slice(0, 2)}${pad(rng.int(0, 99_999_999), 8)}`, city: rng.pick(CITIES), service: rng.pick(['standard', 'express', 'economy']) },
        payments: [
          { paymentId: `PY-${orderSeq}-1`, method: rng.pick(['card', 'bank transfer', 'invoice']), amountCents: items.reduce((sum, it) => sum + it.qty * it.unitPriceCents, 0), capturedAt: `${orderDate}T09:30:00Z`, processorReference: `ch_${pad(rng.int(0, 999_999_999), 9)}${pad(rng.int(0, 999_999), 6)}` },
        ],
        events: [
          { at: `${orderDate}T09:${pad(rng.int(0, 59), 2)}:00Z`, type: 'placed', note: 'Order placed through the web shop; payment authorized.' },
          { at: `${orderDate}T15:${pad(rng.int(0, 59), 2)}:00Z`, type: 'packed', note: `Packed at the ${rng.pick(['Lisbon', 'Leipzig', 'Brno'])} warehouse; ${items.length} line(s).` },
          ...refunds.map((r) => ({ at: `${r.date}T11:00:00Z`, type: r.status === 'failed' ? 'refund_failed' : 'refund_issued', note: `Refund ${r.refundId} (${r.reason}).` })),
        ],
      });
    }
  }
  return { customers, orders };
}

/** Total of a customer's succeeded refunds dated inside the quarter. */
export function refundedInQuarter(data: T16Data): Map<string, number> {
  const totals = new Map<string, number>();
  for (const o of data.orders) {
    for (const r of o.refunds) {
      if (r.status !== 'succeeded' || r.date < T16_QUARTER.from || r.date > T16_QUARTER.to) continue;
      totals.set(o.customerId, (totals.get(o.customerId) ?? 0) + r.amountCents);
    }
  }
  return totals;
}

/** The ranking the task asks for, highest first (ties broken by customer id, but the seed is chosen so the top 4 are distinct). */
export function topRefunded(data: T16Data, n = 3): { customerId: string; cents: number }[] {
  return [...refundedInQuarter(data)]
    .map(([customerId, cents]) => ({ customerId, cents }))
    .sort((a, b) => b.cents - a.cents || a.customerId.localeCompare(b.customerId))
    .slice(0, n);
}

/**
 * The data for a fixture seed: the first variant whose top four quarter totals are distinct and whose
 * decoys matter (counting failed refunds, or refunds by order date, would change the top three).
 */
export function t16Data(seed: number): T16Data {
  for (let k = 0; k < 1_000; k++) {
    const data = generate(seed + k * 7_919);
    const top = topRefunded(data, 4);
    if (top.length < 4 || new Set(top.map((t) => t.cents)).size < 4) continue;
    const key = (rows: { customerId: string }[]): string => rows.map((r) => r.customerId).join(',');
    const naive = (pick: (o: Order, r: Refund) => boolean): string => {
      const totals = new Map<string, number>();
      for (const o of data.orders) for (const r of o.refunds) if (pick(o, r)) totals.set(o.customerId, (totals.get(o.customerId) ?? 0) + r.amountCents);
      return key([...totals].map(([customerId, cents]) => ({ customerId, cents })).sort((a, b) => b.cents - a.cents).slice(0, 3));
    };
    const inQ = (d: string): boolean => d >= T16_QUARTER.from && d <= T16_QUARTER.to;
    const right = key(top.slice(0, 3));
    if (naive((_o, r) => inQ(r.date)) === right) continue; // failed refunds must matter
    if (naive((o, r) => r.status === 'succeeded' && inQ(o.orderDate)) === right) continue; // the refund date must matter
    return data;
  }
  throw new Error(`no usable T16 data for seed ${seed}`);
}

/** `12345` cents as `123.45`. */
export function dollars(cents: number): string {
  return `${Math.floor(cents / 100)}.${pad(cents % 100, 2)}`;
}

