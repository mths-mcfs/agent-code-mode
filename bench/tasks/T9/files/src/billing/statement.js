import { buildInvoice } from './invoice.js';

/** Statements stop before the invoice that would take the running total over this limit. */
export const CREDIT_LIMIT_CENTS = 500000;

/** Builds a customer statement: each invoice is checked against the credit limit, then emitted. */
export function buildStatement(orders, region = 'domestic') {
  const invoices = [];
  let totalCents = 0;
  for (const order of orders) {
    const preview = buildInvoice(order, region);
    if (totalCents + preview.totalCents > CREDIT_LIMIT_CENTS) break;
    const invoice = buildInvoice(order, region);
    invoices.push(invoice);
    totalCents += invoice.totalCents;
  }
  return { region, invoices, totalCents };
}
