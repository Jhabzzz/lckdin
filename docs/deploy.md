# Deploying

## Frontend (Vercel)

The Vercel project's **Root Directory** is set to `frontend`. Every push to `main` deploys to production at [lckd-in.com](https://www.lckd-in.com). Routing lives in `frontend/vercel.json`.

There is no build step. Vercel serves the files as they are.

Checks after a deploy:
- `https://www.lckd-in.com/` loads
- `https://www.lckd-in.com/app` loads the dashboard
- `https://www.lckd-in.com/u/<username>` loads a public grid

## Edge functions (Supabase)

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
cd backend
supabase login
supabase functions deploy <function-name> --project-ref qtlhpaqsmbyneivdsiei
```

`backend/supabase/config.toml` holds each function's `verify_jwt` setting. `send-waitlist-email` must stay `verify_jwt = false`, because a Postgres trigger calls it with a shared secret instead of a user token.

Set or rotate secrets with:

```bash
supabase secrets set GEMINI_API_KEY=... --project-ref qtlhpaqsmbyneivdsiei
```

## Database migrations

New migrations go in `backend/supabase/migrations/` as `<timestamp>_<name>.sql`. Apply them with `supabase db push`, or through the Supabase dashboard / MCP.

Migration `20260731060658_fix_waitlist_email_trigger_secret.sql` has a `<INTERNAL_WEBHOOK_SECRET>` placeholder. Substitute the real value if you ever re-apply it.

## CI (GitHub Actions)

| Workflow | Runs on | Fails when |
|---|---|---|
| `secret-scan` | every push + PR | gitleaks finds a secret anywhere in git history (config: `.github/gitleaks.toml`; only the Supabase anon/publishable keys and the PostHog `phc_` key are allowlisted) |
| `design-check` | every push + PR | `frontend/` uses a color not in `.github/design-allowlist.txt`. Run locally with `python3 .github/scripts/design_check.py` |
| `smoke-test` | push to `main` | 60s after the push, `/`, `/app` or `/u/jhaby` on lckd-in.com doesn't return 200 |

All three run on GitHub's free tier (public repo) and need no secrets.
