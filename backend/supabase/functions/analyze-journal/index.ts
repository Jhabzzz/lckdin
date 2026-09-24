import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
    const { image, rules, mimeType } = await req.json();

    if (!image || !Array.isArray(rules) || rules.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing image or rules array" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const resolvedMimeType = SUPPORTED_MIME_TYPES.has(mimeType) ? mimeType : "image/jpeg";

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    console.log("GEMINI_API_KEY present:", !!GEMINI_API_KEY, "length:", GEMINI_API_KEY ? GEMINI_API_KEY.length : 0);
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY not configured on the server" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

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
