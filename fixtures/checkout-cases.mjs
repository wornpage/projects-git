// Expected outcomes stay in the controller, outside the candidate sandbox.
const valid = (name, input, value) => ({ name, trials: [{ input, value }] });
const invalid = (name, inputs) => ({ name, trials: inputs.map(input => ({ input, throws: true })) });
export const checkoutCases = [
  valid('Empty cart is zero cents', [], 0),
  valid('Multiple items sum in integer cents', [{ unitCents: 1299, quantity: 2 }, { unitCents: 250, quantity: 3 }], 3348),
  valid('Zero-price item remains valid', [{ unitCents: 0, quantity: 2 }], 0),
  valid('Largest safe total is preserved', [{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 }], Number.MAX_SAFE_INTEGER),
  invalid('Non-array carts are rejected', [null, {}, 'cart']),
  invalid('Invalid item records are rejected', [null, 1, [], 'item'].map(value => [value])),
  invalid('Negative prices are rejected', [[{ unitCents: -1, quantity: 2 }]]),
  invalid('Fractional prices are rejected', [[{ unitCents: 10.5, quantity: 2 }]]),
  invalid('String and missing prices are rejected', ['100', undefined].map(unitCents => [{ unitCents, quantity: 2 }])),
  invalid('Zero quantities are rejected', [[{ unitCents: 100, quantity: 0 }]]),
  invalid('Negative quantities are rejected', [[{ unitCents: 100, quantity: -2 }]]),
  invalid('Fractional quantities are rejected', [[{ unitCents: 100, quantity: 1.5 }]]),
  invalid('String and missing quantities are rejected', ['2', undefined].map(quantity => [{ unitCents: 100, quantity }])),
  invalid('Non-finite and unsafe integers are rejected', [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap(value => [[{ unitCents: value, quantity: 1 }], [{ unitCents: 1, quantity: value }]])),
  invalid('Multiplication overflow is rejected', [[{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }]]),
  invalid('Accumulation overflow is rejected', [[{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 }, { unitCents: 1, quantity: 1 }]]),
];

export function encodeInput(value) {
  if (value === undefined) return { $special: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $special: String(value) };
  if (Array.isArray(value)) return value.map(encodeInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeInput(entry)]));
  return value;
}

export function scoreCheckout(output) {
  let responses;
  try { responses = JSON.parse(output); }
  catch { responses = null; }
  let offset = 0;
  const complete = Array.isArray(responses) && responses.length === checkoutCases.reduce((sum, item) => sum + item.trials.length, 0);
  const checks = checkoutCases.map(({ name, trials }) => {
    const outcomes = trials.map(trial => {
      const response = responses?.[offset++];
      return complete && response && (trial.throws ? response.threw === true : response.threw === false && response.value === trial.value);
    });
    const passed = outcomes.every(Boolean);
    return { name, passed, detail: passed ? 'Matched independent expected behavior' : 'Candidate response did not match the independent expected behavior' };
  });
  return { checks, passed: checks.filter(check => check.passed).length, total: checks.length };
}
