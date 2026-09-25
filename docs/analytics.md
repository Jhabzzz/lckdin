# Analytics & Observability

LCKD—IN uses [PostHog](https://posthog.com) (US Cloud) for product analytics and
Web Vitals, wrapped by a single local file: **`analytics.js`**. No other file
talks to PostHog directly — every event goes through `trackEvent()`.

## 1. Architecture

```
index.html ──┐
dashboard.html ──┼──> analytics.js ──> PostHog (us.i.posthog.com)
profile.html ──┘
```

- `analytics.js` is loaded synchronously (no `defer`/`async` on the tag
  itself — only the PostHog script it injects is async) as the **first**
  thing in `<head>`, before any other script, so `trackEvent`/`identifyUser`/
  `resetAnalyticsIdentity` are always defined before later inline scripts run.
- Each of the three pages also defines a fallback stub right after the
  `<script src="/analytics.js">` tag:
  ```html
  window.trackEvent = window.trackEvent || function(){};
  window.identifyUser = window.identifyUser || function(){};
  window.resetAnalyticsIdentity = window.resetAnalyticsIdentity || function(){};
  ```
  If `analytics.js` fails to load at all (network error, ad-blocker, 404),
  the app still runs — every call site just calls a no-op.
- Inside `analytics.js`, every exported function is wrapped in `try/catch`
  and never awaited by app code — analytics can never throw, block, or delay
  a real user action.

## 2. PostHog configuration

| Setting | Value |
|---|---|
| Region | US Cloud |
| API host | `https://us.i.posthog.com` |
| Product Analytics | Enabled |
| Web Analytics | Enabled |
| Web Vitals autocapture (`capture_performance`) | Enabled |
| Autocapture (clicks/forms) | **Disabled** — only intentional `trackEvent()` calls |
| Heatmaps | Disabled |
| Session Replay | **Disabled** (`disable_session_recording: true`) |
| Persistence | `localStorage` (no cookies → no consent banner needed) |
| Pageview/pageleave capture | Enabled (powers PostHog's own Web Analytics tab) |

The project API key and host are hard-coded in `analytics.js` — this is
intentional and standard for PostHog's public/client-side key (same trust
model as `SUPABASE_KEY` already in the codebase).

## 3. Production vs. development behavior

`isProduction()` checks `window.location.hostname` against
`['lckd-in.com', 'www.lckd-in.com']`.

- **Production** (those two hostnames): the PostHog script loads, events
  are sent for real.
- **Everything else** (localhost, `*.vercel.app` previews, custom domains
  under test): `initPostHog()` never runs, and `trackEvent()` calls
  `console.debug('[analytics:noop]', name, properties)` instead of sending
  anything. This is how the event flow was verified during development
  (see §8).

## 4. Privacy rules (enforced in code, not just convention)

`analytics.js` maintains an `ALLOWED_PROPS` allowlist. `sanitizeProperties()`
drops **any** property key not on that list, and drops any value that isn't
a primitive (string/number/boolean/null) — even for allowlisted keys. A call
site cannot accidentally leak a nested object, array, or PII field: it is
silently stripped before anything is sent.

**Never sent, by design — no call site references these, and even if one
did, they aren't on the allowlist:**
- Email, password, name, username
- Auth/session tokens
- Raw rule text (the user's own habit list)
- Snap & Track images or any image data
- AI Coach prompts, responses, or insight text
- Raw Supabase/Gemini response bodies
- Raw JS error messages or stack traces

**Identity**: `identifyUser(userId)` sends only the opaque Supabase auth
UUID — never email or username — to link anonymous pre-signup activity to
the account. `resetAnalyticsIdentity()` is called on sign-out, clearing the
PostHog identity so the next visitor on that device starts anonymous again.

**Public profile views are anonymous by design**: `public_profile_viewed`
(fired from `profile.html`) carries **no properties at all** — specifically,
it never includes the username being viewed. This is intentional: PostHog
must never be able to answer "who viewed whom."

**Errors are categorized, not transcribed**: both the global
`window.addEventListener('error'/'unhandledrejection')` handlers and every
feature-level failure (`signup_failed`, `snap_track_failed`,
`ai_coach_failed`, `app_error`) send a fixed `error_category` string picked
from a small closed set (e.g. `email_taken`, `weak_password`,
`network_error`, `js_exception`) — never `error.message` or `error.stack`.
This is a deliberate tradeoff: less debugging detail in PostHog, in exchange
for a hard guarantee that user-entered text can never leak through an error
message.

### Allowed property keys

```
protocol_length, previous_length, new_length, current_day, day_number,
score_bucket, rule_count, pivot_count, pivots_remaining, pivots_used_total,
feature, device_type, referrer_category, error_category, cta_location,
auth_method
```

Note there is no `score`, `email`, `username`, or free-text field on this
list — `score_bucket` (`'perfect' | 'partial' | 'miss'`) is the closest
thing to a score, deliberately coarser than the raw percentage.

## 5. Event taxonomy

### Acquisition (`index.html`)
| Event | Fires when | Properties |
|---|---|---|
| `landing_view` | Landing page loads | `device_type`, `referrer_category` |
| `cta_clicked` | A "Sign up" CTA opens the auth modal | `cta_location` (`nav`, `sticky_mobile`, `hero`, `challenge_section`, `wearables_waitlist`, `final_cta`) |
| `signup_started` | Auth modal switches to signup mode | — |
| `signup_failed` | Signup rejected | `error_category` (`invalid_username`, `username_taken`, `email_taken`, `weak_password`, `network_error`, `other`) |
| `signup_completed` | `sb.auth.signUp()` returns a session | `auth_method: 'email'` |
| `signin_failed` | Sign-in rejected | `error_category` |
| `signin_completed` | Sign-in succeeds | `auth_method: 'email'` |

### Protocol lifecycle (`dashboard.html`)
| Event | Fires when | Properties |
|---|---|---|
| `protocol_started` | First-ever dashboard boot with zero logged days for the account | `protocol_length` |
| `protocol_length_selected` | User manually changes protocol length (preset pill or custom input) | `protocol_length`, `previous_length` |
| `protocol_completed` | The completion celebration modal is shown | `protocol_length` |
| `protocol_extended` | "Keep Going" chosen on the completion modal | `previous_length`, `new_length` |
| `new_protocol_started` | A new length is picked via "Choose New Length" on the completion modal | `protocol_length` |

### Daily logging (`dashboard.html`)
| Event | Fires when | Properties |
|---|---|---|
| `daily_log_started` | The **first** save of the current day this session, where no row for today existed before | `day_number` |
| `daily_log_saved` | Every successful save from a real rule-check action (not rule-list editing) | `day_number`, `score_bucket` |
| `day_1_logged` | First-ever save of day 1 | — |
| `day_2_logged` | First-ever save of day 2 | — |
| `day_7_reached` | First-ever save of day 7 | — |
| `perfect_day_logged` | A day is saved at 100% (deduped per day per browser) | `day_number` |

### Pivot Protocol (`dashboard.html`)
| Event | Fires when | Properties |
|---|---|---|
| `pivot_offered` | The pivot confirm dialog is shown (full miss, pivots available) | `pivots_remaining` |
| `pivot_declined` | User dismisses the pivot dialog | — |
| `pivot_used` | `use_pivot()` RPC succeeds | `pivots_used_total`, `pivots_remaining` |

### AI Coach (`dashboard.html`)
| Event | Fires when | Properties |
|---|---|---|
| `ai_coach_requested` | `ai-coach` is invoked: once per day on dashboard load when there's no cached briefing, or on Refresh | — |
| `ai_coach_succeeded` | The `ai-coach` edge function returns successfully | — |
| `ai_coach_failed` | The edge function call throws or returns an error | `error_category`: `'llm_pass_failed'`, `'ai_daily_limit'` (user's 3/day allowance used) or `'ai_rate_limited'` (Gemini project quota 429, or the project-wide 18/day cap in `ai_global_usage`) |

### Snap & Track (`dashboard.html`)
| Event | Fires when | Properties |
|---|---|---|
| `snap_track_opened` | The Snap & Track tab is selected | — |
| `snap_track_image_submitted` | A photo is submitted for analysis | — |
| `snap_track_succeeded` | `analyze-journal` returns results | — |
| `snap_track_failed` | The analysis call throws or returns an error | `error_category`: `'vision_analysis_failed'`, `'ai_daily_limit'` or `'ai_rate_limited'` |
| `snap_track_corrected` | User taps to correct an AI-detected rule (once per confirm screen) | — |
| `snap_track_confirmed` | User confirms the detected results into today's log | — |

### Sharing & social (`dashboard.html`, `profile.html`)
| Event | Fires when | Properties |
|---|---|---|
| `public_profile_shared` | "Copy link" clicked on the dashboard | — |
| `public_profile_viewed` | Someone loads a real `/u/:username` page | *(none — never includes the username)* |
| `leaderboard_viewed` | The leaderboard is first rendered this session | — |

### Settings
| Event | Fires when | Properties |
|---|---|---|
| `reminder_enabled` | Reminder toggle switched on and saved | — |
| `reminder_disabled` | Reminder toggle switched off and saved | — |

### Errors (global safety net, `analytics.js`)
| Event | Fires when | Properties |
|---|---|---|
| `app_error` | An uncaught `window` error or unhandled promise rejection | `error_category` (`js_exception` \| `unhandled_rejection`), `feature: 'window'` |

## 6. Duplicate-prevention strategy

Three different mechanisms are used, matched to what state is actually
available at the trigger point:

1. **Server-state-derived (most robust)** — `protocol_started`,
   `daily_log_started`, `day_1_logged`, `day_2_logged`, `day_7_reached`.
   These check real Supabase data (does a `daily_logs` row already exist
   for this day / does the account have any logs at all) rather than a
   client-side flag, via `todayLogExistedBeforeSession` /
   `todayLogSavedThisSession`, both recomputed inside `hydrateProtocol()`
   — which reruns on every boot **and** every protocol-length change, so
   the flags never go stale relative to a recalculated `currentDay`.
2. **`localStorage`-based (best-effort, per-browser)** — `protocol_completed`
   (reuses the pre-existing `lckdin-celebrated-*` key) and
   `perfect_day_logged` (`lckdin-perfect-tracked-*`). These survive reloads
   within the same browser but reset if the user clears storage or switches
   devices — an accepted tradeoff since re-firing a "nice to have" usage
   event is low-cost, and adding a Supabase round-trip just to dedupe it
   would be disproportionate.
3. **In-session flag only** — `leaderboard_viewed`,
   `snap_track_corrected` (per confirm-screen). These are usage-frequency
   signals where "once per page load" is the correct granularity, not
   "once ever."

`signup_completed` needed none of the above — it is placed to fire exactly
once, immediately after `sb.auth.signUp()` confirms a session, before any
other code path can navigate away (see §9 for why this placement matters).

## 7. Activation & retention definitions (for PostHog reports)

- **Activation**: `signup_completed` → `day_1_logged` within the same
  session/day. A funnel from `signup_completed` to `day_1_logged` is the
  activation metric.
- **Retention**: use `day_1_logged` as the retention anchor event and
  `daily_log_saved` as the return event in PostHog's Retention insight.
  Note `day_number` is protocol-relative, not calendar-relative — day 2
  isn't necessarily "the next calendar day" if a user skips a day, so
  PostHog's own event-timestamp-based retention windows (not `day_number`)
  are what should drive the retention report.
- **Feature adoption**: `snap_track_opened` / `ai_coach_requested` /
  `pivot_used` / `public_profile_shared` are the four adoption signals —
  each maps to one optional feature, so "% of activated users who ever
  fire this event" is the adoption rate per feature.

## 8. Testing performed

- **Unit-level** (property sanitization): confirmed `email`, `username`,
  `rule_text`, `auth_token`, and nested objects are all dropped by
  `sanitizeProperties()`; only allowlisted primitive values pass through.
- **Non-production no-op**: confirmed on `localhost` every `trackEvent()`
  call logs to `console.debug('[analytics:noop]', ...)` and never touches
  `window.posthog`.
- **Live integration**: confirmed against the real PostHog endpoint that
  `array.js` and `web-vitals-with-attribution.js` load with 200s, `init()`
  succeeds, and `posthog.capture` becomes a callable function.
- **End-to-end event flow** (Puppeteer, throwaway `claude-*@example.com`
  accounts against the real Supabase project, cleaned up afterward):
  - Full signup flow: `landing_view → cta_clicked → signup_started →
    signup_completed`, in order, zero page errors, redirect to `/app`
    still works.
  - Dashboard boot: `identifyUser`, `leaderboard_viewed`,
    `protocol_started` (new account) all fire correctly.
  - Rule check → `daily_log_started`, `daily_log_saved`, `day_1_logged`,
    `perfect_day_logged` fire once each; a second save of the same day
    correctly does **not** re-fire `daily_log_started` or `day_1_logged`.
  - Protocol-length change → `protocol_length_selected` fires with correct
    `previous_length`/`protocol_length`, and does not conflict with
    `hydrateProtocol()`'s re-derivation of `currentDay`.
  - Full miss on a fresh day → `pivot_offered` fires, decline → confirmed
    dialog with `pivot_declined`, no pivot RPC called.
  - Snap & Track UI flow (tab open, correct a detected rule, confirm) →
    `snap_track_opened`, `snap_track_corrected` (once, not per click),
    `snap_track_confirmed` all fire correctly.
  - `profile.html` for a real username → `public_profile_viewed` fires
    with **no properties**, confirmed via inspecting the actual event
    payload in the debug log.
- **Failure/fallback behavior**: verified that when
  `navigator.webdriver` is `true` (the standard automated-browser flag,
  present in the Puppeteer/headless test environment), PostHog's own
  bot-detection silently suppresses event transport — zero network calls
  via `sendBeacon`, `fetch`, or `XHR`, confirmed by monkey-patching all
  three before the PostHog script loaded. This was traced conclusively to
  PostHog's bot filtering (not a bug in `analytics.js`): `init()` still
  succeeds, `capture` is still callable, no errors are thrown — PostHog is
  correctly declining to record synthetic traffic from an automated
  browser. This is expected behavior from the chosen provider, not a gap
  in the implementation.
- **Regression testing**: confirmed with the same test accounts that
  scoring, the Pivot Protocol, sign-up/sign-in, protocol length switching,
  the AI Coach, Snap & Track, the leaderboard, and public profile pages all
  behave identically to before instrumentation — every analytics call is
  additive and none of them changes control flow, return values, or DB
  writes made by the underlying feature code (the one exception —
  `hydrateProtocol()` now also returns `{ hasAnyLogs }`, an additive return
  value nothing else previously used).

## 9. Known nuances / limitations

- **`signup_completed` placement**: the pre-existing `sb.auth.onAuthStateChange`
  listener can independently detect a profile and redirect to `/app` before
  `handleAuthSubmit()`'s own async chain would otherwise reach a
  `trackEvent()` call placed after the profile insert. `signup_completed`
  is therefore fired immediately once `data.session` is confirmed, *before*
  the profile insert — not after. This is a pre-existing race in the app's
  auth flow (not introduced by this work); it was worked around rather than
  fixed, since analytics must observe existing behavior, not change it.
- **`perfect_day_logged` dedup is per-browser, not per-account**: unlike
  the day-number milestones (server-state-derived), this uses `localStorage`
  and can re-fire on a new device/browser or after clearing site data. See
  §6.
- **`day_number` vs. calendar day**: protocol days are relative to the
  account's own log history, not the calendar — two users both on
  "day_7_reached" may be on different real dates. Retention reports should
  use PostHog's own event timestamps, not `day_number`, as noted in §7.
- **`ai_coach_opened` was not implemented**: the AI Coach panel is always
  visible on the dashboard (not opened/closed by the user), so there is no
  natural "open" trigger distinct from `ai_coach_requested` (the once-a-day
  briefing generation, or a Refresh). `ai_coach_requested` is the closest equivalent and
  covers the adoption signal.

## 10. Adding a future event

1. Add the property keys it needs (if any) to `ALLOWED_PROPS` in
   `analytics.js` — anything not listed there is silently dropped.
2. Call `trackEvent('event_name', { ... })` from the relevant call site.
   Never `await` it, never let it gate control flow.
3. If it needs deduplication, pick the matching strategy from §6 based on
   whether the truth you need already exists in already-fetched Supabase
   data (prefer this), or needs a `localStorage` flag, or is a simple
   per-session flag.
4. Never pass raw error messages, user-entered text, emails, usernames, or
   any object/array value — only primitives on the allowlist.
5. Add a row to the taxonomy table in §5 of this doc.
