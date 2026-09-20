import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { validatePlan, approveRun, type Plan } from './state.js';
import { type Question, plannerPrompt, duration, object } from './protocol.js';
import { mutate, stateOf, event, runTurn } from './engine.js';

export async function ask(question: Question): Promise<string> {
  if (!stdin.isTTY) throw new Error(`Input required: ${question.title}. Resume the interview in a terminal or supply an explicit approved plan.`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${question.title}`);
    question.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}${option.recommended ? ' (Recommended)' : ''}${option.description ? ` — ${option.description}` : ''}`));
    while (true) {
      const answer = (await rl.question('Choose a number or enter your answer: ')).trim();
      if (!answer) { console.log('Choose an answer explicitly.'); continue; }
      if (/^\d+$/.test(answer)) {
        const option = question.options[Number(answer) - 1];
        if (!option) { console.log('That option is not listed.'); continue; }
        return option.label;
      }
      return answer;
    }
  } finally { rl.close(); }
}

export async function askBudget(): Promise<number> {
  return duration(await ask({ id: 'budget', title: 'Set the total aggregate agent execution-time budget. Concurrent agents each consume time; extensions need approval.', options: [
    { label: '2h', description: 'A bounded starting budget; planning and independent verification count.', recommended: true },
    { label: '1h', description: 'A smaller starting allocation.' },
  ] }));
}

function questionsFrom(value: unknown): Question[] {
  if (!Array.isArray(value)) throw new Error('Planner must return a questions array.');
  return value.map(raw => {
    const q = object(raw);
    if (typeof q.id !== 'string' || typeof q.title !== 'string' || !Array.isArray(q.options)) throw new Error('Invalid interview question.');
    const options = q.options.map(rawOption => {
      const option = object(rawOption);
      if (typeof option.label !== 'string') throw new Error('Question needs answer labels.');
      return { label: option.label, description: typeof option.description === 'string' ? option.description : undefined, recommended: option.recommended === true };
    });
    if (!options.length || options.filter(o => o.recommended).length !== 1) throw new Error('Each interview question must mark exactly one recommendation.');
    return { id: q.id, title: q.title, options };
  });
}

export async function draftPlan(dir: string): Promise<void> {
  const state = stateOf(dir);
  if (state.approvedHash) throw new Error('Cannot replace an approved plan.');
  const turn = await runTurn(dir, 'planner', plannerPrompt(state), state.cwd);
  if (!turn?.report) throw new Error(turn?.error ?? 'No planning provider available. Draft and budget were preserved.');
  const plan = object(turn.report.plan) as unknown as Plan;
  if (plan.budgetMs !== state.budget.limitMs) throw new Error('Planner changed the authorized budget.');
  validatePlan(plan);
  const questions = questionsFrom(turn.report.questions);
  mutate(dir, s => {
    s.plan = plan; s.questions = questions; s.status = 'DRAFT';
    event(s, 'plan-drafted', `${plan.criteria.length} acceptance criteria; ${plan.tasks.length} assignments; user approval pending`);
  });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
}

export async function interview(dir: string, suppliedPlan = false): Promise<void> {
  if (stateOf(dir).approvedHash) return;
  if (!suppliedPlan && !stateOf(dir).events.some(e => e.type === 'plan-drafted')) await draftPlan(dir);
  // Answers may change the draft, so resolve material ambiguity before the approval question.
  for (let round = 0; round < 5; round++) {
    const unanswered = stateOf(dir).questions.filter(q => !(q.id in stateOf(dir).answers));
    if (!unanswered.length) break;
    for (const question of unanswered) {
      const answer = await ask(question);
      mutate(dir, s => { s.answers[question.id] = answer; event(s, 'interview-answer', `${question.id}: ${answer}`); });
    }
    await draftPlan(dir);
    if (round === 4 && stateOf(dir).questions.some(q => !(q.id in stateOf(dir).answers))) throw new Error('Unresolved material questions remain. Draft preserved; resume the interview.');
  }
  if (!suppliedPlan && stateOf(dir).kind === 'code' && !stateOf(dir).answers.prPublication) {
    const answer = await ask({ id: 'prPublication', title: 'Authorize a bot-authored PR and one editable progress comment for this run? Merge and deployment remain separately authorized.', options: [
      { label: 'Create and maintain the PR', recommended: true }, { label: 'Keep deliverables local for review' },
    ] });
    mutate(dir, s => {
      s.answers.prPublication = answer;
      if (answer === 'Create and maintain the PR') { if (!s.plan.permissions.includes('github:pr')) s.plan.permissions.push('github:pr'); if (!s.plan.deliverables.includes('Independently verified GitHub PR')) s.plan.deliverables.push('Independently verified GitHub PR'); }
    });
  }
  const state = stateOf(dir);
  console.log(`\nPlan for approval\n${JSON.stringify(state.plan, null, 2)}\n\nExecution workspace: ${state.cwd}\nPlanning used ${(state.budget.usedMs / 60000).toFixed(1)} agent minutes.`);
  if ((state.plan.estimatedMs ?? 0) > state.budget.limitMs - state.budget.usedMs) throw new Error('The estimated remaining work exceeds the remaining budget. Explicitly increase the draft budget or revise the goal before approval.');
  if (!state.answers.hostLimits) {
    const answer = await ask({ id: 'hostLimits', title: 'This run uses the current host. Sleep or power loss stops work; tmux survives disconnection, not reboot. A user host service resumes after login when installed.', options: [
      { label: 'Acknowledge these limits and continue', recommended: true }, { label: 'Leave this plan as a draft' },
    ] });
    if (answer !== 'Acknowledge these limits and continue') throw new Error('Plan saved as a draft.');
    mutate(dir, s => { s.answers.hostLimits = answer; });
  }
  const answer = await ask({ id: 'approval', title: 'Approve this exact plan, acceptance criteria, permissions, and total budget for execution?', options: [
    { label: 'Approve this plan', recommended: true }, { label: 'Save draft for editing' },
  ] });
  if (answer !== 'Approve this plan') throw new Error(`Draft saved at ${join(dir, 'plan.json')}. Edit it and use wan loop approve <run> --plan <file>.`);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(stateOf(dir).plan, null, 2) + '\n', { mode: 0o600 });
  mutate(dir, s => approveRun(s));
}

export function applyPlanFile(dir: string, path: string): void {
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  validatePlan(plan);
  mutate(dir, state => {
    if (state.approvedHash) throw new Error('Approved scope is immutable. Start a new run for revised criteria or permissions.');
    if (plan.budgetMs !== state.budget.limitMs) throw new Error('Use an explicit budget extension before changing the plan budget.');
    state.plan = plan; state.questions = []; event(state, 'plan-supplied', path);
  });
}
