import { request } from '../../lib/http.js';
import { NOTIFY } from '../config.js';

export async function getTemplate(name, locale = 'en') {
  return (await request({ url: `${NOTIFY}/templates/${name}`, query: { locale } })).body;
}

export async function renderTemplate(name, vars) {
  const res = await request({
    method: 'POST',
    url: `${NOTIFY}/templates/${name}/render`,
    headers: { 'content-type': 'application/json' },
    body: vars,
  });
  return res.body.html;
}
