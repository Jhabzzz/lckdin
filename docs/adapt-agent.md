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
- missed **2 or more of the last 3 completed days**, where "missed" means no log that day or status `MISS`
- have had **no suggestion in the last 7 days**, whether pending, accepted or rejected

A user can also have at most one pending suggestion (unique index), and each run is capped at 50 users.

## Data

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
