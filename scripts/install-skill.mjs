#!/usr/bin/env node
/**
 * install-skill — copy the bundled `which-agent-next` Agent Skill into a harness's
 * skills directory. Dependency-free (Node ≥20 built-ins only) so it runs from a
 * global install or `npx` without a build step.
 *
 * A skill is just a directory containing SKILL.md, so "installing" is a copy.
 * Any harness that supports the skill format (Claude Code, the Agent SDK, and
 * others) reads it from its skills directory once it lands there.
 *
 *   which-agent-next-skill                 # → ~/.claude/skills/which-agent-next  (personal)
 *   which-agent-next-skill --project       # → ./.claude/skills/which-agent-next  (this repo)
 *   which-agent-next-skill --dir <path>    # → <path>/which-agent-next (any harness)
 *   which-agent-next-skill --print         # print the source skill dir and exit
 *   which-agent-next-skill --force         # overwrite an existing install
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = resolve(HERE, "..", "skill");
const SKILL_NAME = "which-agent-next";

function parseArgs(argv) {
  const opts = { target: "global", dir: null, force: false, print: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--global" || a === "-g") opts.target = "global";
    else if (a === "--project" || a === "-p") opts.target = "project";
    else if (a === "--dir" || a === "-d") {
      opts.target = "dir";
      opts.dir = argv[++i];
      if (!opts.dir) fail("--dir needs a path");
    } else if (a === "--force" || a === "-f") opts.force = true;
    else if (a === "--print") opts.print = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else fail(`unknown argument: ${a}`);
  }
  return opts;
}

function fail(msg) {
  console.error(`install-skill: ${msg}`);
  process.exit(1);
}

/** True if an executable named `bin` (or `bin.exe`/`.cmd` on Windows) is on PATH. */
function onPath(bin) {
  const names = process.platform === "win32" ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

const HELP = `Install the which-agent-next Agent Skill into a harness's skills directory.

Usage:
  which-agent-next-skill [--global | --project | --dir <path>] [--force]
  which-agent-next-skill --print
  which-agent-next-skill --help

Targets:
  --global, -g        ~/.claude/skills/which-agent-next   (default; personal skills)
  --project, -p       ./.claude/skills/which-agent-next   (checked into this repo)
  --dir, -d <path>    <path>/which-agent-next  (any harness's skills dir)

Options:
  --force, -f         Overwrite an existing which-agent-next skill at the target.
  --print             Print the bundled skill's source path and exit.

A skill is a directory containing SKILL.md; this just copies it into place.
Point any harness that supports the skill format at the resulting directory.`;

function skillsDirFor(opts) {
  switch (opts.target) {
    case "global":
      return join(homedir(), ".claude", "skills");
    case "project":
      return join(process.cwd(), ".claude", "skills");
    case "dir":
      return resolve(opts.dir);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (!existsSync(join(SKILL_SRC, "SKILL.md"))) {
    fail(`bundled skill not found at ${SKILL_SRC} (expected SKILL.md)`);
  }
  if (opts.print) {
    console.log(SKILL_SRC);
    return;
  }

  const skillsDir = skillsDirFor(opts);
  const dest = join(skillsDir, SKILL_NAME);

  if (existsSync(dest)) {
    if (!opts.force) {
      fail(`${dest} already exists — pass --force to overwrite`);
    }
    rmSync(dest, { recursive: true, force: true });
  }

  mkdirSync(skillsDir, { recursive: true });
  cpSync(SKILL_SRC, dest, { recursive: true });

  console.log(`✔ installed which-agent-next skill → ${dest}`);

  // A gentle nudge: the skill drives the `which-agent-next` binary, which is separate.
  if (!onPath("which-agent-next")) {
    console.log(
      "\nNote: the skill runs the `which-agent-next` CLI, which isn't on your PATH yet.\n" +
        "Install it with:  npm install -g @sethwebster/which-agent-next",
    );
  }

  console.log(
    "\nMost harnesses pick the skill up automatically once it's in their skills\n" +
      "directory. If yours reads a different location, copy it there directly:\n" +
      `  cp -R "${dest}" <harness-skills-dir>/`,
  );
}

main();
