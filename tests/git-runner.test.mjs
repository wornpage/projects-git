import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitRunner } from "../src/local/git-runner.mjs";

const execFileAsync = promisify(execFile);
async function git(repository, ...args) {
  const { stdout } = await execFileAsync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Test", "-c", "user.email=test@localhost.invalid", ...args], { cwd: repository, shell: false, timeout: 15000, windowsHide: true });
  return stdout.trim();
}

async function setup(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "projects-agent-git-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const runner = new GitRunner({ rootDir });
  const demo = await runner.createDemoRepository("checkout-task");
  return { rootDir, runner, ...demo };
}

test("concurrent scripted processes produce isolated real commits and independently different outcomes", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const [careful, fast] = await Promise.all([
    runner.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" }),
    runner.runCandidate({ repository, baseCommit, runId: "fast-run", agent: "fast" }),
  ]);
  assert.notEqual(careful.headCommit, fast.headCommit);
  assert.equal(await git(repository, "rev-parse", "HEAD"), baseCommit);
  assert.equal(await git(repository, "rev-parse", "newwork/careful-run"), careful.headCommit);
  assert.equal(await git(repository, "rev-parse", "newwork/fast-run"), fast.headCommit);
  assert.equal(await git(repository, "rev-parse", `${careful.headCommit}^`), baseCommit);
  assert.equal(await git(repository, "rev-parse", `${fast.headCommit}^`), baseCommit);
  assert.deepEqual(careful.changedFiles, ["checkout.mjs"]);
  assert.ok(careful.diff.includes("Quantity must be a positive safe integer"));
  assert.deepEqual([careful.evidence.passed, careful.evidence.total, careful.evidence.exitCode], [16, 16, 0]);
  assert.deepEqual([fast.evidence.passed, fast.evidence.total, fast.evidence.exitCode], [14, 16, 1]);
  assert.equal(careful.evidence.commit, careful.headCommit);
  assert.equal(careful.evidence.source, "independent-local-checks");
  assert.equal(careful.evidence.verified, true);
  assert.match(careful.evidence.command, /authoritative-checks\.mjs/);
  assert.match(careful.evidence.output, /PASS Multiple items sum in integer cents/);
  assert.match(fast.evidence.output, /FAIL Negative quantities are rejected/);
  assert.match(careful.summary, /Scripted local careful agent ran \d{4}-/);
  const worktrees = await git(repository, "worktree", "list", "--porcelain");
  assert.ok(worktrees.includes("newwork/careful-run"));
  assert.ok(worktrees.includes("newwork/fast-run"));
  assert.ok(worktrees.includes("detached"));
  // The agent checkout contains no authoritative tests to modify.
  const tracked = await git(path.join(rootDir, ".worktrees", "checkout-task", "careful-run"), "ls-files");
  assert.deepEqual(tracked.split("\n"), ["README.md", "checkout.mjs"]);
});

test("failed independent checks refuse merge; passing candidate merges the exact real head", async (t) => {
  const { runner, repository, baseCommit } = await setup(t);
  const fast = await runner.runCandidate({ repository, baseCommit, runId: "fast-run", agent: "fast" });
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: "fast-run", headCommit: fast.headCommit }), { code: "CHECKS_FAILED" });
  assert.equal(await git(repository, "rev-parse", "main"), baseCommit);
  const careful = await runner.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" });
  const merged = await runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: careful.headCommit });
  assert.equal(merged.mergedCommit, careful.headCommit);
  assert.equal(await git(repository, "rev-parse", "main"), careful.headCommit);
  assert.match(await readFile(path.join(repository, "checkout.mjs"), "utf8"), /item\.quantity <= 0/);
  assert.deepEqual(await runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: careful.headCommit }), merged);
});

test('starter merge retains its only gate report before write and pre-write drift stays certain', async t => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const result = await runner.runCandidate({ repository, baseCommit, runId: 'careful-run', agent: 'careful' });
  const worktree = path.join(rootDir, '.worktrees', 'checkout-task', 'careful-run');
  const verify = runner.independentlyVerify.bind(runner);
  let checks = 0, retained, writeStarted = false;
  runner.independentlyVerify = async (...args) => { checks++; return verify(...args); };
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: 'careful-run', headCommit: result.headCommit,
    retainEvidence: async evidence => {
      retained = structuredClone(evidence);
      await git(worktree, 'commit', '--allow-empty', '-m', 'Move after retained gate');
    },
    beforeWrite: async () => { writeStarted = true; },
  }), { code: 'STALE_HEAD' });
  assert.equal(checks, 1);
  assert.equal(retained.commit, result.headCommit);
  assert.equal(retained.passed, retained.total);
  assert.equal(writeStarted, false);
  assert.equal(await git(repository, 'rev-parse', 'main'), baseCommit);
});

test("stale supplied head, changed branch, dirty worktree and moved main are refused", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const result = await runner.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" });
  const worktree = path.join(rootDir, ".worktrees", "checkout-task", "careful-run");
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: baseCommit }), { code: "STALE_HEAD" });
  await writeFile(path.join(worktree, "checkout.mjs"), "// uncommitted edit\n", "utf8");
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: result.headCommit }), { code: "DIRTY_WORKTREE" });
  await git(worktree, "restore", "--", "checkout.mjs");
  await git(worktree, "commit", "--allow-empty", "-m", "External branch advance");
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: result.headCommit }), { code: "STALE_HEAD" });
  await git(repository, "commit", "--allow-empty", "-m", "External main advance");
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: result.headCommit }), { code: "STALE_BASE" });
});

test("candidate test edits are not admitted as verification evidence", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const result = await runner.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" });
  const worktree = path.join(rootDir, ".worktrees", "checkout-task", "careful-run");
  await mkdir(path.join(worktree, "tests"));
  await writeFile(path.join(worktree, "tests", "always-pass.mjs"), "console.log('16/16 PASS');\n", "utf8");
  await git(worktree, "add", "--", "tests/always-pass.mjs");
  await git(worktree, "commit", "-m", "Attempt to substitute agent supplied tests");
  const tamperedCommit = await git(worktree, "rev-parse", "HEAD");
  await assert.rejects(runner.changedFiles(repository, baseCommit, tamperedCommit), { code: "TEST_OR_SCOPE_TAMPERING" });
  await assert.rejects(runner.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: result.headCommit }), { code: "STALE_HEAD" });
  assert.equal(await git(repository, "rev-parse", "main"), baseCommit);
});

test("identifiers, outside repositories, reused runs and stale execution bases fail closed", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  await assert.rejects(runner.createDemoRepository("../outside"), { code: "INVALID_ID" });
  await assert.rejects(runner.runCandidate({ repository, baseCommit, runId: "../outside", agent: "careful" }), { code: "INVALID_ID" });
  await assert.rejects(runner.runCandidate({ repository: rootDir, baseCommit, runId: "safe", agent: "careful" }), { code: "INVALID_REPOSITORY" });
  await assert.rejects(runner.runCandidate({ repository, baseCommit: "deadbeef", runId: "safe", agent: "careful" }), { code: "INVALID_COMMIT" });
  await assert.rejects(runner.runCandidate({ repository, baseCommit, runId: "safe", agent: "model-provider" }), { code: "INVALID_AGENT" });
  const result = await runner.runCandidate({ repository, baseCommit, runId: "safe", agent: "careful" });
  await assert.rejects(runner.runCandidate({ repository, baseCommit, runId: "safe", agent: "careful" }), { code: "DUPLICATE_RUN" });
  await assert.rejects(runner.runCandidate({ repository, baseCommit: result.headCommit, runId: "other", agent: "careful" }), { code: "STALE_BASE" });
});

test("a redirected worktree parent is refused before any outside files are written", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "projects-agent-git-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(rootDir, ".worktrees"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runner.runCandidate({ repository, baseCommit, runId: "safe", agent: "careful" }), /Worktree directory escapes rootDir/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await git(repository, "rev-parse", "HEAD"), baseCommit);
  await assert.rejects(new GitRunner({ rootDir }).initialize(), { code: "INVALID_REGISTRY" });
});

test("restart restores exact candidate ownership; failed checks remain blocked and explicit merge retries are safe", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const [careful, fast] = await Promise.all([
    runner.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" }),
    runner.runCandidate({ repository, baseCommit, runId: "fast-run", agent: "fast" }),
  ]);
  const saved = JSON.parse(await readFile(path.join(rootDir, ".runner-registry.json"), "utf8"));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.repositories[0].repository, "checkout-task");
  assert.equal(saved.repositories[0].candidates.length, 2);
  for (const candidate of saved.repositories[0].candidates) {
    assert.equal(candidate.worktree, `.worktrees/checkout-task/${candidate.runId}`);
    assert.ok(candidate.headCommit);
    assert.equal(candidate.executionKind, 'scripted');
    assert.equal(Object.hasOwn(candidate, "evidence"), false);
  }
  const restored = new GitRunner({ rootDir });
  await restored.initialize(); // Startup restores owner metadata before accepting work.
  assert.equal(await git(repository, "rev-parse", "main"), baseCommit); // Initialization never merges.
  await assert.rejects(restored.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" }), { code: "DUPLICATE_RUN" });
  await assert.rejects(restored.mergeCandidate({ repository, baseCommit, runId: "fast-run", headCommit: fast.headCommit }), { code: "CHECKS_FAILED" });
  const merged = await restored.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: careful.headCommit });
  assert.deepEqual(merged, { mergedCommit: careful.headCommit });
  const retried = new GitRunner({ rootDir });
  await retried.initialize();
  assert.deepEqual(await retried.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: careful.headCommit }), merged);
  await writeFile(path.join(repository, "checkout.mjs"), "// Dirty main after merge\n", "utf8");
  await assert.rejects(retried.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: careful.headCommit }), { code: "DIRTY_WORKTREE" });
  await git(repository, "restore", "--", "checkout.mjs");
  await git(repository, "commit", "--allow-empty", "-m", "Advance main past the recorded candidate");
  await assert.rejects(retried.mergeCandidate({ repository, baseCommit, runId: "careful-run", headCommit: careful.headCommit }), { code: "STALE_BASE" });
});

test("startup fails loudly on malformed or escaped registry metadata", async (t) => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  await runner.runCandidate({ repository, baseCommit, runId: "careful-run", agent: "careful" });
  const registryPath = path.join(rootDir, ".runner-registry.json");
  const original = JSON.parse(await readFile(registryPath, "utf8"));
  const mutations = [
    (value) => { value.schemaVersion = 99; },
    (value) => { delete value.repositories[0].candidates[0].executionKind; },
    (value) => { value.repositories[0].candidates[0].executionKind = 'unknown'; },
    (value) => { value.repositories[0].repository = "../outside"; },
    (value) => { value.repositories[0].candidates[0].worktree = "../../outside"; },
    (value) => { value.repositories[0].candidates[0].runId = "../outside"; },
    (value) => { value.repositories[0].candidates[0].headCommit = "deadbeef"; },
    (value) => { value.repositories[0].candidates.push(value.repositories[0].candidates[0]); },
  ];
  for (const mutate of mutations) {
    const saved = structuredClone(original);
    mutate(saved);
    await writeFile(registryPath, JSON.stringify(saved), "utf8");
    await assert.rejects(new GitRunner({ rootDir }).initialize(), { code: "INVALID_REGISTRY" });
  }
  await writeFile(registryPath, "{broken json", "utf8");
  await assert.rejects(new GitRunner({ rootDir }).initialize(), { code: "INVALID_REGISTRY" });
  await writeFile(registryPath, JSON.stringify({ ...original, harnessSha256: "0".repeat(64) }), "utf8");
  await assert.rejects(new GitRunner({ rootDir }).initialize(), { code: "TEST_TAMPERING" });
});

test('version 1 scripted records migrate without changing commits or reclassifying model work', async t => {
  const { runner, repository, baseCommit, rootDir } = await setup(t);
  const candidate = await runner.runCandidate({ repository, baseCommit, runId: 'legacy-run', agent: 'careful' });
  const registry = path.join(rootDir, '.runner-registry.json');
  const saved = JSON.parse(await readFile(registry, 'utf8'));
  saved.schemaVersion = 1;
  saved.harnessSha256 = createHash('sha256').update(await readFile('fixtures/authoritative-checks.mjs')).digest('hex');
  for (const entry of saved.repositories[0].candidates) delete entry.executionKind;
  await writeFile(registry, JSON.stringify(saved));
  const restored = new GitRunner({ rootDir });
  await restored.initialize();
  assert.equal(await git(repository, 'rev-parse', 'main'), baseCommit);
  assert.equal(restored.repositories.get(repository).candidates.get('legacy-run').executionKind, 'scripted');
  await restored.persistRegistry();
  const migrated = JSON.parse(await readFile(registry, 'utf8'));
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.repositories[0].candidates[0].headCommit, candidate.headCommit);
  assert.equal(migrated.repositories[0].candidates[0].executionKind, 'scripted');
});
