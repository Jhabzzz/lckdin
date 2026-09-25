# Architecture

LCKD—IN is a static frontend on Vercel talking directly to Supabase. There is no custom application server.

```
Browser ──> Vercel (static files from frontend/)
   │
   └──> Supabase
          ├── Auth            email/password + OAuth
          ├── Postgres        profiles, daily_logs, waitlist_emails (RLS: owner-only)
          ├── RPC functions   public, read-only views of safe fields
          └── Edge Functions  analyze-journal, ai-coach ──> Gemini
                              send-daily-reminder, send-waitlist-email ──> Resend
```

## Frontend (`frontend/`)

| File | Route | Purpose |
|---|---|---|
| `index.html` | `/` | Marketing site, sign-up / sign-in, waitlist |
| `dashboard.html` | `/app` | The app: daily log, streak grid, AI coach, Snap & Track, leaderboard |
| `profile.html` | `/u/:username` | Public accountability grid |
| `manifest.json`, `sw.js` | | PWA install + network-first offline shell |
| `vercel.json` | | Rewrites (`/app`, `/u/:username`) and legacy-domain redirects |

Supabase is loaded from `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`. There is no build step.

## Database

| Table | Notes |
|---|---|
| `profiles` | username, custom `rules` (jsonb), `total_days`, reminder settings |
| `daily_logs` | one row per user per day: `day_number`, `score`, `status`, `rules` (jsonb), `is_pivot` |
| `waitlist_emails` | insert-only for anon; an insert trigger calls `send-waitlist-email` |
| `rule_adaptations` | AI-suggested rule changes (pending/accepted/rejected). Users can SELECT only their own rows. Inserted by `adapt-agent`, decided via `accept_rule_adaptation` / `reject_rule_adaptation`. See `docs/adapt-agent.md` |
| `feedback` | insert-only from the API (no read policies). A `BEFORE INSERT` trigger rate-limits to 3 per 10 min per user (or per sha256-hashed IP when logged out) and 50 anonymous per hour, rejecting with `PT429` |
| `ai_daily_usage` | per-user, per-UTC-day call counter for `ai-coach` (`coach`) and `analyze-journal` (`snap`). RLS on with no policies; anon/authenticated have no access. Only the edge functions (service role) touch it, via `ai_quota_take(user_id, kind, limit)` (atomic take, returns false at the cap) and `ai_quota_refund(user_id, kind)` (gives the call back when the model fails) |
| `ai_coach_briefings` | one AI coach briefing per user per **local** day (`user_id, day, briefing jsonb, created_at`). Users can SELECT their own rows (the dashboard reads today's directly); only `ai-coach` (service role) writes |

Row Level Security limits reads and writes to the row owner. Public pages use narrow `SECURITY DEFINER` RPCs that return only the fields they render:

| RPC | Used by | Returns |
|---|---|---|
| `get_leaderboard()` | index, dashboard | username + aggregate stats, ranked by avg score |
| `get_public_profile(username)` | profile | id, username, total_days |
| `get_public_grid_logs(user_id)` | profile | per-day score / pivot / done counts (no rule text) |
| `check_username_available(username)` | index | boolean |
| `use_pivot(day_number)` | dashboard | spends a pivot (max 5) on a fully missed day |
| `accept_rule_adaptation(id, current_rules)` / `reject_rule_adaptation(id)` | dashboard | atomically swaps the one suggested rule / dismisses it |

The full schema history is in `backend/supabase/migrations/`. The base `profiles` and `daily_logs` tables were created in the Supabase dashboard before migrations were tracked.

## Edge functions (`backend/supabase/functions/`)

| Function | Trigger | Auth | Does |
|---|---|---|---|
| `analyze-journal` | Snap & Track in dashboard | user JWT | Sends a journal photo + rule list to Gemini, returns per-rule done/not-done. Max 3 calls per user per UTC day (`ai_daily_usage`); 429 `daily_limit` / `ai_recharging` when capped |
| `ai-coach` | AI Coach in dashboard: once per day on load, plus the Refresh button (never on saves) | user JWT | Returns today's cached briefing from `ai_coach_briefings` if one exists (no Gemini call). Otherwise, or with `refresh: true`, it sends recent history + root-cause stats to Gemini and caches the result. Every Gemini call counts toward 3 per user per UTC day (`ai_daily_usage`); 429 `daily_limit` / `ai_recharging` when capped |
| `send-daily-reminder` | `pg_cron`, daily 15:30 UTC | JWT | Emails users who haven't logged today (via Resend) |
| `adapt-agent` | `pg_cron` daily (scheduled on merge) | shared secret header | Decides deterministically in `logic.ts` (no AI) from `daily_logs`; inserts one pending `rule_adaptations` row (`rule_change` or `rough_patch`) for users who missed 2+ of the last 3 completed days. Optional single Gemini call (`ADAPT_AGENT_GEMINI_KEY`) only rewords the template. See `docs/adapt-agent.md` |
| `send-waitlist-email` | Postgres trigger on `waitlist_emails` | shared secret header | Sends the waitlist welcome email |

Secrets (`GEMINI_API_KEY`, `RESEND_API_KEY`, `INTERNAL_WEBHOOK_SECRET`, `RESEND_FROM`, optional `ADAPT_AGENT_GEMINI_KEY`) live in Supabase project secrets, never in this repo.
