// Supabase Edge Function: stripe-webhook
//
// Receives Stripe events and updates our database. Register this URL in the
// Stripe Dashboard (Developers > Webhooks):
//   https://<project-ref>.functions.supabase.co/stripe-webhook
// Subscribe to at least: checkout.session.completed, payment_intent.amount_capturable_updated,
// payment_intent.succeeded, payment_intent.payment_failed, charge.refunded,
// account.updated
//
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await supabase
        .from("payments")
        .update({ status: "held", stripe_payment_intent_id: session.payment_intent as string })
        .eq("stripe_checkout_session_id", session.id);
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await supabase.from("payments").update({ status: "failed" }).eq("stripe_payment_intent_id", pi.id);
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      if (charge.payment_intent) {
        await supabase
          .from("payments")
          .update({ status: "refunded", refunded_at: new Date().toISOString() })
          .eq("stripe_payment_intent_id", charge.payment_intent as string);
      }
      break;
    }
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      const ready = Boolean(account.charges_enabled && account.payouts_enabled);
      await supabase
        .from("profiles")
        .update({ stripe_connect_ready: ready })
        .eq("stripe_connect_account_id", account.id);
      break;
    }
    default:
      // Unhandled event types are fine to ignore.
      break;
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
