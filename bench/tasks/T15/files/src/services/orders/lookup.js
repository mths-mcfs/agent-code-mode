import { legacyFetch as http } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Returns the order, or null when it does not exist. */
export async function findOrder(id) {
  const res = await http(`${API}/orders/${id}`);
  return res.status === 404 ? null : res.data;
}

/** Orders of a customer, optionally only those in one status. */
export async function listOrdersFor(customerId, status) {
  const res = await http(`${API}/orders`, { qs: { customer: customerId, status } });
  return res.data.orders;
}
