import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_ADDRESS = Deno.env.get("RESEND_FROM") || "LCKD—IN <hello@lckd-in.com>";

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Server misconfigured: missing service role credentials" }), { status: 500 });
    }
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: profiles, error: profilesErr } = await admin
      .from("profiles")
      .select("id, username, last_reminder_sent_at, reminders_enabled");
    if (profilesErr) {
      return new Response(JSON.stringify({ error: "profiles query failed", detail: profilesErr }), { status: 500 });
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const todayStr = now.toISOString().slice(0, 10);

    let sent = 0, skippedLogged = 0, skippedRateLimit = 0, skippedOptedOut = 0;
    const errors: string[] = [];

    for (const profile of profiles || []) {
      try {
        if (profile.reminders_enabled === false) {
          skippedOptedOut++;
          continue;
        }

        if (profile.last_reminder_sent_at && new Date(profile.last_reminder_sent_at) > cutoff) {
          skippedRateLimit++;
          continue;
        }

        const { data: todayLog } = await admin
          .from("daily_logs")
          .select("id")
          .eq("user_id", profile.id)
          .eq("log_date", todayStr)
          .maybeSingle();

        if (todayLog) {
          skippedLogged++;
          continue;
        }

        const { data: userData, error: userErr } = await admin.auth.admin.getUserById(profile.id);
        if (userErr || !userData?.user?.email) {
          errors.push(`no email for ${profile.id}: ${userErr ? JSON.stringify(userErr) : 'no user'}`);
          continue;
        }
        const email = userData.user.email;

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [email],
            subject: "You haven't logged today — keep your streak alive",
            html: `
              <div style="font-family:monospace;background:#0C0B09;color:#F5F2EC;padding:32px">
                <p style="color:#F46A38;letter-spacing:0.2em;font-size:11px;text-transform:uppercase">LCKD—IN</p>
                <h1 style="font-size:22px;margin:16px 0">Don't break the streak, ${profile.username}.</h1>
                <p style="font-size:14px;line-height:1.7;color:#BCB7A9">
                  You haven't logged today yet. Five seconds is all it takes — check off your rules before the day resets.
                </p>
                <p style="margin-top:24px">
                  <a href="https://lckd-in.com/app" style="background:#F5F2EC;color:#0C0B09;padding:12px 24px;text-decoration:none;font-family:monospace;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;display:inline-block">Log today's rules</a>
                </p>
                <p style="margin-top:28px;font-size:10px;color:#5B564A">Don't want these? Turn off reminder emails from your dashboard at lckd-in.com/app.</p>
              </div>
            `,
          }),
        });

        if (!resendRes.ok) {
          const detail = await resendRes.text();
          errors.push(`resend failed for ${email}: ${detail}`);
          continue;
        }

        await admin.from("profiles").update({ last_reminder_sent_at: now.toISOString() }).eq("id", profile.id);
        sent++;
      } catch (innerErr) {
        errors.push(`profile ${profile.id} threw: ${innerErr instanceof Error ? innerErr.message : JSON.stringify(innerErr)}`);
      }
    }

    return new Response(JSON.stringify({ sent, skippedLogged, skippedRateLimit, skippedOptedOut, errors }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : JSON.stringify(err), stack: err instanceof Error ? err.stack : undefined }), { status: 500 });
  }
});
