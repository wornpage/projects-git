import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("../../fixtures/checkout.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("../../fixtures/authoritative-checks.mjs", import.meta.url));
const agentPath = fileURLToPath(new URL("./scripted-agent.mjs", import.meta.url));
const sandboxProofPaths = ['../../fixtures/checkout-cases.mjs', './checkout-executor.mjs', './sandbox-checks.mjs'].map(value => fileURLToPath(new URL(value, import.meta.url)));
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const segment = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const digest = (data) => createHash("sha256").update(data).digest("hex");
const registryName = ".runner-registry.json";

function fail(message, code = "GIT_WORKFLOW_REFUSED") {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  throw error;
}

function assertSegment(value, label) {
  if (typeof value !== "string" || !segment.test(value)) fail(`Invalid ${label}`, "INVALID_ID");
}

function assertCommit(value, label) {
  if (typeof value !== "string" || !sha.test(value)) fail(`Invalid ${label}`, "INVALID_COMMIT");
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function execute(file, args, cwd, { allowFailure = false, timeout = 15000 } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(file, args, { cwd, env, shell: false, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return { ...result, exitCode: 0, startedAt, finishedAt: new Date().toISOString() };
  } catch (error) {
    if (allowFailure && Number.isInteger(error.code) && !error.killed) {
      return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), exitCode: error.code, startedAt, finishedAt: new Date().toISOString() };
    }
    throw new Error(`${path.basename(file)} ${args[0] ?? ""} failed: ${error.killed ? "process time limit exceeded" : error.stderr || error.message}`, { cause: error });
  }
}

export class GitRunner {
  constructor({ rootDir, sandbox = null }) {
    if (typeof rootDir !== "string" || !rootDir) throw new TypeError("rootDir is required");
    this.rootDir = path.resolve(rootDir);
    this.repositories = new Map();
    this.initialization = null;
    this.persistence = Promise.resolve();
    this.sandbox = sandbox;
  }

  async initialize() {
    this.initialization ??= (async () => {
      await mkdir(this.rootDir, { recursive: true });
      this.rootDir = await realpath(this.rootDir);
      this.legacyHarnessHash = digest(await readFile(harnessPath));
      this.harnessHash = await this.currentHarnessHash();
      this.hooksDir = path.join(this.rootDir, ".empty-hooks");
      await mkdir(this.hooksDir, { recursive: true });
      if (!isWithin(this.rootDir, await realpath(this.hooksDir))) fail("Hooks directory escapes rootDir");
      this.registryPath = path.join(this.rootDir, registryName);
      await this.restoreRegistry();
    })();
    await this.initialization;
  }

  async currentHarnessHash() {
    return digest(Buffer.concat(await Promise.all([harnessPath, ...sandboxProofPaths].map(value => readFile(value)))));
  }

  async git(repository, args) {
    const result = await execute("git", ["-c", `core.hooksPath=${this.hooksDir}`, "-c", "core.autocrlf=false", "-c", "user.name=Projects Demo", "-c", "user.email=demo@localhost.invalid", ...args], repository);
    return result.stdout.trim();
  }

  async trustedRepository(repository) {
    await this.initialize();
    if (typeof repository !== "string" || !path.isAbsolute(repository)) fail("An absolute repository path is required");
    const resolved = await realpath(repository);
    const record = this.repositories.get(resolved);
    if (!record || !isWithin(this.rootDir, resolved) || path.dirname(resolved) !== this.rootDir) fail("Repository is outside this runner's registered rootDir", "INVALID_REPOSITORY");
    await this.assertRepositoryIdentity(record);
    return record;
  }

  async assertRepositoryIdentity(record) {
    const resolved = await realpath(record.repository);
    if (resolved !== record.repository || !isWithin(this.rootDir, resolved) || path.dirname(resolved) !== this.rootDir) fail("Registered repository identity changed", "INVALID_REPOSITORY");
    if (await realpath(path.join(resolved, ".git")) !== path.join(resolved, ".git")) fail("Repository metadata identity changed", "INVALID_REPOSITORY");
    const top = await this.git(resolved, ["rev-parse", "--show-toplevel"]);
    if (path.resolve(top) !== resolved) fail("Repository identity changed");
  }

  async assertContainedPath(target) {
    if (!isWithin(this.rootDir, target)) fail("Registered path escapes rootDir", "INVALID_REGISTRY");
    let existing = target;
    while (true) {
      try {
        const resolved = await realpath(existing);
        if (resolved !== existing || (resolved !== this.rootDir && !isWithin(this.rootDir, resolved))) fail("Registered path is redirected outside its canonical location", "INVALID_REGISTRY");
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        existing = path.dirname(existing);
      }
    }
  }

  async restoreRegistry() {
    let file;
    try {
      file = await lstat(this.registryPath);
    } catch (error) {
      if (error.code === "ENOENT") return; // A new runner has no registered work yet.
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink()) fail("Runner registry must be a regular local file", "INVALID_REGISTRY");
    let saved;
    try {
      saved = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(this.registryPath)));
    } catch {
      fail("Runner registry is not valid UTF-8 JSON", "INVALID_REGISTRY");
    }
    if (!hasExactKeys(saved, ["schemaVersion", "harnessSha256", "repositories"]) || ![1, 2].includes(saved.schemaVersion) || !/^[a-f0-9]{64}$/.test(saved.harnessSha256) || !Array.isArray(saved.repositories)) fail("Runner registry schema is invalid", "INVALID_REGISTRY");
    if (saved.harnessSha256 !== (saved.schemaVersion === 1 ? this.legacyHarnessHash : this.harnessHash)) fail("Independent harness changed since registered execution", "TEST_TAMPERING");
    const restored = new Map();
    for (const entry of saved.repositories) {
      if (!hasExactKeys(entry, ["taskId", "repository", "baseCommit", "candidates"]) || !segment.test(entry.taskId) || typeof entry.taskId !== "string" || entry.repository !== entry.taskId || !sha.test(entry.baseCommit) || typeof entry.baseCommit !== "string" || !Array.isArray(entry.candidates)) fail("Registered repository metadata is invalid", "INVALID_REGISTRY");
      const repository = path.join(this.rootDir, entry.repository);
      if (restored.has(repository)) fail("Runner registry contains duplicate task repositories", "INVALID_REGISTRY");
      const record = { repository, taskId: entry.taskId, baseCommit: entry.baseCommit, candidates: new Map(), merging: false };
      await this.assertRepositoryIdentity(record);
      if (await this.git(repository, ["cat-file", "-t", entry.baseCommit]) !== "commit") fail("Registered base is not a Git commit", "INVALID_REGISTRY");
      for (const item of entry.candidates) {
        const keys = ["runId", "branch", "worktree", "baseCommit", "headCommit", ...(saved.schemaVersion === 2 ? ["executionKind"] : [])];
        if (!hasExactKeys(item, keys) || (saved.schemaVersion === 2 && !['scripted', 'model'].includes(item.executionKind)) || typeof item.runId !== "string" || !segment.test(item.runId) || item.branch !== `newwork/${item.runId}` || item.worktree !== path.posix.join(".worktrees", entry.taskId, item.runId) || item.baseCommit !== entry.baseCommit || (item.headCommit !== null && (typeof item.headCommit !== "string" || !sha.test(item.headCommit)))) fail("Registered candidate metadata is invalid or escapes rootDir", "INVALID_REGISTRY");
        if (record.candidates.has(item.runId)) fail("Runner registry contains duplicate candidate runs", "INVALID_REGISTRY");
        // Version 1 could create only trusted scripted candidates. Version 2
        // records the execution kind so a restart can never run model code on the host.
        const candidate = { ...item, executionKind: saved.schemaVersion === 1 ? 'scripted' : item.executionKind, worktree: path.join(this.rootDir, ...item.worktree.split("/")) };
        await this.assertContainedPath(candidate.worktree);
        try {
          await this.trustedWorktree(record, candidate.worktree);
        } catch (error) {
          // An explicitly reserved run may have been interrupted before worktree creation.
          // Preserve its reservation; never restart a process or invent a result.
          if (error.code !== "ENOENT" || item.headCommit !== null) throw error;
        }
        if (item.headCommit !== null && await this.git(repository, ["cat-file", "-t", item.headCommit]) !== "commit") fail("Registered head is not a Git commit", "INVALID_REGISTRY");
        record.candidates.set(item.runId, candidate);
      }
      restored.set(repository, record);
    }
    this.repositories = restored;
  }

  persistRegistry() {
    const operation = this.persistence.then(async () => {
      try {
        const current = await lstat(this.registryPath);
        if (!current.isFile() || current.isSymbolicLink()) fail("Runner registry identity changed", "INVALID_REGISTRY");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const saved = {
        schemaVersion: 2,
        harnessSha256: this.harnessHash,
        repositories: [...this.repositories.values()].map((record) => ({
          taskId: record.taskId,
          repository: record.taskId,
          baseCommit: record.baseCommit,
          candidates: [...record.candidates.values()].map((candidate) => ({
            runId: candidate.runId,
            branch: candidate.branch,
            worktree: path.posix.join(".worktrees", record.taskId, candidate.runId),
            baseCommit: candidate.baseCommit,
            headCommit: candidate.headCommit,
            executionKind: candidate.executionKind,
          })),
        })),
      };
      const temporaryPath = path.join(this.rootDir, `.runner-registry-${randomUUID()}.tmp`);
      const temporary = await open(temporaryPath, "wx", 0o600);
      try {
        await temporary.writeFile(`${JSON.stringify(saved, null, 2)}\n`, "utf8");
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, this.registryPath);
    });
    this.persistence = operation;
    return operation;
  }

  async auxiliaryDirectory(kind, taskId) {
    const parent = path.join(this.rootDir, kind);
    await mkdir(parent, { recursive: true });
    if (!isWithin(this.rootDir, await realpath(parent))) fail("Worktree directory escapes rootDir");
    const taskDirectory = path.join(parent, taskId);
    await mkdir(taskDirectory, { recursive: true });
    if (!isWithin(this.rootDir, await realpath(taskDirectory))) fail("Task worktree directory escapes rootDir");
    return taskDirectory;
  }

  async trustedWorktree(record, worktree) {
    const resolved = await realpath(worktree);
    if (resolved !== worktree || !isWithin(this.rootDir, resolved)) fail("Worktree identity or location changed", "INVALID_WORKTREE");
    const commonDir = await this.git(worktree, ["rev-parse", "--git-common-dir"]);
    if (await realpath(path.resolve(worktree, commonDir)) !== path.join(record.repository, ".git")) fail("Worktree belongs to a different repository", "INVALID_WORKTREE");
    if (path.resolve(await this.git(worktree, ["rev-parse", "--show-toplevel"])) !== resolved) fail("Worktree root changed", "INVALID_WORKTREE");
  }

  async createDemoRepository(taskId) {
    assertSegment(taskId, "task ID");
    await this.initialize();
    const repository = path.join(this.rootDir, taskId);
    await mkdir(repository); // Existing repositories are never overwritten.
    if (!isWithin(this.rootDir, await realpath(repository))) fail("Repository directory escapes rootDir");
    await this.git(repository, ["init", "--initial-branch=main"]);
    await writeFile(path.join(repository, "checkout.mjs"), await readFile(fixturePath));
    await writeFile(path.join(repository, "README.md"), "# Checkout task\n\nImplement checkoutTotal(items) in safe integer cents. Each item must contain a nonnegative safe integer unitCents and a positive safe integer quantity. Reject invalid records and unsafe products or totals. Authoritative checks are held outside agent worktrees.\n");
    await this.git(repository, ["add", "--", "checkout.mjs", "README.md"]);
    await this.git(repository, ["commit", "-m", "Initialize checkout validation task"]);
    const baseCommit = await this.git(repository, ["rev-parse", "HEAD"]);
    assertCommit(baseCommit, "base commit");
    this.repositories.set(repository, { repository, taskId, baseCommit, candidates: new Map(), merging: false });
    await this.persistRegistry();
    return { baseCommit, repository };
  }

  async assertClean(worktree) {
    if (await this.git(worktree, ["status", "--porcelain", "--untracked-files=all"])) fail("Worktree has uncommitted or untracked changes", "DIRTY_WORKTREE");
  }

  async changedFiles(repository, baseCommit, headCommit) {
    const files = (await this.git(repository, ["diff", "--name-only", "--no-renames", `${baseCommit}..${headCommit}`])).split("\n").filter(Boolean);
    if (files.length !== 1 || files[0] !== "checkout.mjs") fail("Candidate changed files outside the assigned checkout.mjs implementation; test changes cannot count as proof", "TEST_OR_SCOPE_TAMPERING");
    const treeLine = await this.git(repository, ["ls-tree", headCommit, "--", "checkout.mjs"]);
    if (!/^100644 blob [a-f0-9]+\tcheckout\.mjs$/.test(treeLine)) fail("Checkout implementation must be a regular tracked file");
    return files;
  }

  async independentlyVerify(record, runId, headCommit) {
    if (await this.currentHarnessHash() !== this.harnessHash) fail("Independent harness changed", "TEST_TAMPERING");
    const parent = await this.auxiliaryDirectory(".verification", record.taskId);
    const worktree = path.join(parent, `${runId}-${randomUUID()}`);
    await this.git(record.repository, ["worktree", "add", "--detach", worktree, headCommit]);
    await this.trustedWorktree(record, worktree);
    await this.assertClean(worktree);
    if (record.candidates.get(runId)?.executionKind === 'model') {
      if (!this.sandbox) fail('Model-generated candidates require the configured sandbox, including after restart.', 'SANDBOX_REQUIRED');
      const evidence = await this.sandbox.verify(path.join(worktree, 'checkout.mjs'));
      await this.assertClean(worktree);
      if (await this.git(worktree, ['rev-parse', 'HEAD']) !== headCommit) fail('Verification checkout head changed', 'STALE_HEAD');
      if (await this.currentHarnessHash() !== this.harnessHash) fail('Independent harness changed during checks', 'TEST_TAMPERING');
      return { ...evidence, commit: headCommit };
    }
    const result = await execute(process.execPath, [harnessPath, path.join(worktree, "checkout.mjs")], worktree, { allowFailure: true });
    await this.assertClean(worktree);
    if (await this.git(worktree, ["rev-parse", "HEAD"]) !== headCommit) fail("Verification checkout head changed", "STALE_HEAD");
    if (await this.currentHarnessHash() !== this.harnessHash) fail("Independent harness changed during checks", "TEST_TAMPERING");
    const marker = result.stdout.trim().split(/\r?\n/).at(-1);
    if (!marker?.startsWith("PROJECTS_CHECKS:")) fail("Independent checks did not produce a complete report", "INVALID_CHECK_REPORT");
    const report = JSON.parse(marker.slice("PROJECTS_CHECKS:".length));
    if (report.total !== 16 || report.checks?.length !== report.total || report.passed !== report.checks.filter((check) => check.passed === true).length || result.exitCode !== (report.passed === report.total ? 0 : 1)) fail("Independent check report is inconsistent", "INVALID_CHECK_REPORT");
    return {
      verified: true,
      commit: headCommit,
      passed: report.passed,
      total: report.total,
      checks: report.checks,
      command: [process.execPath, harnessPath, path.join(worktree, "checkout.mjs")].map((value) => JSON.stringify(value)).join(" "),
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
      verifiedAt: result.finishedAt,
      source: "independent-local-checks",
    };
  }

  async runCandidate({ repository, runId, agent, baseCommit, modelWork }) {
    assertSegment(runId, "run ID");
    assertCommit(baseCommit, "base commit");
    const model = agent === 'model';
    if (model) {
      if (!this.sandbox || typeof modelWork !== 'function') fail('Model execution requires a sandbox and configured provider.', 'SANDBOX_REQUIRED');
      await this.sandbox.ready();
    } else if (!["careful", "fast"].includes(agent)) fail("Unknown scripted local agent", "INVALID_AGENT");
    const record = await this.trustedRepository(repository);
    if (await this.currentHarnessHash() !== this.harnessHash) fail('Independent harness changed before execution; no agent request was started.', 'TEST_TAMPERING');
    if (record.baseCommit !== baseCommit || await this.git(repository, ["rev-parse", "main"]) !== baseCommit) fail("Task base changed before execution", "STALE_BASE");
    if (record.candidates.has(runId)) fail("Run already exists", "DUPLICATE_RUN");
    const branch = `newwork/${runId}`;
    const worktree = path.join(this.rootDir, ".worktrees", record.taskId, runId);
    record.candidates.set(runId, { runId, branch, worktree, baseCommit, headCommit: null, executionKind: model ? 'model' : 'scripted' });
    await this.persistRegistry();
    await this.auxiliaryDirectory(".worktrees", record.taskId);
    await this.git(repository, ["worktree", "add", "-b", branch, worktree, baseCommit]);
    await this.trustedWorktree(record, worktree);
    let execution;
    if (model) {
      const source = path.join(worktree, 'checkout.mjs');
      execution = await modelWork({
        files: { 'checkout.mjs': await readFile(source, 'utf8') },
        apply: async (files, signal) => {
          signal.throwIfAborted();
          if (files.length !== 1 || files[0].path !== 'checkout.mjs') fail('Model edit is outside the assigned scope.');
          if ((await lstat(source)).isSymbolicLink()) fail('Candidate source path was redirected.');
          await writeFile(source, files[0].content, 'utf8');
        },
        check: signal => this.sandbox.verify(source, signal),
      });
    } else execution = await execute(process.execPath, [agentPath, agent, worktree], worktree);
    await this.git(worktree, ["add", "--", "checkout.mjs"]);
    await this.git(worktree, ["commit", "-m", model ? 'Implement checkout totals with model agent' : `Implement checkout totals with scripted ${agent} agent`]);
    await this.assertClean(worktree);
    const headCommit = await this.git(worktree, ["rev-parse", "HEAD"]);
    assertCommit(headCommit, "candidate commit");
    const changedFiles = await this.changedFiles(repository, baseCommit, headCommit);
    const diff = await this.git(repository, ["diff", "--no-ext-diff", "--no-textconv", `${baseCommit}..${headCommit}`, "--", "checkout.mjs"]);
    const evidence = await this.independentlyVerify(record, runId, headCommit);
    const candidate = record.candidates.get(runId);
    candidate.headCommit = headCommit;
    candidate.evidence = evidence;
    await this.persistRegistry();
    return { headCommit, changedFiles, diff, summary: model ? `${execution.summary} Independent sandbox checks passed ${evidence.passed}/${evidence.total}.` : `Scripted local ${agent} agent ran ${execution.startedAt} to ${execution.finishedAt}; independent checks passed ${evidence.passed}/${evidence.total}.`, evidence, branch };
  }

  async verifyCandidate({ repository, runId, headCommit }) {
    assertSegment(runId, 'run ID');
    assertCommit(headCommit, 'candidate commit');
    const record = await this.trustedRepository(repository);
    const candidate = record.candidates.get(runId);
    if (!candidate || candidate.headCommit !== headCommit) fail('Candidate does not match its retained ownership record.', 'UNKNOWN_CANDIDATE');
    if (await this.git(repository, ['rev-parse', candidate.branch]) !== headCommit) fail('Candidate branch changed.', 'STALE_HEAD');
    await this.changedFiles(repository, record.baseCommit, headCommit);
    const evidence = await this.independentlyVerify(record, runId, headCommit);
    if (await this.git(repository, ['rev-parse', candidate.branch]) !== headCommit) fail('Candidate branch changed during verification.', 'STALE_HEAD');
    return evidence;
  }

  async mergeCandidate({ repository, runId, headCommit, baseCommit, retainEvidence = async () => {}, beforeWrite = async () => {} }) {
    assertSegment(runId, "run ID");
    assertCommit(headCommit, "candidate commit");
    assertCommit(baseCommit, "base commit");
    const record = await this.trustedRepository(repository);
    if (record.merging) fail("Another merge is in progress", "MERGE_IN_PROGRESS");
    record.merging = true;
    try {
      const candidate = record.candidates.get(runId);
      if (!candidate || candidate.headCommit !== headCommit) fail("Candidate does not match the recorded exact head", "STALE_HEAD");
      await this.trustedWorktree(record, candidate.worktree);
      if (record.baseCommit !== baseCommit || candidate.baseCommit !== baseCommit) fail("Supplied base does not match the registered task base", "STALE_BASE");
      const currentMain = await this.git(repository, ["rev-parse", "main"]);
      if (currentMain !== baseCommit && currentMain !== headCommit) fail("Main no longer matches the task base or this exact candidate", "STALE_BASE");
      if (await this.git(repository, ["branch", "--show-current"]) !== "main" || await this.git(repository, ["rev-parse", "HEAD"]) !== currentMain) fail("Repository is not at the exact expected main head", "STALE_BASE");
      if (await this.git(repository, ["rev-parse", candidate.branch]) !== headCommit || await this.git(candidate.worktree, ["rev-parse", "HEAD"]) !== headCommit) fail("Candidate branch or worktree head changed", "STALE_HEAD");
      await this.assertClean(repository);
      await this.assertClean(candidate.worktree);
      await this.changedFiles(repository, baseCommit, headCommit);
      const evidence = await this.independentlyVerify(record, runId, headCommit);
      await retainEvidence(evidence);
      if (!evidence.verified || evidence.passed !== evidence.total || evidence.exitCode !== 0) fail(`Independent exact-head checks failed (${evidence.passed}/${evidence.total})`, "CHECKS_FAILED");
      // Repeat mutable head/cleanliness checks after verification and before Git's ff-only merge.
      if (await this.git(repository, ["rev-parse", "main"]) !== currentMain || await this.git(repository, ["rev-parse", "HEAD"]) !== currentMain || await this.git(repository, ["branch", "--show-current"]) !== "main") fail("Main changed during verification", "STALE_BASE");
      if (await this.git(repository, ["rev-parse", candidate.branch]) !== headCommit || await this.git(candidate.worktree, ["rev-parse", "HEAD"]) !== headCommit) fail("Candidate changed during verification", "STALE_HEAD");
      await this.assertClean(repository);
      await this.assertClean(candidate.worktree);
      // Retain the actual gate report before declaring that the target write may start.
      if (currentMain !== headCommit) {
        await beforeWrite();
        await this.git(repository, ["merge", "--ff-only", headCommit]);
      }
      const mergedCommit = await this.git(repository, ["rev-parse", "HEAD"]);
      if (mergedCommit !== headCommit) fail("Merge did not reach the accepted exact head");
      return { mergedCommit };
    } finally {
      record.merging = false;
    }
  }
}

export default GitRunner;
