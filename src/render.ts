import type { Ranked } from "./rank.js";
import { tightest } from "./rank.js";
import { until } from "./util.js";

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint("1");
export const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const cyan = paint("36");

const TIER_COLOR: Record<string, (s: string) => string> = {
  plenty: green,
  ok: green,
  unknown: cyan,
  low: yellow,
  local: cyan,
  exhausted: red,
};

/** "5h 2% · 7d 72%" */
function windowsCell(c: Ranked): string {
  if (!c.windows.length) return dim("–");
  return c.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(" · ");
}

function resetsCell(c: Ranked): string {
  const t = tightest(c);
  return t?.resetsAt ? until(t.resetsAt) ?? dim("–") : dim("–");
}

function headroomCell(c: Ranked): string {
  if (c.headroom === undefined) return dim("–");
  const s = `${Math.round(c.headroom)}%`;
  return (TIER_COLOR[c.tier] ?? ((x: string) => x))(s);
}

/** Visible width, ignoring the ANSI escapes we just added. */
const width = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function table(rows: string[][], heads: string[]): string {
  const cols = heads.map((h, i) =>
    Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))),
  );
  const line = (cells: string[], style: (s: string) => string = (x) => x) =>
    cells
      .map((c, i) => style(c) + " ".repeat(Math.max(0, cols[i] - width(c))))
      .join("  ")
      .trimEnd();
  return [line(heads, dim), ...rows.map((r) => line(r))].join("\n");
}

export function renderTable(ranked: Ranked[]): string {
  const runnable = ranked.filter((c) => c.state !== "unauthenticated" && c.state !== "error");
  const blocked = ranked.filter((c) => c.state === "unauthenticated" || c.state === "error");
  const out: string[] = [];

  if (runnable.length) {
    out.push(
      table(
        runnable.map((c) => [
          c.eligible ? c.label : dim(c.label),
          (TIER_COLOR[c.tier] ?? ((x: string) => x))(c.tier),
          headroomCell(c),
          windowsCell(c),
          resetsCell(c),
          cyan(c.command),
          dim(c.note ?? ""),
        ]),
        ["AGENT", "TIER", "LEFT", "WINDOWS", "RESETS", "COMMAND", "NOTE"],
      ),
    );
  }
  if (blocked.length) {
    out.push(
      "",
      dim("unavailable:"),
      table(
        blocked.map((c) => [dim(c.label), dim(c.note ?? c.state)]),
        ["AGENT", "REASON"],
      ),
    );
  }
  return out.join("\n");
}

export function renderExplain(winner: Ranked | undefined, ranked: Ranked[], why?: string): string {
  const head = winner
    ? `${bold("→ " + winner.command)}\n  ${winner.label} — ${why ?? ""}`
    : red("no agent has usable capacity");
  return `${head}\n\n${renderTable(ranked)}`;
}
