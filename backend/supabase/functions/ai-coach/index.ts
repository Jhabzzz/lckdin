import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://lckd-in.com",
  "https://www.lckd-in.com",
]);

// ── Per-user daily AI allowance + friendly rate-limit errors ──
// Shared free-tier Gemini quota (20/day, 5/min per project), so each user gets
// DAILY_LIMIT calls per UTC day. Failed model calls are refunded. The 429 bodies below
// are read by the dashboard to show a specific message instead of a generic error.
const DAILY_LIMIT = 3;
const LIMIT_REACHED = { error: "daily_limit", message: "Daily AI limit reached, resets tomorrow" };
const RECHARGING = { error: "ai_recharging", message: "AI is recharging — try again later" };

async function takeQuota(req: Request, kind: "coach" | "snap"): Promise<{ userId: string | null; ok: boolean; refund: () => Promise<void> }> {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error: authError } = await admin.auth.getUser(jwt);
  const noop = async () => {};
  if (authError && !(authError.status && authError.status < 500)) {
    // Auth API down/unreachable (not a bad token): don't tell signed-in users to sign in.
    console.error("auth.getUser failed:", authError.status ?? "network");
    return { userId: "unknown", ok: true, refund: noop };
  }
  const userId = data?.user?.id ?? null;
  if (!userId) return { userId: null, ok: false, refund: noop };
  const { data: allowed, error } = await admin.rpc("ai_quota_take", { p_user_id: userId, p_kind: kind, p_limit: DAILY_LIMIT });
  if (error) {
    // Quota table unreachable: let the call through rather than break the feature;
    // Gemini's own 429 still protects the project quota.
    console.error("ai_quota_take failed:", error.code);
    return { userId, ok: true, refund: noop };
  }
  return {
    userId, ok: allowed === true,
    refund: async () => { await admin.rpc("ai_quota_refund", { p_user_id: userId, p_kind: kind }); },
  };
}

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://lckd-in.com";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const CORS_HEADERS = corsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  let quota: Awaited<ReturnType<typeof takeQuota>> | null = null;
  try {
    const { dayNumber, rootRule, downstreamRules, missedToday, todayScore, days } = await req.json();

    if (!Array.isArray(days) || days.length < 2 || !rootRule) {
      return new Response(
        JSON.stringify({ error: "Need at least 2 days of history and a root rule" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY not configured on the server" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    quota = await takeQuota(req, "coach");
    if (!quota.userId) {
      return new Response(
        JSON.stringify({ error: "Sign in to use AI features" }),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    if (!quota.ok) {
      return new Response(JSON.stringify(LIMIT_REACHED),
        { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
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
      await quota!.refund();
      const errText = await geminiRes.text();
      if (geminiRes.status === 429) {
        console.error("Gemini rate limited:", errText.slice(0, 300));
        return new Response(JSON.stringify(RECHARGING),
          { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      console.error("Gemini error body:", errText);
      return new Response(
        JSON.stringify({ error: "Gemini request failed", status: geminiRes.status, detail: errText }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const geminiData = await geminiRes.json();
    const textOut = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed;
    try {
      parsed = JSON.parse(textOut);
    } catch {
      await quota!.refund();
      console.error("Could not parse Gemini text output:", textOut);
      return new Response(
        JSON.stringify({ error: "Could not parse Gemini response", raw: textOut }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    if (quota?.ok) await quota.refund().catch(() => {});
    console.error("Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
