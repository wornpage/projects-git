// Explicit scripted fixture. This source is never reported as model generation.
export function checkoutTotal(items) {
  if (!Array.isArray(items)) throw new TypeError('Cart must be an array');
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Item must be a record');
    if (!Number.isSafeInteger(item.unitCents) || item.unitCents < 0) throw new RangeError('Invalid price');
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new RangeError('Invalid quantity');
    const line = item.unitCents * item.quantity;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(total + line)) throw new RangeError('Unsafe total');
    total += line;
  }
  return total;
}
