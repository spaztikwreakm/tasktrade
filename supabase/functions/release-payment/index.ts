// Supabase Edge Function: release-payment
//
// Body: { jobId: string, action: "release" | "refund" }
// - "release": customer confirms the job is done -> capture the held
//   PaymentIntent, which pays out to the tradie's connected account minus
//   the platform fee (set on the PaymentIntent at creation time).
// - "refund": customer or admin cancels -> cancel/refund the PaymentIntent.
//
// Only the job's customer or an admin may call this. Deploy + secrets same
// as the other payment functions (STRIPE_SECRET_KEY).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const { jobId, action } = await req.json();
    if (!jobId || !["release", "refund"].includes(action)) {
      return new Response(JSON.stringify({ error: "jobId and valid action required" }), { status: 400 });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !userData?.user) return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });

    const { data: job } = await supabase.from("jobs").select("id, customer_id").eq("id", jobId).single();
    const { data: requester } = await supabase.from("profiles").select("role").eq("id", userData.user.id).single();
    const isAdmin = requester?.role === "admin";
    if (!job || (job.customer_id !== userData.user.id && !isAdmin)) {
      return new Response(JSON.stringify({ error: "Not authorised" }), { status: 403 });
    }

    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("job_id", jobId)
      .eq("status", "held")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!payment?.stripe_payment_intent_id) {
      return new Response(JSON.stringify({ error: "No held payment found for this job" }), { status: 404 });
    }

    if (action === "release") {
      await stripe.paymentIntents.capture(payment.stripe_payment_intent_id);
      await supabase
        .from("payments")
        .update({ status: "released", released_at: new Date().toISOString() })
        .eq("id", payment.id);
      await supabase.from("jobs").update({ status: "completed" }).eq("id", jobId);
    } else {
      await stripe.paymentIntents.cancel(payment.stripe_payment_intent_id).catch(async () => {
        // Already captured -> refund instead of cancel
        await stripe.refunds.create({ payment_intent: payment.stripe_payment_intent_id });
      });
      await supabase
        .from("payments")
        .update({ status: "refunded", refunded_at: new Date().toISOString() })
        .eq("id", payment.id);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
