// Supabase Edge Function: create-checkout-session
//
// Starts a Stripe Checkout session for a customer to pay an accepted quote.
// Uses `manual` capture on a destination charge so the platform can hold
// funds and release them to the tradie's connected account once the job is
// marked completed (see the stripe-webhook function + your admin release
// flow). Platform fee is taken as `application_fee_amount`.
//
// Deploy:  supabase functions deploy create-checkout-session
// Secrets: STRIPE_SECRET_KEY, APP_URL, PLATFORM_FEE_BPS (e.g. 800 = 8%)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

const FEE_BPS = Number(Deno.env.get("PLATFORM_FEE_BPS") ?? "800"); // 8% default

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const { quoteId } = await req.json();
    if (!quoteId) return new Response(JSON.stringify({ error: "quoteId required" }), { status: 400 });

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
    }

    const { data: quote, error: quoteErr } = await supabase
      .from("quotes")
      .select("id, job_id, tradie_id, amount, status, jobs!inner(id, customer_id, title, status)")
      .eq("id", quoteId)
      .single();

    if (quoteErr || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), { status: 404 });
    }
    const job = (quote as any).jobs;
    if (job.customer_id !== userData.user.id) {
      return new Response(JSON.stringify({ error: "Not your job" }), { status: 403 });
    }
    if (quote.status !== "accepted") {
      return new Response(JSON.stringify({ error: "Quote is not accepted yet" }), { status: 400 });
    }

    const { data: tradieProfile } = await supabase
      .from("profiles")
      .select("stripe_connect_account_id, stripe_connect_ready")
      .eq("id", quote.tradie_id)
      .single();

    if (!tradieProfile?.stripe_connect_account_id || !tradieProfile.stripe_connect_ready) {
      return new Response(
        JSON.stringify({ error: "Tradie has not finished payment onboarding yet" }),
        { status: 400 },
      );
    }

    const amountCents = Math.round(Number(quote.amount) * 100);
    const feeCents = Math.round((amountCents * FEE_BPS) / 10000);
    const appUrl = Deno.env.get("APP_URL")!;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "aud",
            unit_amount: amountCents,
            product_data: { name: `Job payment: ${job.title}` },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        capture_method: "manual", // platform holds funds until job completion
        application_fee_amount: feeCents,
        transfer_data: { destination: tradieProfile.stripe_connect_account_id },
      },
      success_url: `${appUrl}/?view=jobs&job=${job.id}&payment=success`,
      cancel_url: `${appUrl}/?view=jobs&job=${job.id}&payment=cancelled`,
      metadata: { job_id: job.id, quote_id: quote.id, tradie_id: quote.tradie_id, customer_id: job.customer_id },
    });

    await supabase.from("payments").insert({
      job_id: job.id,
      customer_id: job.customer_id,
      tradie_id: quote.tradie_id,
      amount: quote.amount,
      platform_fee: feeCents / 100,
      status: "requires_payment",
      stripe_checkout_session_id: session.id,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
