import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

/** Returns the order, or null when it does not exist. */
export async function findOrder(id) {
  try {
    const res = await request({ url: `${API}/orders/${id}` });
    return res.body;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return err.status === 404 ? null : err.body;
  }
}

/** Orders of a customer, optionally only those in one status. */
export async function listOrdersFor(customerId, status) {
  const res = await request({ url: `${API}/orders`, query: { customer: customerId, status } });
  return res.body.orders;
}
