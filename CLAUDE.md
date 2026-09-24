# LCKD—IN: rules for Claude

Daily-use production app (lckd-in.com). The owner uses it every day, so treat every change as production.

## Layout
- `frontend/` is the Vercel Root Directory. Every push to `main` deploys to production.
- `backend/supabase/` holds edge functions, `config.toml` (per-function `verify_jwt`) and migrations.
- Deploy edge functions from `backend/`: `supabase functions deploy <name> --project-ref qtlhpaqsmbyneivdsiei`
- Every schema change made on the live project must also be saved as a file in `backend/supabase/migrations/`, named `<version>_<name>.sql` with the version the live project assigned.

## Design system (locked)
The palette is what the live site already uses. Don't introduce new colors. Use the CSS variables, never raw hex, in new code.

**⚠️ `--lime` is orange (`#F46A38`), not lime green.** The name is historical. Don't "fix" the name or the value.

| Token | Dark (default) | Light |
|---|---|---|
| `--bg` | `#0C0B09` | `#FAF8F5` |
| `--bg2` / `--bg3` / `--bg4` | `#161412` / `#1D1A16` / `#26221C` | `#F3F0EA` / `#EBE7DE` / `#E0DBCE` |
| `--text` / `--text2` / `--text3` / `--text4` | `#F5F2EC` / `#BCB7A9` / `#87826F` / `#5B564A` | `#111111` / `#3D3B37` / `#6B6862` / `#8F8B82` |
| `--lime` (primary accent, **orange**) | `#F46A38` | `#F46A38` |
| `--lime2` (accent hover/shade) | `#FF8659` | `#C24518` |
| `--amber` | `#E8940F` | `#A6660A` |
| `--error` | `#FF6B6B` | `#C23B3B` |
| `--line` / `--line2` / `--line3` | `#2C271F` / `#38322A` / `#4A4235` | `#E5E1D6` / `#D8D3C5` / `#C0BAA8` |
| grid heat `--g0`…`--g5` | `#0C0B09` → `#F46A38` | `#EFEBE2` → `#F46A38` |

Both themes must keep working (`:root` is light and `:root[data-theme="dark"]` is dark). The full token list lives in the `:root` blocks of `frontend/dashboard.html` and `index.html`.

**Fonts:** Space Grotesk (`--sans`) for UI and JetBrains Mono (`--mono`) for labels, numbers and data. Playfair Display (`--serif`) is **for the hero only**. It already appears in the hero, quote cards, `.disp` headings and the chat header, so leave those alone, but add no new Playfair anywhere else.

**Style for new UI:** brutalist, flat, not playful. That means no new gradients, glows, glassmorphism, bouncy animations, emoji or rounded "friendly" styling. Existing effects stay as they are unless the owner asks otherwise.

## Never touch (unless the owner explicitly says so)
- Supabase client init (`const sb = supabase.createClient(...)` in index, dashboard and profile)
- Auth handlers: `handleAuthSubmit`, `oauthSignIn`, `onAuthStateChange` listeners, sign-out
- `ensureProfile()` (index.html)
- `loadTodayLog()` / `saveTodayLog()` (both exist in dashboard.html **and** index.html)
- The `RULES` array (dashboard.html and index.html)

**Postgres `23505` on signup/profile insert is SUCCESS** (the profile already exists, often from `ensureProfile()` racing the insert). It's handled on purpose. Don't "fix" it.

## How to make changes
- Add visual and UI features as **additive IIFEs** (`(function(){ ... })();`) that hook into existing DOM and functions without rewriting them.
- No ES modules (`type="module"`, `import`). Load third-party code only from **UMD CDN builds** via `<script src>`.
- Keep the owner's variable names exactly as they are (e.g. `jhab1`, `yesua1`, `ubit`). Don't rename them for "clarity".
- Analytics: call `trackEvent(...)` only. It's wrapped so it can never throw, and it must stay that way. Never send PII or raw error text (see `docs/analytics.md`).
- No logic or design changes hidden inside "cleanup" or "refactor" work.

## Required checks (subagents in `.claude/agents/`)
- **design-guard** before any commit that touches `frontend/`
- **supabase-guard** before any migration or edge function change
- **deploy-check** before every push, and again after the deploy lands
- **repo-keeper** after adding, moving or removing files (keeps the README tree and `docs/` accurate)

## Secrets
The Supabase **anon** key and the PostHog `phc_` key are public by design and are allowed in frontend code. Nothing else is. Service-role keys, Gemini and Resend keys, and `INTERNAL_WEBHOOK_SECRET` live only in Supabase secrets. The repo is public on GitHub.
