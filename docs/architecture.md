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
| `analyze-journal` | Snap & Track in dashboard | user JWT | Sends a journal photo + rule list to Gemini, returns per-rule done/not-done |
| `ai-coach` | AI Coach in dashboard | user JWT | Sends recent history + root-cause stats to Gemini, returns coaching text |
| `send-daily-reminder` | `pg_cron`, daily 15:30 UTC | JWT | Emails users who haven't logged today (via Resend) |
| `adapt-agent` | `pg_cron` daily (scheduled on merge) | shared secret header | Gemini tool loop (≤5 steps) over `daily_logs`; inserts one pending `rule_adaptations` row for users who missed 2+ of the last 3 days |
| `send-waitlist-email` | Postgres trigger on `waitlist_emails` | shared secret header | Sends the waitlist welcome email |

Secrets (`GEMINI_API_KEY`, `RESEND_API_KEY`, `INTERNAL_WEBHOOK_SECRET`, `RESEND_FROM`) live in Supabase project secrets, never in this repo.
