/** Price formatting for the catalog. Amounts are integer cents. */

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

export function formatPrice(cents, { currency = 'USD', symbol = true } = {}) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const amount = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  if (!symbol) return `${sign}${amount} ${currency}`;
  return `${sign}${SYMBOLS[currency] ?? `${currency} `}${amount}`;
}
