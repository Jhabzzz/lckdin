import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGINS = new Set([
  "https://lckd-in.com",
  "https://www.lckd-in.com",
]);

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
      const errText = await geminiRes.text();
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
    console.error("Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
