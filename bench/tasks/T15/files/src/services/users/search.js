import { legacyFetch as get } from '../../lib/legacy-http.js';
import { API } from '../config.js';

/** Searches users by name or email. With a token the search also covers deactivated users. */
export async function findUsers(query, { token, limit = 10 } = {}) {
  const options = { qs: { q: query, limit } };
  if (token) options.headers = { authorization: `Bearer ${token}` };
  const res = await get(`${API}/users/search`, options);
  return res.data.users;
}
