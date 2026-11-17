import { request } from '../../lib/http.js';
import { API } from '../config.js';

/** Uploads an avatar. `image` is the base64 text of the file and `mime` its type, e.g. image/png. */
export async function uploadAvatar(userId, image, mime) {
  const res = await request({
    method: 'PUT',
    url: `${API}/users/${userId}/avatar`,
    body: image,
    headers: { 'Content-Type': mime, 'x-encoding': 'base64' },
  });
  return res.body.url;
}
