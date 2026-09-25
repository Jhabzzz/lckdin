import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://lckd-in.com",
  "https://www.lckd-in.com",
]);

// ── One briefing per user per day ──
// The dashboard asks once per day (and on Refresh). Today's briefing is cached in
// ai_coach_briefings, keyed by the user's local date (`date` in the body). Without
// `refresh`, a cached briefing is returned with no Gemini call. Every Gemini call
// (the first of the day and each Refresh) takes one of DAILY_LIMIT calls per UTC day
// (ai_daily_usage). Failed model calls are refunded. The 429 bodies below are read by
// the dashboard to show a specific message instead of a generic error.
const DAILY_LIMIT = 3;
const LIMIT_REACHED = { error: "daily_limit", message: "Daily AI limit reached, resets tomorrow" };
const RECHARGING = { error: "ai_recharging", message: "AI is recharging — try again later" };

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://lckd-in.com";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// Every real timezone is within UTC-12..UTC+14, so a user's local date is always the
// UTC date or one day either side. Anything else is rejected.
function validLocalDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const now = Date.now();
  const ok = [-1, 0, 1].map((d) => new Date(now + d * 86400000).toISOString().slice(0, 10));
  return ok.includes(v) ? v : null;
}

function cleanBriefing(p: unknown): { message: string; insights: string[] } | null {
  const o = p as { message?: unknown; insights?: unknown } | null;
  if (!o || typeof o.message !== "string" || !o.message.trim()) return null;
  const insights = Array.isArray(o.insights)
    ? o.insights.filter((t): t is string => typeof t === "string" && !!t.trim()).slice(0, 5).map((t) => t.slice(0, 400))
    : [];
  return { message: o.message.slice(0, 800), insights };
}

async function userFromJwt(admin: SupabaseClient, req: Request): Promise<{ id: string | null; outage: boolean }> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(jwt);
  // A bad/missing token is a 4xx; anything else is Auth being down, not the user.
  if (error && !(error.status && error.status < 500)) return { id: null, outage: true };
  return { id: data?.user?.id ?? null, outage: false };
}

Deno.serve(async (req) => {
  const CORS_HEADERS = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let quotaTaken: string | null = null; // user id whose call must be refunded if the model fails
  const refund = async () => {
    if (!quotaTaken) return;
    const uid = quotaTaken;
    quotaTaken = null;
    await admin.rpc("ai_quota_refund", { p_user_id: uid, p_kind: "coach" });
  };

  try {
    const { dayNumber, rootRule, downstreamRules, missedToday, todayScore, days, date, refresh } = await req.json();

    const user = await userFromJwt(admin, req);
    if (user.outage) return json({ error: "Auth unavailable, try again later" }, 503);
    if (!user.id) return json({ error: "Sign in to use AI features" }, 401);

    // Older dashboards (open tabs from before this change) don't send `date`: use UTC's.
    const day = date === undefined ? new Date().toISOString().slice(0, 10) : validLocalDate(date);
    if (!day) return json({ error: "Invalid date" }, 400);

    // Today's briefing already exists: serve it, no model call.
    if (refresh !== true) {
      const { data: cached } = await admin.from("ai_coach_briefings")
        .select("briefing, created_at").eq("user_id", user.id).eq("day", day).maybeSingle();
      if (cached) return json({ ...cached.briefing, cached: true, created_at: cached.created_at });
    }

    if (!Array.isArray(days) || days.length < 2 || !rootRule) {
      return json({ error: "Need at least 2 days of history and a root rule" }, 400);
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      return json({ error: "GEMINI_API_KEY not configured on the server" }, 500);
    }

    const { data: allowed, error: quotaError } = await admin.rpc("ai_quota_take", { p_user_id: user.id, p_kind: "coach", p_limit: DAILY_LIMIT });
    if (quotaError) {
      // Quota table unreachable: let the call through rather than break the feature;
      // Gemini's own 429 still protects the project quota.
      console.error("ai_quota_take failed:", quotaError.code);
    } else if (allowed !== true) {
      return json(LIMIT_REACHED, 429);
    } else {
      quotaTaken = user.id;
    }

    const historyLines = days
      .map((d: { day_number: number; score: number; missedRuleNames: string[] }) =>
        `Day ${d.day_number}: score ${d.score}%, missed rules: ${(d.missedRuleNames || []).join(", ") || "none"}`)
      .join("\n");

    const downstreamList = Array.isArray(downstreamRules) && downstreamRules.length
      ? downstreamRules.join(", ")
      : "none identified yet";

    const prompt = `You are a blunt, specific behavioral coach inside a discipline-tracking app called LCKD—IN.
A user is on day ${dayNumber} of a 120-day protocol. Here is their last ${days.length} logged days:
${historyLines}

A statistical pass over this data already found:
- Root-cause rule (fails most, and drags others down with it): "${rootRule}"
- Rules that tend to fail alongside it: ${downstreamList}
- Today: ${missedToday} rule(s) missed, score ${todayScore}%

Write real coaching, not generic motivation. Reference the actual rule names and actual numbers above. No emojis, no hashtags, no \"you got this\" filler.
Respond with ONLY valid JSON, no markdown, in exactly this shape:
{
  "message": "<2-3 sentences, direct, specific, references the actual data above>",
  "insights": [
    "<one sentence: what pattern is happening and why>",
    "<one sentence: the concrete downstream effect>",
    "<one sentence: one specific, actionable fix for tonight or tomorrow>"
  ]
}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, response_mime_type: "application/json" },
        }),
      },
    );

    if (!geminiRes.ok) {
      await refund();
      const errText = await geminiRes.text();
      if (geminiRes.status === 429) {
        console.error("Gemini rate limited:", errText.slice(0, 300));
        return json(RECHARGING, 429);
      }
      console.error("Gemini error body:", errText);
      return json({ error: "Gemini request failed", status: geminiRes.status, detail: errText }, 502);
    }

    const geminiData = await geminiRes.json();
    const textOut = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let briefing;
    try {
      briefing = cleanBriefing(JSON.parse(textOut));
    } catch { /* handled below */ }
    if (!briefing) {
      await refund();
      console.error("Could not parse Gemini text output:", textOut);
      return json({ error: "Could not parse Gemini response", raw: textOut }, 502);
    }

    const createdAt = new Date().toISOString();
    const { error: saveError } = await admin.from("ai_coach_briefings")
      .upsert({ user_id: user.id, day, briefing, created_at: createdAt }, { onConflict: "user_id,day" });
    if (saveError) console.error("Could not cache briefing:", saveError.code); // still return it

    quotaTaken = null; // success: the call counts
    return json({ ...briefing, cached: false, created_at: createdAt });
  } catch (err) {
    await refund().catch(() => {});
    console.error("Unhandled error:", err);
    return json({ error: String(err) }, 500);
  }
});
