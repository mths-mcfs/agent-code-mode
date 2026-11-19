import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

export async function getInvoice(id) {
  const { data } = await legacyFetch(`${API}/invoices/${id}`, { headers: { accept: 'application/json' } });
  return data;
}

export async function listInvoices(customerId, { from, to } = {}) {
  const { data } = await legacyFetch(`${API}/invoices`, { qs: { customer: customerId, from, to } });
  return data.invoices;
}
