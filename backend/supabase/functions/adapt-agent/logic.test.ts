// Run: node backend/supabase/functions/adapt-agent/logic.test.ts   (Node 23.6+, no deps)
import assert from "node:assert/strict";
import { analyze, buildTemplate, fmtDates, loosenRule, rewordIsFaithful, validProposedRule, type DayLog, type Rule } from "./logic.ts";

const R = (texts: string[], labels: Record<number, string> = {}): Rule[] =>
  texts.map((t, i) => ({ index: i, rule: t, raw: t, label: labels[i] ?? null }));
const day = (date: string, texts: string[], done: boolean[], pivot = false): DayLog =>
  ({ log_date: date, is_pivot: pivot, rules: texts.map((t, i) => ({ t, done: done[i] })) });

// dates
assert.equal(fmtDates(["2026-09-22", "2026-09-20"]), "Sep 20, 22");
assert.equal(fmtDates(["2026-09-02", "2026-08-31"]), "Aug 31, Sep 2");

// loosenRule: caps go up, amounts go down, clock times are left alone
assert.equal(loosenRule("Social Media < 30 min"), "Social Media < 45 min");
assert.equal(loosenRule("Screen Time < 3 hours"), "Screen Time < 4.5 hours");
assert.equal(loosenRule("20 min walk & 30 sec sprint"), "10 min walk & 15 sec sprint");
assert.equal(loosenRule("15 mins Looks-maxing"), "7.5 mins Looks-maxing");
assert.equal(loosenRule("Be Productive 8hr/Day"), "Be Productive 4hr/Day");
assert.equal(loosenRule("3L Water Intake (Monsoon)"), "1.5L Water Intake (Monsoon)");
assert.equal(loosenRule("Sleep at 11:30 PM"), null);
assert.equal(loosenRule("Wake up at 7:30 AM"), null);
assert.equal(loosenRule("Business 9AM–8PM"), null);
assert.equal(loosenRule("Avoid Phone before 12pm & after 10pm"), null);
assert.equal(loosenRule("3 Adequate Meals"), null);
assert.equal(loosenRule("No Porn"), null);

// rule_change: exact count and dates (the old "2 of 2" bug: the model miscounted)
const T = ["Read 20 pages", "Sleep at 11 PM", "No sugar", "Walk 30 min"];
const logs = [ // newest first
  day("2026-09-22", T, [false, true, true, true]),
  day("2026-09-21", T, [true, true, false, true], true), // pivot: ignored
  day("2026-09-20", T, [false, true, true, false]),
  day("2026-09-19", T, [false, false, false, false]),    // 0% day: ignored
  day("2026-09-18", T, [true, true, true, false]),
  day("2026-09-15", T, [false, true, true, true]),
];
const a = analyze(R(T), logs);
assert.equal(a.mode, "rule_change");
if (a.mode !== "rule_change") throw 0;
assert.equal(a.target.index, 0);
const t = buildTemplate(a);
assert.equal(t.proposed_rule, "Read 10 pages");
assert.equal(t.reason, 'You missed "Read 20 pages" on 2 of your last 3 logged days (Sep 20, 22) and on 3 of 4 logged days in the last 14 days. A smaller version you can hit every day beats a rule you keep missing.');

// rough_patch
const logs2 = [
  day("2026-09-24", T, [false, false, false, true]),
  day("2026-09-22", T, [false, false, false, true]),
  day("2026-09-20", T, [true, true, false, true]),
];
const b = analyze(R(T, { 1: "!!!" }), logs2);
assert.equal(b.mode, "rough_patch");
if (b.mode !== "rough_patch") throw 0;
assert.equal(buildTemplate(b).reason, 'On 2 of your last 3 logged days you missed most of your rules (3 of 4 on Sep 22, 3 of 4 on Sep 24). When nearly everything slips together, no single rule is the problem. For 3 days, lock in only your !!! rules: "Sleep at 11 PM".');

// reword guard
const tpl = t.reason;
assert.ok(rewordIsFaithful(tpl, 'You skipped "Read 20 pages" on 2 of your last 3 logged days (Sep 20, 22), and 3 of 4 logged days over the last 14 days. Shrink it to something you hit daily.'));
assert.ok(!rewordIsFaithful(tpl, 'You skipped "Read 20 pages" on 2 of 2 logged days (Sep 20, 22), 3 of 4 in 14 days. 3 tries.')); // "2 of 3" became "2 of 2"
assert.ok(!rewordIsFaithful(tpl, 'You skipped "Read 20 pages" 5 times: 2 of 3 days (Sep 20, 22), 3 of 4 in 14 days.'));   // adds 5
assert.ok(!rewordIsFaithful(tpl, 'You skipped "Read 20 pages" on 2 of 3 days (20, 22), 3 of 4 in 14 days.'));              // drops the month
assert.ok(rewordIsFaithful(tpl, 'You missed "Read 20 pages" on 2 of 3 logged days (Sep 20, 22) and 3 of 4 in 14 days. Try 10 pages.', ["Read 10 pages"]));
assert.equal(validProposedRule("Read 20 pages", "Read 20 pages"), null);
assert.equal(validProposedRule("Read 10 pages", "Read 20 pages"), "Read 10 pages");

console.log("adapt-agent logic: all tests passed");
