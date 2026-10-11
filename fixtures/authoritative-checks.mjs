import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("An exact checkout module path is required");
const { checkoutTotal } = await import(pathToFileURL(modulePath).href);
const cases = [
  ["Empty cart is zero cents", () => assert.equal(checkoutTotal([]), 0)],
  ["Multiple items sum in integer cents", () => assert.equal(checkoutTotal([{ unitCents: 1299, quantity: 2 }, { unitCents: 250, quantity: 3 }]), 3348)],
  ["Zero-price item remains valid", () => assert.equal(checkoutTotal([{ unitCents: 0, quantity: 2 }]), 0)],
  ["Largest safe total is preserved", () => assert.equal(checkoutTotal([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 }]), Number.MAX_SAFE_INTEGER)],
  ["Non-array carts are rejected", () => { for (const value of [null, {}, "cart"]) assert.throws(() => checkoutTotal(value)); }],
  ["Invalid item records are rejected", () => { for (const value of [null, 1, [], "item"]) assert.throws(() => checkoutTotal([value])); }],
  ["Negative prices are rejected", () => assert.throws(() => checkoutTotal([{ unitCents: -1, quantity: 2 }] ))],
  ["Fractional prices are rejected", () => assert.throws(() => checkoutTotal([{ unitCents: 10.5, quantity: 2 }] ))],
  ["String and missing prices are rejected", () => { for (const unitCents of ["100", undefined]) assert.throws(() => checkoutTotal([{ unitCents, quantity: 2 }])); }],
  ["Zero quantities are rejected", () => assert.throws(() => checkoutTotal([{ unitCents: 100, quantity: 0 }] ))],
  ["Negative quantities are rejected", () => assert.throws(() => checkoutTotal([{ unitCents: 100, quantity: -2 }] ))],
  ["Fractional quantities are rejected", () => assert.throws(() => checkoutTotal([{ unitCents: 100, quantity: 1.5 }] ))],
  ["String and missing quantities are rejected", () => { for (const quantity of ["2", undefined]) assert.throws(() => checkoutTotal([{ unitCents: 100, quantity }])); }],
  ["Non-finite and unsafe integers are rejected", () => { for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) { assert.throws(() => checkoutTotal([{ unitCents: value, quantity: 1 }])); assert.throws(() => checkoutTotal([{ unitCents: 1, quantity: value }])); } }],
  ["Multiplication overflow is rejected", () => assert.throws(() => checkoutTotal([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }] ))],
  ["Accumulation overflow is rejected", () => assert.throws(() => checkoutTotal([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 }, { unitCents: 1, quantity: 1 }] ))],
];

const checks = [];
for (const [name, check] of cases) {
  try {
    check();
    checks.push({ name, passed: true, detail: "Passed against the independent checkout" });
  } catch (error) {
    checks.push({ name, passed: false, detail: error.message });
  }
}
const passed = checks.filter((check) => check.passed).length;
for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}${check.passed ? "" : `: ${check.detail}`}`);
console.log(`PROJECTS_CHECKS:${JSON.stringify({ passed, total: checks.length, checks })}`);
process.exitCode = passed === checks.length ? 0 : 1;
