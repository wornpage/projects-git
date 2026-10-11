// Starting point: the task is to add safe integer-cent arithmetic and validation.
export function checkoutTotal(items) {
  return items.reduce((total, item) => total + item.unitCents * item.quantity, 0);
}
