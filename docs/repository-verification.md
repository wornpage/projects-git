# Verify a captured repository change

`scripts/verify-git-task.mjs` checks an existing Git handoff with an explicitly trusted command definition and an installed immutable Docker image. It writes a new handoff with commit-bound evidence. It never imports a task into the live coordinator, grants acceptance, merges or deploys.

The command contract is language independent. JavaScript and Python are exercised by integration tests. Other languages need a prepared image and suitable commands; they are not yet qualified. Dependencies must already exist in the image or committed source. No package installation or network access occurs during verification.

## Capture and verify your own change

Use a committed base and candidate branch in your own repository. Prepare a task
brief with explicit criteria; `examples/handoff-export-brief.json` illustrates
the format. The values in angle brackets below must be replaced with your own
inputs. Use new output names when repeating a run.

```sh
node scripts/capture-git-task.mjs --repo <REPOSITORY_PATH> --base <BASE_COMMIT> --branch <CANDIDATE_BRANCH> --brief <BRIEF_JSON> --out qa/candidate-capture.json
```

Prepare and independently review a command definition for that exact candidate
and its requirements, using the contract below. Compute its SHA-256 over the
exact UTF-8 file bytes. Prepare a suitable immutable Docker image on your own
machine; verification does not install dependencies or pull an image.

```sh
node scripts/verify-git-task.mjs --repo <REPOSITORY_PATH> --handoff qa/candidate-capture.json --checks <CHECK_DEFINITION_JSON> --checks-sha256 <CHECKS_SHA256> --image <IMAGE_ID_OR_DIGEST> --out qa/candidate-verified.json
node scripts/inspect-handoff.mjs qa/candidate-verified.json
```

An existing output is refused before starting containers. A completed failing
or interrupted run saves a receipt and exits nonzero. Preflight errors produce
no new receipt. The original handoff remains untouched. Passing verification
does not itself record acceptance or authorize a merge.

## Definition and trust

Definitions use `repository-command-checks/v1`, a full commit ID, task revision, requirements digest, total execution timeout and 1–12 uniquely named checks. Each check contains only `name`, an `argv` array, `stdin`, and `expected: { exitCode, stdout }`. There is no implicit shell. Include an interpreter explicitly when needed. Expected exit codes are 0–124; infrastructure failures and termination cannot pass.

The requirements digest is SHA-256 of UTF-8 `JSON.stringify({ title, purpose, criteria, revision })` in that field order. Changing any of these fields or the target commit invalidates the definition. `requirementsDigest` in `src/local/repository-checks.mjs` implements this rule. The CLI requires the separately supplied definition digest; it never selects commands from a handoff or discovers and trusts tests in candidate code.

Expected stdout and exit status stay in the host process. Each command gets its own container and only its input. The host compares exact UTF-8 stdout and exit status; candidate-reported pass counts have no authority. This proves the declared observable behavior, not arbitrary written criteria or correctness on untested inputs. If a definition merely expects a test runner to print “PASS,” that is weak evidence; choose observable outcomes that address the task.

The image, definition and local verifier are trusted inputs. A digest pins bytes; it does not make an unreviewed definition trustworthy. The saved receipt is unsigned. Historical evidence is retained as recorded history, not independently authenticated by this invocation.

## Isolation and limits

| Boundary | Enforcement |
| --- | --- |
| Source identity | Re-read the base/head diff and paths, then copy blobs from the exact commit's tree; no checkout, hooks or working-tree files |
| Snapshot | 256 regular files, 1 MiB/file, 8 MiB total; reject symlinks, submodules, unsafe paths and case aliases |
| Git access | No remote fetch, inherited Git overrides or replacement objects; 10 seconds/1 MiB per read; extraction stops after its 30-second allowance between reads |
| Execution | 1–12 commands, 1–60 seconds total execution allowance, 256 KiB combined stdout/stderr per command; image inspection and cleanup have separate 15-second bounds |
| Container | Network disabled, nonroot user, read-only source/root, no capabilities, no privilege escalation, 64 PIDs, 128 MiB RAM, one CPU |
| Scratch | Fresh 64 MiB `/tmp` tmpfs per check; no writable host mount or retained build directory |
| Inputs | 64 KiB definition, 16,384 characters stdin/check, bounded arguments; no host environment variables or Git metadata passed into the container |
| Evidence | Exact commit, tree, requirements revision/digest, image ID, definition/verifier hashes and input handoff digest; raw candidate output is not copied into the receipt |

Cleanup removes each named container and the private snapshot directory. Time, output or infrastructure failures stop subsequent commands and mark the attempt unverified. Unrun checks remain in the denominator with an explicit explanation. Completed mismatches are independently observed failures. Reverification moves the previous report into history; current metrics count only the latest report, and stale requirements do not count as current verification.

Branch heads may have moved since capture. Verification intentionally checks the retained immutable commit. Any later review or merge must refresh live heads and requirements separately.

Implementation references: [Docker container isolation and runtime limits](https://docs.docker.com/engine/containers/run/), [Git tree enumeration](https://git-scm.com/docs/git-ls-tree), and [Git object reads](https://git-scm.com/docs/git-cat-file).

## Run the tests

Set `PROJECTS_SANDBOX_TEST_IMAGE` to an installed immutable Node image and `PROJECTS_PYTHON_TEST_IMAGE` to an installed immutable Python image, then run `npm run check`. Missing images are reported as explicit integration-test skips, never counted as passed qualification.
