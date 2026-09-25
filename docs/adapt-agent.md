# adapt-agent: suggested rule adjustments

A daily agent that notices when someone is slipping and suggests **one** easier or clearer version of the rule that's breaking them. It never changes rules itself. The user sees a "Suggested adjustment" card on the dashboard and accepts or rejects it.

## Flow

```
pg_cron (daily) ──> adapt-agent edge function            [x-internal-secret header]
                      │ adapt_agent_candidates()          users who missed 2+ of the last 3 days (max 10 per run)
                      │ per user:
                      │   analyze()        decides the suggestion (logic.ts, no AI)
                      │   buildTemplate()  writes it with exact numbers + dates (no AI)
                      │   optional: ONE Gemini call rewords it (ADAPT_AGENT_GEMINI_KEY)
                      │   insert ──> rule_adaptations (status = pending)
                      └ logs outcome + token usage per user + per batch

dashboard.html "Suggested adjustment" card
   Accept ─> confirm "Replace X with Y?" ─> accept_rule_adaptation()  (atomic: swaps that one rule + marks accepted)
   Reject ─> reject_rule_adaptation()
```

## AI is optional (free tier)

The template is the product; Gemini only polishes it.

- **Template (always):** e.g. *You missed "Social Media < 30 min" on 2 of your last 3 logged days (Sep 20, 22) and on 3 of 5 logged days in the last 14 days.* Counts and dates come straight from `analyze()`, so a miscount like "2 of 2" can't happen.
- **Rewording (optional):** only with `ADAPT_AGENT_GEMINI_KEY` (its own Gemini project). It **never** uses `GEMINI_API_KEY`, which is the user-facing ai-coach / analyze-journal quota. It makes one call per user, spaced 15s apart (free tier allows 5/min and 20/day). No new call is started after 100s; later users get the template.
- **Guard:** a reworded reason is used only if it keeps every number, month and "X of Y" count from the template and adds no new number. Otherwise the template is used.
- **Any error, timeout or 429 means the template is used.** A 429 also turns AI off for the rest of that run. The run never fails because of the model.
- **Proposed rule (rule_change):** the Gemini call may propose the adapted rule. Without it, `loosenRule()` scales the rule's amount: a cap is loosened by half (`< 30 min` → `< 45 min`) and a target is halved (`20 min walk` → `10 min walk`). Clock times (`Sleep at 11:30 PM`) and rules without an amount have no honest template, so **no row is written** and the next run tries again.
- Test the pure logic locally with `node backend/supabase/functions/adapt-agent/logic.test.ts`.

## Who gets a suggestion

`adapt_agent_candidates()` picks users who:
- logged at least once in the last 14 days (inactive users are left alone)
- missed **2 or more of the last 3 completed days**, where "missed" means no log that day or status `MISS`. A **pivot-protected day is never counted as missed**, because using a pivot is already the "adapt, don't reset" move, and it's never used as evidence.
- have had **no suggestion in the last 7 days**, whether pending, accepted or rejected

A user can also have at most one pending suggestion (unique index), and each run is capped at 10 users.

## What gets suggested (decided in code)

`analyze()` in `adapt-agent/logic.ts` makes the decision deterministically. The model never chooses the type or the rule.

- **Only completed days** are read, never the user's own today. There's no stored timezone, so the agent reads only `log_date` before the UTC date 12 hours ago. Every real timezone is between UTC−12 and UTC+14, so that date can never be anyone's today. At the 13:00 UTC cron this excludes exactly UTC-today; only users east of UTC+11 also lose their (completed) yesterday.
- **Evidence** is the user's last 3 **logged** days within 14 days. No-log days make someone a candidate, but they are never evidence against a specific rule; only an unchecked rule on a logged day counts. Pivot days and **0% days** are excluded too: a day with nothing checked says nothing about *which* rule failed, and editing the rule list can write an all-unchecked placeholder row. Rules are matched by text, so edits to the list don't misalign history.
- **`rough_patch`:** if on most evidence days (2 of 3) **70% or more of the rules were missed together**, no rule is blamed. The suggestion is *"For 3 days, only your !!! rules (n)."*: up to 3 of them, most-kept first. If there are no `!!!` rules, it's the 3 most-kept rules; other labels such as "Risk" are not critical. On the card the user **picks up to 3 focus rules** with checkboxes (the suggested ones are pre-selected), and accept saves the picks to `focus_rules`.
- **Focus mode:** after accepting a rough patch, the dashboard shows *"Focus mode · day X of 3"* above the rules and highlights the focus rules (the others are dimmed). Days count in the viewer's local time, starting from the day of acceptance, and the banner disappears after day 3. It is visual only: scoring, `saveTodayLog()` and `RULES` are untouched, and the **rule list never changes**.
- **`rule_change`:** otherwise, one failing rule (missed on most evidence days) gets an adapted version.
  - `!!!` rules are **never** loosened unless one is the *only* rule failing. Non-`!!!` rules always win.
  - Tie-break: the rule whose current miss streak **started first**, then the most misses in the 14-day window, then the lowest index.
- **Nothing** is eligible (e.g. only 2+ `!!!` rules failing): no suggestion, and no Gemini call.

## Data

- **Types:** `type` is `rule_change` (uses `rule_index`, `old_rule`, `proposed_rule`) or `rough_patch` (uses `proposed_rule`, `focus_rules` [{index,t}], `focus_days`; `rule_index`/`old_rule` are null). A check constraint enforces the shape.

- **Source:** `daily_logs` only (rule-by-rule done/missed per day from `daily_logs.rules`). No journal photos are stored.
- **`rule_adaptations`:** `id, user_id, rule_index, old_rule, proposed_rule, reason, status (pending|accepted|rejected), created_at, decided_at`. `old_rule` is kept so an undo can be added later.
- **RLS:** users can SELECT only their own rows. Nobody can insert, update or delete through the API. Inserts come from the edge function (service role), and decisions go through the two RPCs.

## Accept guarantees (`accept_rule_adaptation`)

- `accept_rule_adaptation(p_id, p_current_rules, p_focus_rules)`. For a rough patch, the picks must be 1–3 `{index, t}` entries and, when `profiles.rules` is stored, each must be one of those rules.
- Runs in one transaction. Either the rule changes **and** the row becomes `accepted`, or nothing changes.
- Replaces only `rules[rule_index].t`. Every other rule, and the adapted rule's label, is carried over unchanged.
- Refuses with `rule_changed` if that rule's text no longer equals `old_rule`.
- If `profiles.rules` is empty (user still on the app's default list), it uses the list the dashboard sends. Otherwise the stored list is the source of truth.

## Running it manually

```bash
curl -X POST https://qtlhpaqsmbyneivdsiei.supabase.co/functions/v1/adapt-agent \
  -H "x-internal-secret: $INTERNAL_WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>","dry_run":true}'   # omit user_id for a normal candidate run; omit dry_run to insert
                                              # add "no_ai":true for template only (no Gemini call)
```

Logs: Supabase dashboard → Edge Functions → adapt-agent → Logs. `adapt_agent_run` records each user's outcome, `source` (`ai` or `template`, and why AI wasn't used) and tokens. `adapt_agent_batch` records `gemini_calls` and `ai_disabled`.

## On merge to main: schedule the daily run

The branch deploys the table, RPCs and function but **does not schedule** them, so nothing runs for real users until this step. Run it once in the SQL editor with the real secret, and don't commit the secret:

```sql
select cron.schedule(
  'lckdin-adapt-agent',
  '0 13 * * *',  -- 13:00 UTC daily, before the 15:30 UTC reminder email
  $$
  select net.http_post(
    url := 'https://qtlhpaqsmbyneivdsiei.supabase.co/functions/v1/adapt-agent',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-internal-secret', '<INTERNAL_WEBHOOK_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

To stop it: `select cron.unschedule('lckdin-adapt-agent');`
