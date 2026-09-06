// Supabase Edge Function: create-connect-account
//
// Creates (or resumes) a Stripe Express Connect account for a tradie so they
// can receive payouts, then returns a one-time onboarding link.
//
// Deploy:   supabase functions deploy create-connect-account
// Secrets:  supabase secrets set STRIPE_SECRET_KEY=sk_test_...
//           supabase secrets set APP_URL=https://your-domain.example
//
// Called from the browser with the user's Supabase auth JWT in the
// Authorization header — this function uses that to identify the tradie and
// the service-role key (env-injected automatically) to write back to the DB.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

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
    const userId = userData.user.id;

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, role, full_name, stripe_connect_account_id, is_suspended")
      .eq("id", userId)
      .single();

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: "Profile not found" }), { status: 404 });
    }
    if (profile.role !== "tradie") {
      return new Response(JSON.stringify({ error: "Only tradie accounts can onboard for payouts" }), { status: 403 });
    }
    if (profile.is_suspended) {
      return new Response(JSON.stringify({ error: "Account suspended" }), { status: 403 });
    }

    let accountId = profile.stripe_connect_account_id as string | null;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "AU",
        email: userData.user.email ?? undefined,
        business_type: "individual",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      await supabase
        .from("profiles")
        .update({ stripe_connect_account_id: accountId })
        .eq("id", userId);
    }

    const appUrl = Deno.env.get("APP_URL")!;
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/?view=profile&connect=refresh`,
      return_url: `${appUrl}/?view=profile&connect=done`,
      type: "account_onboarding",
    });

    return new Response(JSON.stringify({ url: accountLink.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
