import { writeFile } from "node:fs/promises";
import path from "node:path";

const [agent, repository] = process.argv.slice(2);
if (!["careful", "fast"].includes(agent) || !repository) throw new Error("Expected a scripted agent and worktree path");
const startedAt = new Date().toISOString();
const quantityCheck = agent === "careful"
  ? "!Number.isSafeInteger(item.quantity) || item.quantity <= 0"
  : "!Number.isSafeInteger(item.quantity)";
const source = `// ${agent === "careful" ? "Validate the full checkout contract before accumulating cents." : "Validate integer inputs before accumulating cents."}
export function checkoutTotal(items) {
  if (!Array.isArray(items)) throw new TypeError("Cart must be an array");
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Each item must be a record");
    if (!Number.isSafeInteger(item.unitCents) || item.unitCents < 0) throw new RangeError("Price must be nonnegative integer cents");
    if (${quantityCheck}) throw new RangeError("Quantity must be a positive safe integer");
    const lineTotal = item.unitCents * item.quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(total + lineTotal)) throw new RangeError("Total exceeds safe integer cents");
    total += lineTotal;
  }
  return total;
}
`;
await writeFile(path.join(repository, "checkout.mjs"), source, { encoding: "utf8", flag: "w" });
console.log(JSON.stringify({ agent, startedAt, finishedAt: new Date().toISOString(), changedFiles: ["checkout.mjs"], mode: "scripted-local-agent" }));
