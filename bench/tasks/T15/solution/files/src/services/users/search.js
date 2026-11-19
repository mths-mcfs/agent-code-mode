import { request } from '../../lib/http.js';
import { API } from '../config.js';

/** Searches users by name or email. With a token the search also covers deactivated users. */
export async function findUsers(query, { token, limit = 10 } = {}) {
  const options = { url: `${API}/users/search`, query: { q: query, limit } };
  if (token) options.headers = { authorization: `Bearer ${token}` };
  const res = await request(options);
  return res.body.users;
}
