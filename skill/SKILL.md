---
name: which-agent-next
description: >-
  Pick which AI coding agent CLI to hand work to next, based on how much usage
  quota each one actually has left. Inspects every agent CLI installed on the
  machine and every profile it is logged into (Claude Code profiles, Codex,
  Grok, Gemini, Cursor, opencode, Muse, Ollama), reads real rate-limit data where the
  CLI exposes it, and prints the command or a `<cli>|<profile>` id for the best
  one. Use when dispatching or delegating a task to another agent CLI, when a
  run just failed on a rate limit, when deciding where to send heavy work, or
  when the user asks which agent or account to use, which has capacity left, or
  how much quota is remaining. Drives the `which-agent-next` CLI over the shell.
license: MIT
---

# which-agent-next

Requires the CLI: `npm install -g @sethwebster/which-agent-next` (or prefix calls with `npx -y @sethwebster/which-agent-next`).

`which-agent-next` (alias `wan`) answers one question: **of the agent CLIs on
this machine, which one should get the next job?** It reads each CLI's real
quota where that exists, ranks them, and prints the winner.

Use it before shelling out to another agent, not after one fails.

## Invoking it

The default output is a bare command, so it composes directly:

```sh
which-agent-next                          # → claude-expoio
$(which-agent-next) -p "review this diff" # run whoever has room
which-agent-next --run -- -p "review"     # same, no subshell
```

For your own dispatch logic, ask for a stable id instead of a command:

```sh
which-agent-next --id            # → claude|Default   (or bare `codex`)
which-agent-next --id --all      # the whole fallback chain, best first
```

`--id` emits `<cli>|<profile>` for CLIs with multiple accounts and a bare
`<cli>` for those without. The shape depends on whether the CLI *has* profiles,
never on how many are configured, so it is safe to match on.

To reason about the decision rather than just act on it:

```sh
which-agent-next --explain       # the pick, the reason, and every candidate
which-agent-next --json          # { winner, reason, candidates[] } with agentId
```

Exit codes: `0` picked, `3` nothing has capacity, `2` bad usage. **Check the
exit code** — on `3` there is no winner and stdout is empty.

## Passing flags to the agent

Everything after `--` is forwarded untouched, including flags that collide with
this tool's own:

```sh
which-agent-next --run -- --json -p "review this"   # --json goes to the agent
```

A bare agent flag placed *before* `--` is an error, not a silent no-op. There
is no `-p` shorthand for `--prefer`, precisely because `-p` belongs to the
agent.

## Reading the result

Candidates are bucketed into tiers, best first:

| Tier | Meaning |
| --- | --- |
| `plenty` | ≥50% of the tightest window still free |
| `ok` | ≥20% free |
| `unknown` | authenticated, but the CLI publishes no quota at all |
| `low` | still usable, but close to the limit |
| `local` | unmetered local model — last resort |
| `exhausted` | never picked |

Within a tier the preference order decides, so a stronger agent is not demoted
over a few percent of quota. Only a real tier gap moves the pick.

Headroom always comes from the window **closest to being spent**, so a fresh
5-hour window never masks a nearly-spent weekly one.

## What the numbers actually mean

Be precise about this when reporting to a user — the tool is, and overstating
it turns a guess into a fact:

- **Claude Code** — live, authoritative. Read per profile from the same
  endpoint the CLI's own `/usage` screen uses, so it includes usage from the
  web, desktop app, and other machines.
- **Codex** — a *cached snapshot* from its last request, labelled with its age
  (`as of 3h ago`). Real, but possibly stale.
- **Grok, Gemini, Cursor, opencode, Muse** — no quota API exists. They report
  `unknown`. This means *unmeasured*, *not* "has plenty". Never describe an
  `unknown` agent as having quota available.
- **Ollama** — local and unmetered; there is no quota to run out of.

`unknown` deliberately ranks below anything measured and healthy and above
anything nearly spent, because inventing a number for an unmeasurable CLI would
be a fabricated statistic.

## Failure modes worth knowing

- **A `429` on the Claude usage endpoint is not an exhausted account.** It means
  the usage endpoint throttled the check. The tool says so explicitly and marks
  the profile unavailable for this run; it tells you nothing about that
  account's remaining quota.
- **Expired tokens** show as `token expired — run <command> once to refresh`.
  That profile is fine, it just needs a login; don't report it as out of quota.
- Results are **cached for 60s**. Don't poll in a loop — the upstream endpoint
  rate-limits chatty callers, which is what produces the `429` above. Pass
  `--refresh` only when you genuinely need a fresh read.

## Narrowing the field

```sh
which-agent-next --only claude          # just Claude profiles
which-agent-next --exclude codex        # skip a cli, or one id: claude:Scratch
which-agent-next --prefer codex,claude  # override tie-break order
which-agent-next --min-headroom 20      # demand more slack than the 5% default
```

## Reporting to a user

Quote the tier and the binding window, not just a single percentage — "ExpoIO,
32% left on the 7-day window" beats "ExpoIO looks fine". If the pick is `low`
or `local`, say so plainly: that is the tool telling you everything good is
spent.
