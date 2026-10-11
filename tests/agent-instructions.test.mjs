import test from 'node:test';
import assert from 'node:assert/strict';
import { localAgentInstructions, hostedAgentInstructions } from '../public/agent-instructions.js';

const context = {
  projectId: '68c9d5fa-5fd0-40fb-9a52-159513cb77ef',
  origin: 'http://127.0.0.1:52065',
  cli: 'C:\\code\\Projects Git\\scripts\\repository-work.mjs',
};

test('hosted instructions pin project and workspace while keeping credentials out of copied text',()=>{
  const text=hostedAgentInstructions({projectId:context.projectId,workspaceId:'private-workspace',origin:'https://workspace.example.test',clientSecret:'NOT_IN_PROMPT'});
  assert.match(text,/--connection/);assert.match(text,/Expected workspace: private-workspace/);
  assert.ok(text.includes(context.projectId));assert.ok(!text.includes('NOT_IN_PROMPT'));
  assert.match(text,/Builders cannot configure checks/);
  assert.throws(()=>hostedAgentInstructions({projectId:context.projectId,workspaceId:'private-workspace',origin:'http://localhost:8000'}),/HTTPS/);
});

test('local handoff uses the selected project, workspace and absolute guide', () => {
  const text = localAgentInstructions(context);
  assert.ok(text.includes("$cli = 'C:\\code\\Projects Git\\scripts\\repository-work.mjs'"));
  assert.ok(text.includes("$origin = 'http://127.0.0.1:52065'"));
  assert.ok(text.includes("$projectId = '68c9d5fa-5fd0-40fb-9a52-159513cb77ef'"));
  assert.ok(text.includes("node 'C:\\code\\Projects Git\\scripts\\repository-work.mjs' status --url 'http://127.0.0.1:52065' --project '68c9d5fa-5fd0-40fb-9a52-159513cb77ef'"));
  assert.ok(text.includes("Get-Content -LiteralPath 'C:\\code\\Projects Git\\docs\\agent-workflow.md'"));
  assert.ok(text.includes('CLI (local workspace): ' + context.cli));
  assert.ok(text.includes('does not launch a model'));
  assert.ok(text.includes('does not terminate running agents'));
  assert.ok(text.includes('execution, verification and human acceptance separately'));
});

test('PowerShell arguments preserve spaces, apostrophes, dollars and backticks literally', () => {
  const cli = "C:/O'Brien/$project `draft`/scripts/repository-work.mjs";
  const text = localAgentInstructions({ ...context, cli });
  assert.ok(text.includes("$cli = 'C:/O''Brien/$project `draft`/scripts/repository-work.mjs'"));
  assert.ok(text.includes("node 'C:/O''Brien/$project `draft`/scripts/repository-work.mjs' projects --url 'http://127.0.0.1:52065'"));
  assert.ok(text.includes("Get-Content -LiteralPath 'C:/O''Brien/$project `draft`/docs/agent-workflow.md'"));
  assert.ok(text.includes('CLI (local workspace): ' + cli), 'The displayed path remains the original path');
});

test('guide derivation supports absolute POSIX and UNC checkouts', () => {
  for (const [cli, guide] of [
    ['/work/agent git/scripts/repository-work.mjs', '/work/agent git/docs/agent-workflow.md'],
    ['\\\\server\\share\\scripts\\repository-work.mjs', '\\\\server\\share\\docs\\agent-workflow.md'],
  ]) {
    assert.ok(localAgentInstructions({ ...context, cli }).includes('Workflow guide: ' + guide));
  }
});

test('connection instructions never include private workspace or project content', () => {
  const extra = { token: 'secret-token', headers: { Authorization: 'secret-header' }, projectName: 'private-project-name', purpose: 'private-purpose', notes: 'private-notes' };
  const text = localAgentInstructions({ ...context, ...extra });
  for (const value of ['secret-token', 'secret-header', 'private-project-name', 'private-purpose', 'private-notes', 'Authorization']) assert.ok(!text.includes(value));
});

test('hosted, credential-bearing and non-origin addresses cannot produce local instructions', () => {
  for (const origin of ['https://example.com', 'http://127.0.0.1:52065/path', 'http://user:secret@localhost:4178', 'http://localhost:4178?token=secret', 'http://localhost:4178/#fragment']) {
    assert.throws(() => localAgentInstructions({ ...context, origin }), /local loopback/);
  }
});

test('missing identity or a relative, unrelated or multiline CLI fails explicitly', () => {
  assert.throws(() => localAgentInstructions({ ...context, projectId: '' }), /current project ID/);
  for (const cli of [undefined, 'scripts/repository-work.mjs', 'C:/code/other.mjs', 'C:/code\n/scripts/repository-work.mjs']) {
    assert.throws(() => localAgentInstructions({ ...context, cli }), /absolute repository CLI/);
  }
});
