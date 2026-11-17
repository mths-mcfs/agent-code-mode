import { request } from '../../lib/http.js';
import { NOTIFY } from '../config.js';

export async function sendEmail(to, template, vars = {}) {
  const res = await request({
    method: 'POST',
    url: `${NOTIFY}/email`,
    headers: { 'content-type': 'application/json' },
    body: { to, template, vars },
  });
  return res.body.messageId;
}
