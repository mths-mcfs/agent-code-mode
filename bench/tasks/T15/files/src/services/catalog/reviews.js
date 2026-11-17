import { legacyFetch } from '../../lib/legacy-http.js';
import { API } from '../config.js';

export async function listReviews(productId, { rating, cursor } = {}) {
  const opts = { qs: { product: productId } };
  if (rating !== undefined) opts.qs.rating = rating;
  if (cursor) opts.qs.cursor = cursor;
  const res = await legacyFetch(`${API}/reviews`, opts);
  return { items: res.data.items, next: res.data.next ?? null };
}

/** Returns true when the review was accepted (201) and false when it was held for moderation (202). */
export async function postReview(productId, review) {
  const res = await legacyFetch(`${API}/reviews`, {
    method: 'post',
    json: { product: productId, rating: review.rating, text: review.text },
  });
  return res.status === 201;
}
