import { HttpError, request } from '../../lib/http.js';
import { API } from '../config.js';

export async function listReviews(productId, { rating, cursor } = {}) {
  const query = { product: productId };
  if (rating !== undefined) query.rating = rating;
  if (cursor) query.cursor = cursor;
  const res = await request({ url: `${API}/reviews`, query });
  return { items: res.body.items, next: res.body.next ?? null };
}

/** Returns true when the review was accepted (201) and false when it was held for moderation (202). */
export async function postReview(productId, review) {
  try {
    const res = await request({
      method: 'POST',
      url: `${API}/reviews`,
      headers: { 'content-type': 'application/json' },
      body: { product: productId, rating: review.rating, text: review.text },
    });
    return res.status === 201;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}
