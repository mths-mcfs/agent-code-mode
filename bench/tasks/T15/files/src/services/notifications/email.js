import { legacyFetch } from '../../lib/legacy-http.js';
import { NOTIFY } from '../config.js';

export async function sendEmail(to, template, vars = {}) {
  const res = await legacyFetch(`${NOTIFY}/email`, { method: 'POST', json: { to, template, vars } });
  return res.data.messageId;
}
