import { legacyJson as fetchJson } from '../../lib/legacy-http.js';
import { API } from '../config.js';

export async function listNotes(orderId) {
  const page = await fetchJson(`${API}/orders/${orderId}/notes`, { qs: { order: 'newest' } });
  return page.notes;
}

export function addNote(orderId, text, author) {
  return fetchJson(`${API}/orders/${orderId}/notes`, { method: 'Post', json: { text, author } });
}
