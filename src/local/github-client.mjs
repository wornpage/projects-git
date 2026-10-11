import {execFile} from 'node:child_process';
import {WorkflowError} from '../core/workflow.mjs';
import {githubRepository, githubBranch} from './github-publication.mjs';

const noConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
const refuse = message => { throw new WorkflowError('github_provider_failed', message, 502); };

/** Operator GitHub CLI credentials stay inside these bounded trusted processes. */
export class GitHubClient {
  constructor(repository, {execute = execFile, env = process.env} = {}) {
    this.repository = githubRepository(repository);
    this.execute = execute;
    this.env = Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN)$/i.test(key)));
    Object.assign(this.env, {GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:noConfig, GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1',
      GIT_NO_LAZY_FETCH:'1', GH_HOST:'github.com', GH_PROMPT_DISABLED:'1', GH_PAGER:'cat', NO_COLOR:'1'});
  }

  command(binary, args, {cwd, input, missing = false, timeout = 20000} = {}) {
    return new Promise((resolve, reject) => {
      const child = this.execute(binary, args, {cwd, env:this.env, encoding:'utf8', windowsHide:true, timeout, maxBuffer:1024 * 1024}, (error, stdout, stderr) => {
        if (error) {
          if (missing && !error.killed && /\(HTTP 404\)/.test(stderr)) return resolve(null);
          return reject(new WorkflowError('github_provider_failed', 'GitHub did not confirm this operation. Check the configured CLI account and retained publication state; no write was retried.', 502));
        }
        resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async api(endpoint, {body, missing = false} = {}) {
    const args = ['api', '--hostname', 'github.com', '--method', body === undefined ? 'GET' : 'POST',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint];
    if (body !== undefined) args.push('--input', '-');
    const output = await this.command('gh', args, {input:body === undefined ? undefined : JSON.stringify(body), missing});
    if (output === null) return null;
    try { return JSON.parse(output); } catch { refuse('GitHub returned an invalid JSON response.'); }
  }

  repositoryInfo() { return this.api(`repos/${this.repository}`); }

  async ref(branch) {
    githubBranch(branch);
    const result = await this.api(`repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`, {missing:true});
    if (result === null) return null;
    if (result.ref !== 'refs/heads/' + branch || result.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(result.object.sha)) refuse('GitHub returned an invalid branch reference.');
    return result.object.sha;
  }

  pullRequest(number) {
    if (!Number.isSafeInteger(number) || number < 1) refuse('Use a retained positive PR number.');
    return this.api(`repos/${this.repository}/pulls/${number}`);
  }

  async findPullRequest(branch) {
    githubBranch(branch);
    const head = encodeURIComponent(this.repository.split('/')[0] + ':' + branch);
    const list = await this.api(`repos/${this.repository}/pulls?state=all&head=${head}&per_page=100`);
    if (!Array.isArray(list) || list.length > 1) refuse('The dedicated branch has an ambiguous PR history. Inspect GitHub before continuing.');
    return list.length ? this.pullRequest(list[0].number) : null;
  }

  async pushBranch(repository, binding) {
    if (binding.repository !== this.repository || !/^[a-f0-9]{40}$/.test(binding.local.headCommit)
      || !binding.headBranch.startsWith('newwork/projects-')) refuse('Publication target does not match the configured repository.');
    const ref = 'refs/heads/' + githubBranch(binding.headBranch);
    // An empty expected lease is create-only: even a racing writer makes this fail.
    // It cannot replace an existing ref, and the exact SHA is the only source.
    const args = ['--no-pager', '-c', 'core.hooksPath=' + noConfig, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      'push', '--porcelain', '--no-verify', '--force-with-lease=' + ref + ':', '--', `https://github.com/${this.repository}.git`, `${binding.local.headCommit}:${ref}`];
    await this.command('git', args, {cwd:repository, timeout:30000});
  }

  createPullRequest(record) {
    if (record.binding.repository !== this.repository) refuse('Publication target changed.');
    return this.api(`repos/${this.repository}/pulls`, {body:{title:record.title, body:record.body + `\n\n<!-- projects-publication:${record.id} -->`,
      head:githubBranch(record.binding.headBranch), base:githubBranch(record.binding.baseBranch), draft:false, maintainer_can_modify:false}});
  }
}
