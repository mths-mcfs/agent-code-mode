import { legacyJson } from '../../lib/legacy-http.js';
import { NOTIFY } from '../config.js';

export function getTemplate(name, locale = 'en') {
  return legacyJson(`${NOTIFY}/templates/${name}`, { qs: { locale } });
}

export async function renderTemplate(name, vars) {
  const out = await legacyJson(`${NOTIFY}/templates/${name}/render`, { method: 'POST', json: vars });
  return out.html;
}
