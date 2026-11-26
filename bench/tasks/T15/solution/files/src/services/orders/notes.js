import { request } from '../../lib/http.js';
import { API } from '../config.js';

export async function listNotes(orderId) {
  const page = (await request({ url: `${API}/orders/${orderId}/notes`, query: { order: 'newest' } })).body;
  return page.notes;
}

export async function addNote(orderId, text, author) {
  const res = await request({
    method: 'POST',
    url: `${API}/orders/${orderId}/notes`,
    headers: { 'content-type': 'application/json' },
    body: { text, author },
  });
  return res.body;
}
