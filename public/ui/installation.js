import {el} from './dom.js';
import {installationReadiness, MAX_SETUP_REPORT_BYTES} from '../installation-readiness.js';

export function canInspectInstallation({workspace, demo}) {
  return Boolean(workspace && !demo && !workspace.personalWorkspace
    && (!workspace.authentication || workspace.authentication.permissions?.manage === true));
}

// Setup reports stay local. The optional owner backup section owns its separate API boundary.
export function createInstallationPanel({getContext, captureSession, backupPanel}) {
  if (!canInspectInstallation(getContext())) return el('p', {}, 'Installation settings are available to the workspace owner.');
  const root = el('div', {id: 'installation-settings', class: 'installation-settings'}), isCurrent = captureSession();
  const backup=backupPanel?.();
  let readiness = installationReadiness(), error = '', reading = false, selection = 0;
  const current = () => root.isConnected && isCurrent() && canInspectInstallation(getContext());

  function stageView(stage) {
    const label = stage.status === 'checked_locally' ? 'Checked locally'
      : stage.status === 'blocked' ? 'Needs attention' : stage.status === 'not_checked' ? 'Not checked' : 'Not verified';
    const summary = stage.summary;
    return el('section', {class: 'installation-stage', 'aria-labelledby': 'installation-' + stage.id},
      el('div', {class: 'installation-stage-heading'},
        el('h3', {id: 'installation-' + stage.id}, stage.label),
        el('span', {class: 'installation-status status-' + stage.status}, label)),
      summary ? el('p', {class: 'small'},
        stage.requested ? `${summary.passed}/${summary.total} local checks passed · ${summary.blocked} blocked · ${summary.notChecked} not checked`
          : `${readiness.report ? 'Not requested in this report' : 'No report loaded'} · ${summary.total} checks available`) : null,
      summary ? el('details', {}, el('summary', {}, 'Checks and next steps'),
        ...stage.checks.map(check => el('div', {class: 'installation-check'},
          el('strong', {}, check.label),
          el('p', {class: 'small'}, check.status === 'passed' ? 'Passed locally' : check.status === 'blocked' ? 'Blocked' : 'Not checked'),
          check.status !== 'passed' ? el('p', {class: 'small'}, check.action) : null)))
        : el('p', {class: 'small'}, stage.next));
  }

  function render() {
    const file = el('input', {id: 'installation-report', type: 'file', accept: '.json,application/json',
      'aria-describedby': 'installation-report-help', onchange: async event => {
        const chosen = event.target.files?.[0];
        if (!chosen) return;
        const request = ++selection;
        readiness = installationReadiness(); error = ''; reading = true; render();
        try {
          if (!Number.isSafeInteger(chosen.size) || chosen.size < 2 || chosen.size > MAX_SETUP_REPORT_BYTES) throw Error();
          const bytes = await chosen.slice(0, MAX_SETUP_REPORT_BYTES + 1).arrayBuffer();
          if (bytes.byteLength > MAX_SETUP_REPORT_BYTES) throw Error();
          const supplied = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
          const loaded = installationReadiness(supplied);
          if (request !== selection || !current()) return;
          readiness = loaded; // Retain only the known, normalized fields.
        } catch {
          if (request !== selection || !current()) return;
          error = 'Could not read this report. Choose a complete JSON report from the current setup checker (schema 2), at most 64 KiB.';
        }
        if (request !== selection || !current()) return;
        reading = false; render();
        root.querySelector('#installation-report')?.focus({preventScroll: true});
      }});
    root.replaceChildren(
      el('p', {class: 'installation-boundary'}, 'Hosted installation is not verified. Local checks cannot verify resources, deployment or private workflows.'),
      el('section', {class: 'installation-import'},
        el('h3', {}, 'Offline setup report'),
        el('p', {id: 'installation-report-help', class: 'small'},
          'Read in this tab. Never uploaded or saved. This report is not matched to the current installation.'),
        el('label', {for: file.id}, 'Offline setup report (JSON, up to 64 KiB)'), file,
        el('button', {type: 'button', class: 'button button-small', disabled: !readiness.report && !reading && !error,
          onclick: () => { selection++; readiness = installationReadiness(); error = ''; reading = false; render(); root.querySelector('#installation-report')?.focus({preventScroll: true}); }}, 'Clear report'),
        el('p', {class: 'small', role: 'status'}, reading ? 'Reading the selected local file…'
          : readiness.report ? `Local report loaded · ${readiness.report.summary.passed}/${readiness.report.summary.total} checks passed · reported ${readiness.report.reportedAt}`
            : 'No local report loaded.'),
        error ? el('p', {class: 'inline-error', role: 'alert'}, error) : null),
      ...readiness.stages.map(stageView),
      el('details', {}, el('summary', {}, 'Create a report and understand its scope'),
        el('p', {}, 'In your own source checkout, save the checker output as JSON. Use your actual operator-config path:'),
        el('pre', {}, el('code', {}, 'npm run --silent setup:check -- --config wrangler.operator.jsonc --json > setup-report.json')),
        el('p', {}, 'Only known check names and results are displayed. A supplied report is not independently authenticated or matched to this workspace, account or deployed source. It never enables setup, agent work, acceptance or merge.'),
        el('p', {}, 'Local prerequisites cover source metadata, Node.js, Git and installed dependency metadata. Docker is included only when requested. Hosted configuration checks inspect a literal config; they do not contact Cloudflare.'),
        el('p', {}, 'Provisioning, spending, Access changes, deployment and hosted workflows need their own authorization and evidence. This panel does not perform or approve them.')),
      ...(backup?[backup]:[]));
  }
  render();
  return root;
}
