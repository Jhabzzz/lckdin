# adapt-agent: suggested rule adjustments

A daily agent that notices when someone is slipping and suggests **one** easier or clearer version of the rule that's breaking them. It never changes rules itself. The user sees a "Suggested adjustment" card on the dashboard and accepts or rejects it.

## Flow

```
pg_cron (daily) ──> adapt-agent edge function            [x-internal-secret header]
                      │ adapt_agent_candidates()          users who missed 2+ of the last 3 days
                      │ per user, Gemini tool loop (≤5 tool steps):
                      │   get_recent_logs · get_journal_entries · get_user_rules
                      │   create_rule_adaptation ──> rule_adaptations (status = pending)
                      └ logs token usage per user + per batch

dashboard.html "Suggested adjustment" card
   Accept ─> confirm "Replace X with Y?" ─> accept_rule_adaptation()  (atomic: swaps that one rule + marks accepted)
   Reject ─> reject_rule_adaptation()
```

## Who gets a suggestion

`adapt_agent_candidates()` picks users who:
- logged at least once in the last 14 days (inactive users are left alone)
- missed **2 or more of the last 3 completed days**, where "missed" means no log that day or status `MISS`. A **pivot-protected day is never counted as missed**, because using a pivot is already the "adapt, don't reset" move. The agent's prompt also tells it not to treat pivot days as evidence of slipping.
- have had **no suggestion in the last 7 days**, whether pending, accepted or rejected

A user can also have at most one pending suggestion (unique index), and each run is capped at 25 users with a 110s time budget.

## What gets suggested (decided in code, before the model runs)

`analyze()` in the edge function makes the decision deterministically. The model only explains *why* and words the suggestion, and `create_rule_adaptation` rejects anything else.

- **Evidence** is the user's last 3 **logged** days within 14 days. No-log days make someone a candidate, but they are never evidence against a specific rule; only an unchecked rule on a logged day counts. Pivot days and **0% days** are excluded too: a day with nothing checked says nothing about *which* rule failed, and editing the rule list can write an all-unchecked placeholder row. Rules are matched by text, so edits to the list don't misalign history.
- **`rough_patch`:** if on most evidence days (2 of 3) **70% or more of the rules were missed together**, no rule is blamed. The suggestion is *"For 3 days, only your !!! rules (n)."* (or the 3 most-kept rules if there are no `!!!` rules). Accepting it records the commitment and **never changes the rule list**.
- **`rule_change`:** otherwise, one failing rule (missed on most evidence days) gets an adapted version.
  - `!!!` rules are **never** loosened unless one is the *only* rule failing. Non-`!!!` rules always win.
  - Tie-break: the rule whose current miss streak **started first**, then the most misses in the 14-day window, then the lowest index.
- **Nothing** is eligible (e.g. only 2+ `!!!` rules failing): no suggestion, and no Gemini call.

## Data

- **Types:** `type` is `rule_change` (uses `rule_index`, `old_rule`, `proposed_rule`) or `rough_patch` (uses `proposed_rule`, `focus_rules` [{index,t}], `focus_days`; `rule_index`/`old_rule` are null). A check constraint enforces the shape.

- **Source:** `daily_logs` only. `get_journal_entries` returns rule-by-rule done/missed per day from `daily_logs.rules`. No journal photos are stored.
- **`rule_adaptations`:** `id, user_id, rule_index, old_rule, proposed_rule, reason, status (pending|accepted|rejected), created_at, decided_at`. `old_rule` is kept so an undo can be added later.
- **RLS:** users can SELECT only their own rows. Nobody can insert, update or delete through the API. Inserts come from the edge function (service role), and decisions go through the two RPCs.

## Accept guarantees (`accept_rule_adaptation`)

- Runs in one transaction. Either the rule changes **and** the row becomes `accepted`, or nothing changes.
- Replaces only `rules[rule_index].t`. Every other rule, and the adapted rule's label, is carried over unchanged.
- Refuses with `rule_changed` if that rule's text no longer equals `old_rule`.
- If `profiles.rules` is empty (user still on the app's default list), it uses the list the dashboard sends. Otherwise the stored list is the source of truth.

## Running it manually

```bash
curl -X POST https://qtlhpaqsmbyneivdsiei.supabase.co/functions/v1/adapt-agent \
  -H "x-internal-secret: $INTERNAL_WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>","dry_run":true}'   # omit user_id for a normal candidate run; omit dry_run to insert
```

Token usage: Supabase dashboard → Edge Functions → adapt-agent → Logs, events `adapt_agent_run` and `adapt_agent_batch`.

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
