import { request } from '../../lib/http.js';
import { API } from '../config.js';

export async function getInvoice(id) {
  const { body } = await request({ url: `${API}/invoices/${id}`, headers: { accept: 'application/json' } });
  return body;
}

export async function listInvoices(customerId, { from, to } = {}) {
  const { body } = await request({ url: `${API}/invoices`, query: { customer: customerId, from, to } });
  return body.invoices;
}
