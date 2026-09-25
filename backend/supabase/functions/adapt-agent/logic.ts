// Pure, deterministic part of adapt-agent: no I/O, no Deno APIs, so it can be tested
// locally with plain Node (`node backend/supabase/functions/adapt-agent/logic.test.ts`).
//
// analyze() decides WHAT to suggest; buildTemplate() writes the suggestion and its reason
// from exact numbers and dates. The template is the complete, working output: Gemini, when
// available, only rewords it (checked by rewordIsFaithful()).

export const MAX_RULE_LEN = 100;
export const LOOKBACK_DAYS = 14;       // how far back evidence and miss streaks are read
export const EVIDENCE_DAYS = 3;        // last N logged (non-pivot) days used to judge rules
export const ROUGH_PATCH_SHARE = 0.7;  // share of rules missed on a day that makes it a "rough" day
export const FOCUS_DAYS = 3;
export const CRITICAL_LABEL = "!!!";

// `raw` is the exact stored text (what accept_rule_adaptation compares against);
// `rule` is the cleaned text used to match rules across logs.
export type Rule = { index: number; rule: string; raw: string; label: string | null };
export type DayLog = { log_date: string; day_number?: number; status?: string; score?: number; is_pivot: boolean; rules: Array<{ t?: string; done?: boolean }> };
export type RuleStat = {
  index: number; rule: string; critical: boolean;
  misses_in_evidence: number; missed_dates: string[];
  streak_start: string | null; misses_in_lookback: number;
};
export type Analysis =
  | { mode: "none"; why: string }
  | { mode: "rough_patch"; evidence_days: string[]; rough_days: Array<{ date: string; missed: number; total: number }>; focus: Array<{ index: number; t: string }>; focus_basis: "!!! rules" | "most-kept rules" }
  | { mode: "rule_change"; evidence_days: string[]; logged_in_lookback: number; target: RuleStat; failing: RuleStat[] };
export type Template = { proposed_rule: string | null; reason: string };

export function clean(s: unknown, max: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// First date that might still be "today" for the user. We don't store timezones, and
// every real one is within UTC-12..UTC+14, so a user's local date is never earlier than
// the UTC date 12 hours ago. Reading only log_date < this never includes their today.
// (East of UTC+11 it can also skip one already-completed day — the safe direction.)
export function completedBefore(now = Date.now()): string {
  return new Date(now - 12 * 3600000).toISOString().slice(0, 10);
}

// Deterministic decision: which kind of suggestion (if any), and which rule.
export function analyze(rules: Rule[], logs: DayLog[] /* newest first, lookback window, completed days only */): Analysis {
  const logged = logs.filter((l) => !l.is_pivot && Array.isArray(l.rules) && l.rules.length
    && l.rules.some((r) => r?.done)); // 0% days aren't rule evidence
  const evidence = logged.slice(0, EVIDENCE_DAYS);
  if (!evidence.length) return { mode: "none", why: "no logged (non-pivot) days to judge rules by" };
  const majority = (k: number) => k * 2 > evidence.length;
  const evidenceDates = evidence.map((d) => d.log_date);

  // true = missed, false = done, null = rule not on that day's list (didn't exist then)
  const missedOn = (day: DayLog, text: string): boolean | null => {
    const e = day.rules.find((r) => clean(r?.t, 140) === text);
    return e ? !e.done : null;
  };

  // Rough patch: most evidence days had >= 70% of that day's rules missed.
  const rough = evidence
    .map((d) => ({ date: d.log_date, missed: d.rules.filter((r) => !r?.done).length, total: d.rules.length }))
    .filter((d) => d.missed / d.total >= ROUGH_PATCH_SHARE);
  if (majority(rough.length)) {
    // Up to 3 focus rules (the user can change the picks on the card): their !!! rules,
    // or if they have none, the rules they kept most often. Most-kept first either way.
    const byKept = (pool: Rule[]) => pool
      .map((r) => ({ r, kept: logged.filter((d) => missedOn(d, r.rule) === false).length }))
      .sort((a, b) => b.kept - a.kept || a.r.index - b.r.index);
    const critical = rules.filter((r) => r.label === CRITICAL_LABEL);
    let basis: "!!! rules" | "most-kept rules" = "!!! rules";
    let focus = byKept(critical).slice(0, 3).map((x) => x.r);
    if (!focus.length) {
      basis = "most-kept rules";
      focus = byKept(rules).filter((x) => x.kept > 0).slice(0, 3).map((x) => x.r);
    }
    if (!focus.length) return { mode: "none", why: "rough patch but no rules to focus on" };
    return { mode: "rough_patch", evidence_days: evidenceDates, rough_days: rough,
             focus: focus.map((r) => ({ index: r.index, t: r.raw })), focus_basis: basis };
  }

  // Per-rule evidence: only actual misses on logged days count against a rule.
  const stats: RuleStat[] = rules.map((r) => {
    let streakStart: string | null = null;
    for (const d of logged) {            // newest -> oldest
      const m = missedOn(d, r.rule);
      if (m === true) streakStart = d.log_date; else break;
    }
    const missedDates = evidence.filter((d) => missedOn(d, r.rule) === true).map((d) => d.log_date);
    return {
      index: r.index, rule: r.rule, critical: r.label === CRITICAL_LABEL,
      misses_in_evidence: missedDates.length, missed_dates: missedDates,
      streak_start: streakStart,
      misses_in_lookback: logged.filter((d) => missedOn(d, r.rule) === true).length,
    };
  });
  const failing = stats.filter((s) => majority(s.misses_in_evidence));
  if (!failing.length) return { mode: "none", why: "no rule failed on most of the last logged days" };

  let pool = failing.filter((s) => !s.critical);
  if (!pool.length) {
    if (failing.length === 1) pool = failing; // a !!! rule only when it's the ONLY rule failing
    else return { mode: "none", why: `only !!! rules are failing (${failing.length}); not loosening them` };
  }
  pool.sort((a, b) =>
    (a.streak_start ?? "9999").localeCompare(b.streak_start ?? "9999") ||
    b.misses_in_lookback - a.misses_in_lookback ||
    a.index - b.index);
  return { mode: "rule_change", evidence_days: evidenceDates, logged_in_lookback: logged.length, target: pool[0], failing };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ["2026-09-22","2026-09-20"] -> "Sep 20, 22"; across months -> "Aug 31, Sep 2". Oldest first.
export function fmtDates(dates: string[]): string {
  const sorted = [...dates].sort();
  let lastMonth = -1;
  return sorted.map((d) => {
    const m = Number(d.slice(5, 7)) - 1, day = Number(d.slice(8, 10));
    const s = m === lastMonth ? String(day) : `${MONTHS[m]} ${day}`;
    lastMonth = m;
    return s;
  }).join(", ");
}

function shortRule(t: string): string {
  const c = clean(t, 140);
  return c.length > 45 ? c.slice(0, 44).trimEnd() + "…" : c;
}

function fmtNum(v: number): string {
  const r = v >= 10 ? Math.round(v) : Math.round(v * 2) / 2;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// Amount units only. Clock times ("11:30 PM", "9AM", "10pm") never match, so rules built
// around a time are left to the model (or skipped) instead of being mangled.
const UNIT = String.raw`(min(?:ute)?s?|hours?|hrs?|h|sec(?:ond)?s?|s|pages?|km|miles?|mi|reps?|push-?ups?|squats?|steps|glasses|cups|l|liters?|litres?)`;
const CAP_RE = new RegExp(String.raw`(<|≤|under|max|less than|below|at most)(\s*)(\d+(?:\.\d+)?)(\s*)${UNIT}(?![\w:])`, "i");
const QTY_RE = new RegExp(String.raw`(?<![\d:.])(\d+(?:\.\d+)?)(\s*)${UNIT}(?![\w:])`, "gi");

// Deterministic "smaller dose" of a rule, or null when there's no amount to adjust.
//   a cap ("Social Media < 30 min")  -> loosened by half ("< 45 min")
//   a target ("20 min walk")         -> halved ("10 min walk"); amounts <= 1 are left alone
export function loosenRule(rule: string): string | null {
  const text = clean(rule, 140);
  let out: string;
  if (CAP_RE.test(text)) {
    out = text.replace(CAP_RE, (_m, op, s1, n, s2, unit) => `${op}${s1}${fmtNum(Number(n) * 1.5)}${s2}${unit}`);
  } else {
    out = text.replace(QTY_RE, (m, n, sp, unit) => Number(n) <= 1 ? m : `${fmtNum(Number(n) / 2)}${sp}${unit}`);
  }
  return out !== text && out.length <= MAX_RULE_LEN ? out : null;
}

export function buildTemplate(a: Exclude<Analysis, { mode: "none" }>): Template {
  const n = a.evidence_days.length;
  if (a.mode === "rough_patch") {
    const days = [...a.rough_days].sort((x, y) => x.date.localeCompare(y.date))
      .map((d) => `${d.missed} of ${d.total} on ${fmtDates([d.date])}`).join(", ");
    const names = a.focus.map((f) => `"${shortRule(f.t)}"`).join(", ");
    const which = a.focus_basis === "!!! rules" ? "your !!! rules" : "the rules you kept most";
    return {
      proposed_rule: null,
      reason: `On ${a.rough_days.length} of your last ${n} logged days you missed most of your rules (${days}). ` +
        `When nearly everything slips together, no single rule is the problem. ` +
        `For ${FOCUS_DAYS} days, lock in only ${which}: ${names}.`,
    };
  }
  const t = a.target;
  const lookback = a.logged_in_lookback > n && t.misses_in_lookback > t.misses_in_evidence
    ? ` and on ${t.misses_in_lookback} of ${a.logged_in_lookback} logged days in the last ${LOOKBACK_DAYS} days`
    : "";
  return {
    proposed_rule: loosenRule(t.rule),
    reason: `You missed "${shortRule(t.rule)}" on ${t.misses_in_evidence} of your last ${n} logged days ` +
      `(${fmtDates(t.missed_dates)})${lookback}. A smaller version you can hit every day beats a rule you keep missing.`,
  };
}

const pairs = (s: string) =>
  new Set([...s.matchAll(/(\d+) of (?:your |the )?(?:last )?(\d+)/g)].map((m) => `${m[1]}/${m[2]}`));
const nums = (s: string) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? []);

// A reworded reason is only used if it keeps every number/date from the template and
// adds none of its own, and keeps each "X of Y" count intact.
export function rewordIsFaithful(template: string, reworded: string, allowedExtra: string[] = []): boolean {
  if (reworded.length < 20 || reworded.length > 600) return false;
  const want = nums(template), got = nums(reworded);
  const allowed = new Set([...want, ...allowedExtra.flatMap((s) => [...nums(s)])]);
  for (const x of want) if (!got.has(x)) return false;
  for (const x of got) if (!allowed.has(x)) return false;
  for (const m of MONTHS) if (template.includes(m + " ") && !reworded.includes(m)) return false;
  // Counts must survive as pairs: "2 of 3" can't turn into "2 of 2" by reusing numbers.
  const got2 = pairs(reworded);
  for (const pair of pairs(template)) if (!got2.has(pair)) return false;
  return true;
}

// Validates a model-proposed rule for a rule_change; null if unusable.
export function validProposedRule(proposed: unknown, current: string): string | null {
  const p = clean(proposed, 200);
  if (p.length < 3 || p.length > MAX_RULE_LEN) return null;
  if (p.toLowerCase() === clean(current, 140).toLowerCase()) return null;
  return p;
}
