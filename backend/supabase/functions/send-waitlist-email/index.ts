import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Called internally by a Postgres trigger (net.http_post), not by the browser.
// verify_jwt is off; instead we require a shared secret only the trigger knows.
Deno.serve(async (req) => {
  try {
    const internalSecret = Deno.env.get("INTERNAL_WEBHOOK_SECRET");
    const providedSecret = req.headers.get("x-internal-secret");
    if (!internalSecret || providedSecret !== internalSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const { email } = await req.json();
    if (!email || typeof email !== "string" || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Missing or invalid email" }), { status: 400 });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500 });
    }

    const FROM_ADDRESS = Deno.env.get("RESEND_FROM") || "LCKD—IN <hello@lckd-in.com>";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject: "You're locked in — welcome to the LCKD—IN waitlist",
        html: `
          <div style="font-family:monospace;background:#0B0A08;color:#F2F0E6;padding:32px">
            <p style="color:#C8FF00;letter-spacing:0.2em;font-size:11px;text-transform:uppercase">LCKD—IN</p>
            <h1 style="font-size:22px;margin:16px 0">You're locked in.</h1>
            <p style="font-size:14px;line-height:1.7;color:#B4B2A8">
              Thanks for joining the waitlist. You're one of the first 500 — that means lifetime AI coach access, no trial, no paywall, the moment we ship.
            </p>
            <p style="font-size:14px;line-height:1.7;color:#B4B2A8">We'll ping you the day it's live. Until then: execute without excuses.</p>
          </div>
        `,
      }),
    });

    if (!resendRes.ok) {
      const detail = await resendRes.text();
      return new Response(JSON.stringify({ error: "Resend request failed", detail }), { status: 502 });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
