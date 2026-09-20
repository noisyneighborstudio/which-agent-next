import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { assertApproved, readRun, withRunRetry as withRun } from './state.js';
import type { LoopState } from './protocol.js';
import { runCommand, defaultGitTools, verifyBotIdentity, type GitTools } from './runtime.js';

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)}m`;

export function progressText(state: LoopState): string {
  const active = state.invocations.filter(i => !i.endedAt);
  return [
    `Run ${state.id}: ${state.status}`,
    `Updated: ${new Date(state.updatedAt).toISOString()}`,
    `Goal: ${state.plan.goal}`,
    `Candidate: ${state.candidate ?? 'not pinned'}`,
    `Budget: ${minutes(state.budget.usedMs)} used / ${minutes(state.budget.limitMs)} authorized; ${active.length} active agent invocations`,
    `Allocation: ${state.allocation.number}; ${state.allocation.invocations}/${state.allocation.maxInvocations} invocations`,
    `Supervisor: ${state.supervisor.lastInspection ? new Date(state.supervisor.lastInspection).toISOString() : 'not yet inspected'}`,
    ...state.plan.tasks.map(t => `- ${t.id}: ${t.status} | ${t.summary ?? t.title}${t.failureReason ? ` | blocker: ${t.failureReason}` : ''}`),
    'Acceptance evidence:',
    ...state.plan.criteria.map(c => {
      const evidence = state.evidence.filter(e => e.criterionId === c.id && e.candidate === state.candidate);
      const verified = evidence.some(e => e.source === 'verifier' && e.passed);
      return `- ${c.id}: ${verified ? 'independently verified' : 'open'} | ${c.description}\n${evidence.map(e => `  ${e.source}: ${e.passed ? 'PASS' : 'FAIL'} ${e.detail}`).join('\n')}`;
    }),
    'Verification jobs:',
    ...state.jobs.map(j => `- ${j.id}: ${j.endedAt ? `exit ${j.exitCode}` : 'running'} | candidate ${j.candidate}`),
    ...state.supervisor.findings.map(f => `Finding: ${f}`),
    `Next action: ${state.supervisor.nextAction ?? 'see assignments'}`,
    state.retryAt ? `Quota retry: ${new Date(state.retryAt).toISOString()}` : '',
    state.pr ? `PR: ${state.pr.url}` : '',
  ].filter(Boolean).join('\n');
}

export function renderDashboard(state: LoopState): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wan loop · ${escape(state.id)}</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:72rem;margin:3rem auto;padding:0 1.5rem;line-height:1.6}h1{font-size:2rem}a{color:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1.25rem;border:1px solid #8886;border-radius:.4rem}small{display:block;margin:1rem 0}nav{display:flex;gap:1rem}strong{font-weight:650}
  </style></head><body><header><h1>wan loop</h1><p><strong>${escape(state.status)}</strong> · ${escape(state.id)}</p></header><nav aria-label="Progress"><a href="">Refresh progress</a><a href="state.json">Run evidence as JSON</a></nav><main><pre>${escape(progressText(state))}</pre></main><footer><small>This is a read-only local dashboard. Use an explicitly configured secure connection for remote access. Refresh to inspect current state.</small></footer></body></html>`;
}

export async function serveDashboard(dir: string, port = 0): Promise<Server> {
  const server = createServer((req, res) => {
    const host = String(req.headers.host ?? '');
    if (!/^(127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(host)) { res.writeHead(403); res.end('Local access only.'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try {
      const state = readRun(dir) as LoopState;
      if (req.url === '/state.json') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: state.id, status: state.status, candidate: state.candidate, progress: progressText(state) }, null, 2));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(renderDashboard(state));
      } else { res.writeHead(404); res.end('Not found'); }
    } catch { res.writeHead(503); res.end('Run state temporarily unavailable.'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No dashboard address.');
  withRun(dir, raw => { (raw as LoopState).dashboard = { pid: process.pid, url: `http://127.0.0.1:${address.port}/` }; });
  return server;
}

type PublicationState = LoopState & {
  publicationLease?: { token: string; pid: number; acquiredAt: number };
  pr?: NonNullable<LoopState['pr']> & { publishedCandidate?: string };
};

function authorized(state: LoopState): boolean {
  if (!state.plan.permissions.includes('github:pr')) return false;
  try { assertApproved(state); return true; } catch { return false; }
}

/** An approved PR permission is a delivery obligation, even before a candidate exists. */
export function publicationReady(state: LoopState): boolean {
  if (!authorized(state)) return true;
  const pr = (state as PublicationState).pr;
  return Boolean(state.candidate && pr?.url && pr.commentId && pr.publishedCandidate === state.candidate);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Journal transactions only claim/release ownership; no network work holds its lock.
 * A live owner never expires: stealing a slow publisher's lease can duplicate writes.
 * A dead owner's successor reconciles remote objects before attempting creation.
 */
async function acquirePublication(dir: string): Promise<() => void> {
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const acquired = withRun(dir, raw => {
      const state = raw as PublicationState;
      if (state.publicationLease && alive(state.publicationLease.pid)) return false;
      state.publicationLease = { token, pid: process.pid, acquiredAt: Date.now() };
      return true;
    });
    if (acquired) return () => {
      withRun(dir, raw => {
        const state = raw as PublicationState;
        if (state.publicationLease?.token === token) delete state.publicationLease;
      });
    };
    if (Date.now() >= deadline) throw new Error('Progress publication is busy; retry.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function publicationBody(state: LoopState): string {
  // Remove changing clocks and our own publication bookkeeping from the body itself.
  const stable = { ...state, updatedAt: 0, pr: undefined, supervisor: { ...state.supervisor, lastInspection: undefined } };
  return `<!-- wan-loop:${state.id} -->\n\n${progressText(stable).split('\n').filter(line => !line.startsWith('Updated:') && !line.startsWith('Supervisor:')).join('\n')}`;
}

export async function publishProgress(dir: string, options: { runCommand?: typeof runCommand; gitTools?: GitTools } = {}): Promise<void> {
  const release = await acquirePublication(dir);
  const files: string[] = [];
  try {
    const state = readRun(dir) as PublicationState;
    writeFileSync(join(dir, 'progress.txt'), progressText(state) + '\n', { mode: 0o600 });
    writeFileSync(join(dir, 'progress.html'), renderDashboard(state), { mode: 0o600 });
    if (!authorized(state)) return;
    if (state.kind !== 'code' || !state.git || !state.candidate) throw new Error('PR publication requires a code branch and pinned candidate.');
    const content = publicationBody(state);
    const digest = createHash('sha256').update(content).digest('hex');
    if (state.pr?.lastBodyHash === digest && publicationReady(state)) return;
    const tools = { ...(options.gitTools ?? defaultGitTools()), ...(options.runCommand ? { run: options.runCommand } : {}) };
    const command = async (argv: readonly string[], args: string[]): Promise<string> => {
      const [bin, ...prefix] = argv;
      if (!bin) throw new Error('Missing publication tool.');
      const result = await tools.run(bin, [...prefix, ...args], { cwd: state.cwd, timeoutMs: 60_000 });
      if (result.code || result.truncated) throw new Error(`Publication command failed: ${result.stderr || 'incomplete response'}`);
      return result.stdout.trim();
    };
    const gh = (args: string[]) => command(tools.gh, args);
    await gh(['bot']);
    await verifyBotIdentity(state.cwd, tools);
    const immutableFile = (suffix: string, body: string): string => {
      const path = join(dir, `publication-${randomUUID()}.${suffix}`);
      writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
      files.push(path);
      return path;
    };
    const bodyPath = immutableFile('md', content);
    // Push the pinned revision explicitly, never a branch that may have advanced.
    await command(tools.gitBot, ['push', state.git.remote ?? 'origin', `${state.candidate}:refs/heads/${state.git.branch}`]);
    let pr = state.pr;
    if (!pr) {
      const existing = JSON.parse(await gh(['pr', 'list', '--head', state.git.branch, '--state', 'open', '--json', 'url,number']));
      if (!Array.isArray(existing) || existing.length > 1) throw new Error('Ambiguous PR discovery.');
      pr = existing[0];
      if (!pr) {
        const url = await gh(['pr', 'create', '--draft', '--title', `wan loop: ${state.plan.goal.slice(0, 100)}`, '--body-file', bodyPath, '--head', state.git.branch]);
        pr = { url, number: Number(url.split('/').at(-1)) };
      }
      if (!pr?.url || !Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error('Could not identify PR.');
      withRun(dir, raw => { (raw as PublicationState).pr = pr; });
    }
    const repo = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository identity.');
    const endpoint = `repos/${repo}/issues/${pr.number}/comments`;
    let commentId = pr.commentId;
    let existingBody: string | undefined;
    if (!commentId) {
      const pages = JSON.parse(await gh(['api', endpoint, '--paginate', '--slurp']));
      if (!Array.isArray(pages)) throw new Error('Invalid comment discovery response.');
      const comments = pages.flat();
      const marker = `<!-- wan-loop:${state.id} -->`;
      const existing = comments.find(c => typeof c.body === 'string' && c.body.startsWith(marker) && c.user?.login === 'dougbot-agent');
      commentId = existing?.id;
      existingBody = existing?.body;
    }
    if (existingBody !== content) {
      const payload = immutableFile('json', JSON.stringify({ body: content }));
      const comment = JSON.parse(await gh(['api', commentId ? `repos/${repo}/issues/comments/${commentId}` : endpoint, '--method', commentId ? 'PATCH' : 'POST', '--input', payload]));
      commentId = comment.id;
    }
    if (!Number.isSafeInteger(commentId) || commentId! <= 0) throw new Error('Invalid progress comment ID.');
    // Confirm the actual PR head after remote writes, before recording success.
    const head = JSON.parse(await gh(['pr', 'view', String(pr.number), '--json', 'headRefOid'])).headRefOid;
    if (head !== state.candidate) throw new Error('PR head does not match the pinned candidate.');
    withRun(dir, raw => {
      const current = raw as PublicationState;
      if (current.candidate !== state.candidate) throw new Error('Candidate changed during publication; retry.');
      current.pr = { ...pr!, commentId, lastBodyHash: digest, publishedCandidate: head };
    });
  } finally {
    for (const path of files) { try { unlinkSync(path); } catch { /* Recoverable temporary payload. */ } }
    release();
  }
}
