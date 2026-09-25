import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://lckd-in.com",
  "https://www.lckd-in.com",
]);

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
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
    const { image, rules, mimeType } = await req.json();

    if (!image || !Array.isArray(rules) || rules.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing image or rules array" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    console.log("GEMINI_API_KEY present:", !!GEMINI_API_KEY, "length:", GEMINI_API_KEY ? GEMINI_API_KEY.length : 0);
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY not configured on the server" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    quota = await takeQuota(req, "snap");
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

    const resolvedMimeType = SUPPORTED_MIME_TYPES.has(mimeType) ? mimeType : "image/jpeg";

    const ruleCount = rules.length;
    const lastIdx = ruleCount - 1;
    const rulesList = rules
      .map((r, i) => `${i}: ${r}`)
      .join("\n");

    const prompt = `You are reading a handwritten daily discipline-tracking journal photo.
Here are the ${ruleCount} rules being tracked, by index:
${rulesList}

Look at the photo and determine, for EACH rule index (0-${lastIdx}), whether the handwriting shows it was
completed (checked, ticked, circled, or otherwise marked done) or not completed that day.
Respond with ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "confidence": <integer 0-100, your overall confidence reading the handwriting>,
  "results": [
    { "idx": 0, "done": true },
    { "idx": 1, "done": false },
    ...
    { "idx": ${lastIdx}, "done": true }
  ]
}
Include all ${ruleCount} indices, 0 through ${lastIdx}, in the results array, in order.`;

    console.log("Calling Gemini, image length:", image.length, "mimeType:", resolvedMimeType, "ruleCount:", ruleCount);

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: resolvedMimeType, data: image } },
              ],
            },
          ],
          generationConfig: { temperature: 0.1, response_mime_type: "application/json" },
        }),
      },
    );

    console.log("Gemini response status:", geminiRes.status);

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
