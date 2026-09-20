# Run a goal with wan loop

`wan loop` keeps the full approved goal across short agent turns, provider switches, and process restarts. It supports code repositories and non-code artifacts. A worker's completion claim never ends the run. A fresh verifier checks a pinned candidate, and a separate supervisor decides whether its evidence is sufficient.

## Start with an interview

```sh
wan loop "Implement the behavior described in the supplied specification" --file specification.md --budget 2h
```

The budget is aggregate agent execution time. Two agents running for five minutes consume ten minutes. Planning, coordination, verification, and agent-based supervision also count. Waiting for quota and owned test jobs does not consume agent time. This is not dollar accounting or a limit on external-service charges.

The planner drafts acceptance criteria, deliverables, assignments, and verification commands. Material questions include a marked recommendation, alternatives, and free-text answers. Answers persist across restarts. Review the exact plan, permissions, and budget before approving execution. The loop flags an estimate that exceeds the remaining budget instead of quietly reducing scope.

Use `wan loop plan` to interview and approve without launching. Use `wan loop approve <run> --plan edited-plan.json` to review an edited draft. An approved plan is immutable; start a new run to change its goal or permissions.

For automation, provide a reviewed JSON plan explicitly:

```sh
wan loop start --plan plan.json --approve --host-limits-accepted
```

`--approve` requires a plan file. It cannot approve an unseen plan inferred from a goal string. The explicit host acknowledgment applies to unattended starts.

## Inspect and control a run

```sh
wan loop status <run>
wan loop status <run> --json
wan loop attach <run>
wan loop stop <run>
wan loop resume <run>
wan loop extend <run> --budget 4h
wan loop dashboard <run>
```

`extend` authorizes a new total budget, not another allocation of that size. It preserves all usage. Draft extensions retain planning work and answers, while still requiring plan approval.

Each invocation targets a three-minute checkpoint and has a five-minute hard deadline. The default is two workers. Code assignments use separate worktrees with explicit ownership and base revisions. Artifact assignments use isolated copies. The coordinator inspects actual changes before integration. Worker failures retain their partial work for reconciliation.

An allocation ends after 24 agent invocations or two aggregate agent hours. The supervisor automatically renews useful allocations within the overall budget. Increasing that budget requires explicit authorization. A known quota reset causes a wait and automatic retry. Unknown capacity or repeated failures without a viable new strategy cause a durable pause.

## Host availability and recovery

The controller runs in a named `wan-<run>` tmux session. A separate `wan-<run>-monitor` session hosts the monitor and local dashboard. Detaching or closing the calling terminal does not stop them. Terminal logs persist after exit.

The current host must remain available. tmux cannot execute while the host sleeps or is powered off. `--keep-awake` explicitly authorizes sleep inhibition during execution.

Opt into recovery after reboot:

```sh
wan loop service
wan loop service --install
```

The first command previews the user-service definition. The second installs it. macOS LaunchAgents and Linux user services normally start after user login. Boot-time Linux execution without login requires administrator-configured lingering. Recovery checks process ownership, jobs, and remaining budget before starting anything. It does not resume user-stopped, exhausted, or completed runs.

The monitor checks process health independently of the chat application. Agent-based supervisory assessments are initially scheduled every ten minutes and at execution checkpoints. Healthy workers keep their assignments. Dead controllers, overdue processes, and interrupted integration are reconciled before retrying.

## Progress and deliverables

The dashboard binds only to `127.0.0.1`. Remote access requires a secure connection that you configure, such as an SSH tunnel. wan does not expose a public listener or automatically publish local files.

For code work, the interview offers explicit `github:pr` permission. This permits one bot-authored PR and one editable progress comment. It does not authorize merge or deployment. Required PR publication must match the verified candidate before the run reports review readiness.

Progress distinguishes assignment implementation, command results, and independent acceptance evidence. It shows open criteria, blockers, the candidate, cumulative usage, and supervisory findings. Unchanged heartbeats do not produce remote updates. After completion, static progress files remain available; `wan loop dashboard <run>` can serve them again.

`READY_FOR_REVIEW` means the approved deliverables are independently verified and await human review. `COMPLETE` means explicitly authorized external outcomes also passed post-action checks and fresh independent review. Neither status means that a partial goal was accepted.

## Plan format and external actions

The required plan fields are `goal`, `budgetMs`, `criteria`, `deliverables`, `permissions`, `verificationCommands`, and `tasks`. The optional `estimatedMs` is an estimate of remaining agent time, not a spending allowance.

```json
{
  "goal": "Create a release checklist document",
  "budgetMs": 1800000,
  "criteria": [{ "id": "checklist", "description": "release.md covers every requirement in the supplied brief", "verification": "Independently compare the document with the brief" }],
  "deliverables": ["release.md"],
  "permissions": [],
  "verificationCommands": ["test -s release.md"],
  "tasks": [{ "id": "write", "title": "Write the complete checklist", "instructions": "Read the brief and write release.md covering every requirement", "ownership": ["release.md"], "criteria": ["checklist"], "dependsOn": [], "status": "pending", "attempts": 0, "failures": 0 }]
}
```

Paths in `ownership` are relative files or subtrees such as `src/**`. `**` owns the workspace, excluding controller and Git metadata. Dependencies refer to task IDs. Inputs stay in the original workspace; execution and deliverables use isolated directories in the run store.

External effects require explicit actions in the approved plan:

```json
{
  "permissions": ["deploy:staging"],
  "actions": [{
    "id": "deploy",
    "description": "Deploy the independently verified candidate to staging",
    "permission": "deploy:staging",
    "command": "./scripts/deploy-staging.sh",
    "verificationCommand": "./scripts/check-staging.sh"
  }]
}
```

This fragment extends a full plan. Commands execute exactly as approved with the execution host's credentials. The environment variables `WAN_CANDIDATE_REVISION` and `WAN_ACTION_ID` are set for action and post-action commands, binding them to the verified candidate. Commands that modify external state should check the candidate revision to avoid operating on an unverified target. Each action gets an independent job identity, so distinct actions with the same command execute and verify separately. Criteria about the resulting external state use `"phase": "outcome"`; other criteria describe the deliverable before any action. At least one deliverable criterion is required. A fresh verifier and supervisor inspect the candidate before actions. Post-action commands and a new independent review establish the final outcome. Ambiguous external failures are preserved for diagnosis, never blindly replayed.

Verification commands must test the pinned source or artifact rather than repair it. Code builds may produce ignored build output, but cannot change tracked source or add untracked deliverables. Artifact verification cannot change the artifact. Jobs run in owned process groups and preserve logs across controller restarts.

## Provider and platform limits

The selector continues using wan's measured quota and preference rules. Missing quota remains unknown. Adapters check the installed CLI's required flags before invoking it. Claude and Codex support implementation and read-only planning/review roles. Other installed CLIs are eligible only for roles their adapters can support without a permission-bypass flag. Unsupported combinations are reported instead of guessed.

The host runtime targets macOS and Linux with Node 20+, tmux, and `ps`. Code writes require the configured `dougbot-agent` identity. On macOS, Git writes use `git dougbot`; GitHub writes activate and verify the bot account. wan never purchases extra capacity.

The durable run store defaults to `$XDG_STATE_HOME/which-agent-next/loops`, or `~/.local/state/which-agent-next/loops`. Use `--root` or `WAN_LOOP_HOME` to choose another location outside the input workspace. Keep this directory private: it contains prompts, agent logs, and verification evidence.
