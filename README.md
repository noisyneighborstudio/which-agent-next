# which-agent-next

Looks at the agent CLIs installed on this machine — and every profile they're
logged into — checks how much usage each has left, and prints the command to
run the best one next.

```console
$ which-agent-next
claude-expoio

$ which-agent-next --explain
→ claude-expoio
  Claude Code (ExpoIO) — 32% headroom (7d window 68% used); Grok is unknown

AGENT                 TIER     LEFT  WINDOWS         RESETS  COMMAND                          NOTE
Claude Code (ExpoIO)  ok       32%   5h 3% · 7d 68%  in 3d   claude-expoio
Grok                  unknown  –     –               –       grok                             signed in; no quota API exposed
Antigravity           unknown  –     –               –       agy                              installed; sign-in state and quota not exposed
opencode              unknown  –     –               –       opencode                         providers: openai, google, xai
Codex                 low      9%    7d 91%          in 3d   codex                            plan pro, as of 3h ago
Ollama (local)        local    –     –               –       ollama run qwen3:8b              11 local models, no quota

unavailable:
AGENT                  REASON
Claude Code (Default)  usage endpoint rate-limited (says nothing about account quota) — retry shortly
Claude Code (Expo)     not logged in (/Users/you/.claude-profiles/Expo)
Cursor Agent           no CLI credentials found — run `cursor-agent login`
```

Because the default output is just a command, it composes:

```sh
$(which-agent-next) -p "review this diff"     # run whoever has room
which-agent-next --run -- -p "review this"    # same, without the subshell
```

Or emit a stable identifier instead of a command, for scripts that do their own
dispatch:

```console
$ wan --id
claude|Default

$ wan --id --all          # the whole fallback chain, best first
claude|Default
agy
opencode
codex
ollama
```

`--id` prints `<cli>|<profile>` for CLIs that manage several accounts and a bare
`<cli>` for those that don't. The shape depends only on whether the CLI *has* a
profile concept, never on how many are currently configured, so adding or
removing a profile never changes an existing id.

### Passing flags to the agent

Everything after `--` goes to the agent untouched, including flags that collide
with this tool's own:

```sh
wan --run -- --json -p "review this"   # --json is the agent's, not ours
wan -- -p "review this"                # prints: claude-default -p 'review this'
```

Printed arguments are shell-quoted, so the line survives copy-paste or `eval`.
A misplaced agent flag is an error rather than a silent no-op:

```console
$ wan -p "review this"
which-agent-next: unknown option: -p — to pass it to the agent, put it after `--`
```

There is deliberately no `-p` shorthand for `--prefer`: `-p` is the standard
non-interactive flag for `claude` and `codex`, and squatting on it would turn a
misplaced agent flag into a silently ignored preference list.

## Execute a complete goal

```sh
wan loop "Build the feature described in the spec" --file spec.md --budget 2h
```

`wan loop` interviews where needed, asks you to approve acceptance criteria and
an overall budget, then coordinates short agent turns in tmux. It preserves work
across provider changes and restarts, and requires independent verification of
the complete goal. Code and non-code deliverables are supported. Merge,
deployment, and other external actions require explicit authorization.

See [the loop guide](docs/loop.md) for approval, progress, recovery, and plan formats.

## Install

```sh
npm install -g @sethwebster/which-agent-next    # provides `which-agent-next` and `wan`
```

Or run it without installing:

```sh
npx @sethwebster/which-agent-next --explain
npx @sethwebster/which-agent-next --id
```

## For agents

The package bundles an Agent Skill so a coding agent knows when to reach for
this and how to read the result — including which CLIs report real quota and
which report none:

```sh
which-agent-next-skill              # → ~/.claude/skills/which-agent-next
which-agent-next-skill --project    # → ./.claude/skills/which-agent-next
which-agent-next-skill --dir <path> # any harness's skills directory
npx -p @sethwebster/which-agent-next which-agent-next-skill
```

A skill is just a directory containing `SKILL.md`, so installing it is a copy;
any harness that supports the format picks it up from its skills directory.

## Where the numbers come from

Quota is read from whatever each CLI actually exposes. Nothing is estimated —
a CLI that publishes no quota is reported as `unknown`, not guessed at.

| CLI | Profiles | Quota source |
| --- | --- | --- |
| **Claude Code** | one per `~/.claude-profiles` entry | live `api.anthropic.com/api/oauth/usage` per profile token — the same endpoint `/usage` reads, so it counts web and desktop usage too |
| **Codex** | single | the `rate_limits` snapshot Codex writes into its newest session rollout; reported with its age (`as of 3h ago`) |
| **Grok** | single | `~/.grok/auth.json` for sign-in state only — no quota API |
| **Antigravity** | single | `agy` on `PATH` only — credentials and quota not exposed |
| **Gemini CLI** | single | `~/.gemini/settings.json` auth type / `GEMINI_API_KEY` / Vertex / `GOOGLE_CLOUD_PROJECT` — no quota API. A personal Google sign-in is reported `unauthenticated`: Google moved individuals to Antigravity |
| **Cursor Agent** | single | credential presence only (`cursor-agent status` would start an interactive login, so it is never invoked) |
| **opencode** | single | configured providers from its `auth.json`; quota belongs to the upstream provider |
| **Muse Code** | single | `~/.config/muse/auth.json` (or `MUSE_AUTH_PATH`) / `META_API_KEY` for sign-in state only — sessions log tokens, not quota |
| **Ollama** | single | `/api/tags` on the local daemon — unmetered |

Claude profiles are read sequentially and cached for 60s: the usage endpoint
rate-limits a chatty caller. If a live read fails but a reading from the last
30 minutes exists, that one is used and labelled with its age. A `429` on the
usage endpoint is reported as exactly that — it says nothing about how much
quota the account itself has left.

## How "best" is decided

Candidates fall into tiers, best first:

| Tier | Meaning |
| --- | --- |
| `plenty` | ≥50% of the tightest window still free |
| `ok` | ≥20% free |
| `unknown` | authenticated, but the CLI publishes no quota |
| `low` | above `--min-headroom` (default 5%) but getting tight |
| `local` | unmetered local model — the last resort |
| `exhausted` | below `--min-headroom`; never picked |

Headroom comes from the window **closest to being spent**, so a fresh 5-hour
window can't hide a nearly-spent weekly one.

Within a tier, preference order decides — so a stronger agent is never demoted
over a few percent of quota. Only a real tier gap moves the pick. Default order
is `claude, codex, grok, agy, gemini, cursor-agent, opencode, muse, ollama`; override it
with `--prefer`.

`unknown` sits below everything measured and healthy and above anything nearly
spent, because inventing a percentage for a CLI that reports none would be a
made-up number.

## Options

```
-e, --explain          pick plus full table, with the reason
-t, --table            table only
-i, --id               emit `<cli>|<profile>` (e.g. claude|Default, codex)
-a, --all              emit every usable agent, best first, not just the pick
    --json             JSON: { winner, reason, candidates }, each with agentId
-r, --run              exec the winning command; args after `--` pass through
    --only <clis>      consider only these CLIs
-x, --exclude <ids>    skip these CLIs or candidate ids (e.g. claude:Work)
    --prefer <clis>    preference order for ties
    --min-headroom <n> treat below n% remaining as exhausted (default 5)
    --refresh          ignore cached quota reads
    --cache <ms>       reuse quota reads younger than this (default 60000)
    --timeout <ms>     per-probe timeout (default 8000)
    --config           print the config file path
```

Exit codes: `0` picked, `3` nothing available, `2` bad usage.

## Config

`~/.config/which-agent-next/config.json`, all keys optional:

```json
{
  "prefer": ["claude", "codex"],
  "exclude": ["cursor-agent", "claude:Scratch"],
  "minHeadroom": 5,
  "timeoutMs": 8000,
  "cacheMs": 60000,
  "staleMs": 1800000
}
```

## Notes

Probes run in parallel behind a timeout, so one hung CLI can't stall the
answer. macOS only for Claude profile detection (it reads the Keychain);
everything else is cross-platform.

## Releasing

Versions come from commit messages ([Conventional Commits](https://www.conventionalcommits.org)).
Every push to `main` updates one open release PR with the next version and
changelog; merging it tags, creates the GitHub release, and publishes to npm
from CI (trusted publishing, no token).

| Commit | Before 1.0 | From 1.0 |
| --- | --- | --- |
| `fix:` / `perf:` | patch | patch |
| `feat:` | minor | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | minor | major |
| `docs:` `test:` `ci:` `chore:` `refactor:` | no release | no release |

A commit without a type is ignored by the release. Never run `npm version` or
`npm publish` by hand.
