# TaskTrade AU — production build

A real customer/tradie marketplace: Supabase Auth + Postgres + Realtime +
Storage on the backend, Stripe Connect for held/escrow-style payments, live
ABN verification against the Australian Business Register, photo uploads,
reporting/moderation fields, rate limiting, and draft legal pages. No
frontend build step — plain HTML/CSS/JS.

**This is software, not a launched business.** The checklist below is
ordered — do it roughly top to bottom. Items marked 🧑‍⚖️/🏢 need a human
decision or external account, not code.

---

## 1. Create your Supabase project
1. Go to supabase.com → New project. Choose the **Sydney (ap-southeast-2)**
   region for AU data residency and lower latency.
2. In the SQL editor, paste and run the entire contents of
   `supabase/schema.sql`. This creates all tables, RLS policies, triggers,
   and two storage buckets (`job-photos` private, `avatars` public).
3. Project Settings → API: copy your **Project URL** and **anon public
   key** into `config.js`.
4. Authentication → Providers: email/password is on by default. Under
   Authentication → Email Templates, customise the confirmation email.
   Under URL Configuration, set your real site URL once you have a domain
   (step 6) so confirmation links work.

## 2. Deploy the edge functions (Stripe + ABR need a secret key — never put
those in frontend code)
Install the Supabase CLI, then from this folder:
```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy create-connect-account
supabase functions deploy create-checkout-session
supabase functions deploy release-payment
supabase functions deploy stripe-webhook
supabase functions deploy abn-lookup
```
Copy the base functions URL (shown after first deploy, or Project Settings
→ Edge Functions) into `config.js` as `FUNCTIONS_URL`.

## 3. 🏢 Create a Stripe account and enable Connect
1. stripe.com → create an account for your actual registered business
   (Stripe requires this to pay out real money — a sole trader ABN works).
2. Dashboard → Connect → Get started → choose **Express accounts**
   (matches the code in `create-connect-account`).
3. Developers → API keys → copy the **secret key** (starts `sk_test_...`
   while testing, `sk_live_...` for real money).
4. Set edge function secrets:
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
   supabase secrets set APP_URL=https://your-domain.example
   supabase secrets set PLATFORM_FEE_BPS=800   # 800 = 8% platform fee
   ```
5. Developers → Webhooks → Add endpoint →
   `https://YOUR-PROJECT-REF.functions.supabase.co/stripe-webhook`. Select
   events: `checkout.session.completed`, `payment_intent.payment_failed`,
   `charge.refunded`, `account.updated`. Copy the **signing secret** and:
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
6. **Test fully in Stripe test mode** (test cards: 4242 4242 4242 4242)
   before ever switching to live keys. Do a full loop: post job → quote →
   hire → pay → release → check the connected account received a transfer
   minus your fee.
7. 🧑‍⚖️ Before going live with real money: confirm whether you need an
   Australian Financial Services Licence (AFSL) exemption or ASIC guidance
   for holding customer funds as a payment intermediary — Stripe Connect's
   "destination charges with manual capture" model (used here) is common
   for marketplaces, but get advice specific to your fee/holding structure,
   especially the auto-release timing you choose.

## 4. 🏢 Get an ABR Web Services key for real ABN verification
1. Register free at https://abr.business.gov.au/Tools/WebServices —
   approval is usually same-day.
2. `supabase secrets set ABR_GUID=your-guid-here`
3. This verifies the ABN is registered and active, and pulls back the
   registered entity name. **It does not check trade licences.**

## 5. Licence verification (state-based — needs a manual step for launch)
There's no single national API for trade licences. For a real launch:
- **Fastest to ship:** require Tradies to upload a licence photo/PDF during
  signup (add a `licence-docs` private storage bucket + an admin review
  queue), and only flip `licence_status` to `verified` after a human check.
- **Per-state public lookups** you can link Customers to for their own
  peace of mind (not an API, just useful links to put in your UI/FAQ):
  NSW: https://www.onegov.nsw.gov.au/publicregister/ ·
  VIC (electrical/plumbing): https://www.vba.vic.gov.au/consumers/register-search ·
  QLD: https://www.qbcc.qld.gov.au/searches/licence-search ·
  WA: https://www.commerce.wa.gov.au/building-commission/check-licence-or-registration ·
  SA: https://www.cbs.sa.gov.au/public-register-search ·
  Verify current URLs before publishing — government sites restructure
  often.
- This starter's `profiles.licence_status` / `licence_number` /
  `licence_state` columns are ready for whichever flow you pick; the UI
  currently only surfaces ABN status — add a licence-docs uploader the same
  way job photos are uploaded in `app.js` (`postJob`) when you're ready.

## 6. Hosting and domain
1. Buy a domain (e.g. via a registrar or `.com.au` via an AU registrar —
   `.com.au` requires an ABN, which you'll have).
2. This is a static site — deploy to **Vercel**, **Netlify**, or
   **Cloudflare Pages** by pointing at this folder (no build command
   needed; output directory is the project root).
3. Update `APP_URL` secret and Supabase Auth URL Configuration to your real
   domain once live.

## 7. 🧑‍⚖️ Legal — required before accepting real customers
Draft policies are in `/legal` (Terms of Service, Privacy Policy,
Marketplace Rules, Dispute & Refund Policy) and linked from the signup form
and app footer. **They are drafts and say so at the top of each file — get
an Australian lawyer to review and localise them**, especially:
- Your actual platform fee and payment-holding period.
- Whether your fund-holding model needs AFSL advice (see step 3.7).
- Registering your business name/company (ASIC) if "TaskTrade AU" isn't
  already your registered entity name.
- Privacy Act 1988 applicability (the small business exemption often
  doesn't apply once you're processing payments/sensitive data — get
  advice).

## 8. Before you flip real users on: a launch QA pass
- [ ] Full signup → verify ABN → post job → quote → hire → pay (Stripe test
      mode) → release payment → leave review, on a real deployed URL, both
      roles, on a real phone.
- [ ] Confirm RLS: log in as User A, confirm you cannot query User B's
      quotes/messages via the browser network tab or Supabase JS console.
- [ ] Confirm the storage bucket policies: a Tradie who never quoted on a
      job cannot fetch its photos' signed URLs.
- [ ] Set up error monitoring (Sentry free tier is fine to start) — add
      your DSN to `config.js` and initialise it at the top of `app.js`.
- [ ] Basic accessibility pass: keyboard navigation through forms, colour
      contrast (the existing palette passes WCAG AA for body text), alt
      text on any images you add.
- [ ] Load `sw.js` in an incognito window, go offline, confirm the app
      shell still loads (data actions will correctly fail — this is a data
      app, full offline write support is out of scope for launch).
- [ ] Rate limiting in `app.js` (`underRateLimit`) is client-checked only —
      for a real launch, also enforce limits inside the edge functions or a
      Postgres function so a modified client can't bypass them.

## What changed from the original demo
- Real Supabase Auth (email/password + email confirmation) replacing
  `localStorage` fake accounts.
- Postgres with Row Level Security instead of an in-browser JSON blob —
  users can only ever read/write what RLS allows, verified server-side.
- Realtime job chat (Supabase Realtime channel per job).
- Job photo upload to private Storage with signed URLs.
- Stripe Connect: Tradie payout onboarding, held payments, release/refund
  flow, platform fee.
- Live ABN verification against the ABR; ABN required before a Tradie can
  quote.
- Reviews are now enforced (via RLS + trigger) to only be possible for a
  completed job's actual hired Tradie — can't be faked from the client.
- Reporting flow (`reports` table + in-app modal) and suspension fields for
  moderation.
- Basic rate limiting on job posting and quoting.
- Real PWA icons, a smarter service worker that never caches API calls,
  and a `config.js` so this can be deployed without editing source.
- Draft Terms, Privacy Policy, Marketplace Rules, and Dispute/Refund Policy
  linked from signup and the app footer.

## What's intentionally still your call
- **Pricing model** — `PLATFORM_FEE_BPS` defaults to 8%; the original
  README's advice still stands: compete on lead quality and low friction
  rather than copying a credit-heavy model.
- **Licence verification workflow** (step 5) — needs a product decision
  (self-declare + spot-check vs. upload + manual review before every
  Tradie can quote).
- **Auto-release window** for held payments — currently the code releases
  only on explicit customer action or admin/refund; add a scheduled
  Postgres function (`pg_cron`) if you want auto-release after N days, and
  disclose that window in the Dispute & Refund Policy.
- **Push notifications** for new quotes/messages — not included; Expo Push
  (mobile) or Web Push (browser) would be the next feature to add once
  you're on native apps or want re-engagement beyond email.
- **Geospatial matching** — jobs currently match Tradies by exact postcode
  + trade; `latitude`/`longitude` columns exist on `jobs` for when you add
  radius search (PostGIS `earthdistance` extension works well in Supabase).

## Local development
```bash
python3 -m http.server 8080
```
Open `http://localhost:8080`. You need `config.js` filled in and steps 1–4
done — this build has no offline demo mode, since the whole point was to
stop faking data and connect the real backend.
