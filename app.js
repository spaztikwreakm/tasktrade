// TaskTrade AU — production frontend
// Vanilla JS, no build step. Talks to Supabase (auth/db/storage/realtime)
// and to your deployed edge functions for anything that needs a secret key
// (Stripe, ABR lookup). See README.md for full setup.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.TASKTRADE_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const TRADES = ["Electrician", "Plumber", "Carpenter", "Painter", "Builder", "Landscaper", "Handyman", "Tiler", "Roofer", "Locksmith"];
const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const money = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(Number(n || 0));
const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ----------------------------------------------------------------------------
// App state
// ----------------------------------------------------------------------------
let session = null;
let profile = null;
let view = "home";
let selectedJobId = null;
let chatJobId = null;
let loading = true;
let errorMsg = "";
let messageChannel = null;

async function callFunction(name, body) {
  const { data: { session: s } } = await supabase.auth.getSession();
  const res = await fetch(`${cfg.FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s?.access_token ?? cfg.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setView(v) {
  view = v;
  selectedJobId = null;
  errorMsg = "";
  render();
  window.scrollTo(0, 0);
}
window.setView = setView;

// ----------------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------------
async function refreshProfile() {
  if (!session) { profile = null; return; }
  const { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
  if (error) { console.error(error); profile = null; errorMsg = "You are signed in, but your profile could not be loaded. Please retry or contact support."; return; }
  profile = data;
}

async function bootstrap() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  await refreshProfile();
  loading = false;
  render();

  supabase.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
    // Supabase holds its auth lock while invoking this callback. Run database
    // work in a later task so sign-in can release that lock first.
    setTimeout(async () => {
      try {
        await refreshProfile();
      } catch (err) {
        profile = null;
        errorMsg = "Your profile could not be loaded. Please retry.";
        console.error(err);
      }
      render();
    }, 0);
  });
}

async function signUp(e) {
  e.preventDefault();
  errorMsg = "";
  const f = new FormData(e.target);
  const email = f.get("email"), password = f.get("password");
  const role = f.get("role");
  try {
    const { error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: {
          full_name: f.get("name"),
          role,
          postcode: f.get("postcode"),
          trade: role === "tradie" ? f.get("trade") : null,
        },
      },
    });
    if (error) throw error;
    toast("Check your email to confirm your account.");
    render();
  } catch (err) {
    errorMsg = err.message;
    render();
  }
}
window.signUp = signUp;

async function signIn(e) {
  e.preventDefault();
  errorMsg = "";
  const f = new FormData(e.target);
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
    if (error) throw error;
  } catch (err) {
    errorMsg = err.message;
    render();
  }
}
window.signIn = signIn;

async function signOut() {
  await supabase.auth.signOut();
  view = "home";
  render();
}
window.signOut = signOut;

let authMode = "signin";
function setAuthMode(m) { authMode = m; errorMsg = ""; render(); }
window.setAuthMode = setAuthMode;
let signupRole = "customer";
function setSignupRole(r) { signupRole = r; render(); }
window.setSignupRole = setSignupRole;

// ----------------------------------------------------------------------------
// Rate limiting helper — checked client-side for UX; real enforcement should
// also be added as a Postgres function/edge function for anything payment or
// abuse sensitive before public launch.
// ----------------------------------------------------------------------------
async function underRateLimit(action, max, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const { count } = await supabase
    .from("rate_limit_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", session.user.id)
    .eq("action", action)
    .gte("created_at", since);
  if ((count ?? 0) >= max) return false;
  await supabase.from("rate_limit_events").insert({ user_id: session.user.id, action });
  return true;
}

// ----------------------------------------------------------------------------
// Jobs
// ----------------------------------------------------------------------------
async function postJob(e) {
  e.preventDefault();
  errorMsg = "";
  if (!(await underRateLimit("post_job", 10, 60))) { errorMsg = "You're posting jobs too quickly. Try again shortly."; render(); return; }
  const f = new FormData(e.target);
  const { data: job, error } = await supabase.from("jobs").insert({
    customer_id: session.user.id,
    title: f.get("title"),
    category: f.get("category"),
    postcode: f.get("postcode"),
    budget: Number(f.get("budget")) || null,
    timing: f.get("timing"),
    description: f.get("description"),
  }).select().single();
  if (error) { errorMsg = error.message; render(); return; }

  const files = $("#jobPhotos")?.files;
  if (files && files.length) {
    for (const file of Array.from(files).slice(0, 6)) {
      const path = `${job.id}/${crypto.randomUUID()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from("job-photos").upload(path, file);
      if (!upErr) await supabase.from("job_photos").insert({ job_id: job.id, storage_path: path });
    }
  }
  toast("Job posted.");
  setView("jobs");
}
window.postJob = postJob;

async function fetchJobs() {
  if (profile.role === "customer") {
    const { data } = await supabase.from("jobs").select("*").eq("customer_id", session.user.id).order("created_at", { ascending: false });
    return data || [];
  }
  const { data } = await supabase.from("jobs").select("*").eq("status", "open").eq("category", profile.trade || "").order("created_at", { ascending: false });
  return data || [];
}

async function fetchJobDetail(jobId) {
  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  const { data: customer } = await supabase.from("profiles").select("full_name, rating").eq("id", job.customer_id).single();
  const { data: quotes } = await supabase.from("quotes").select("*, profiles:tradie_id(full_name, trade, rating, rating_count, abn_status)").eq("job_id", jobId).order("amount", { ascending: true });
  const { data: photos } = await supabase.from("job_photos").select("storage_path").eq("job_id", jobId);
  const photoUrls = [];
  for (const p of photos || []) {
    const { data: signed } = await supabase.storage.from("job-photos").createSignedUrl(p.storage_path, 3600);
    if (signed) photoUrls.push(signed.signedUrl);
  }
  return { job, customer, quotes: quotes || [], photoUrls };
}

async function openJob(id) { selectedJobId = id; render(); }
window.openJob = openJob;

async function submitQuote(e, jobId) {
  e.preventDefault();
  errorMsg = "";
  if (profile.abn_status !== "verified") {
    errorMsg = "Verify your ABN in Profile before sending quotes.";
    render();
    return;
  }
  if (!(await underRateLimit("send_quote", 30, 60))) { errorMsg = "Too many quotes sent recently. Try again shortly."; render(); return; }
  const f = new FormData(e.target);
  const { error } = await supabase.from("quotes").insert({
    job_id: jobId, tradie_id: session.user.id,
    amount: Number(f.get("price")), message: f.get("message"),
  });
  if (error) { errorMsg = error.message; render(); return; }
  await supabase.from("jobs").update({ status: "quoted" }).eq("id", jobId).eq("status", "open");
  toast("Quote sent.");
  render();
}
window.submitQuote = submitQuote;

async function acceptQuote(quoteId, jobId) {
  await supabase.from("quotes").update({ status: "declined" }).eq("job_id", jobId).neq("id", quoteId);
  const { data: q } = await supabase.from("quotes").update({ status: "accepted" }).eq("id", quoteId).select().single();
  await supabase.from("jobs").update({ status: "hired", hired_tradie_id: q.tradie_id }).eq("id", jobId);
  toast("Tradie hired. You can now pay a deposit/full amount from the job page.");
  render();
}
window.acceptQuote = acceptQuote;

async function payForQuote(quoteId) {
  try {
    toast("Opening secure Stripe checkout...");
    const { url } = await callFunction("create-checkout-session", { quoteId });
    window.location.href = url;
  } catch (err) {
    toast(err.message);
  }
}
window.payForQuote = payForQuote;

async function releaseOrRefund(jobId, action) {
  try {
    await callFunction("release-payment", { jobId, action });
    toast(action === "release" ? "Payment released to tradie. Job marked complete." : "Payment refunded.");
    render();
  } catch (err) {
    toast(err.message);
  }
}
window.releaseOrRefund = releaseOrRefund;

let pendingReviewJob = null;
let pendingReviewTradieId = null;
function openReviewModal(jobId, tradieId) { pendingReviewJob = jobId; pendingReviewTradieId = tradieId; draftRating = 5; render(); }
window.openReviewModal = openReviewModal;
function closeReviewModal() { pendingReviewJob = null; render(); }
window.closeReviewModal = closeReviewModal;
let draftRating = 5;
function setDraftRating(n) { draftRating = n; render(); }
window.setDraftRating = setDraftRating;

async function submitReview(e, jobId, tradieId) {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await supabase.from("reviews").insert({
    job_id: jobId, customer_id: session.user.id, tradie_id: tradieId,
    rating: draftRating, comment: f.get("comment"),
  });
  if (error) { toast(error.message); return; }
  toast("Review posted.");
  pendingReviewJob = null;
  render();
}
window.submitReview = submitReview;

let reportTarget = null;
function openReport(userId, jobId) { reportTarget = { userId, jobId }; render(); }
window.openReport = openReport;
function closeReport() { reportTarget = null; render(); }
window.closeReport = closeReport;
async function submitReport(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await supabase.from("reports").insert({
    reporter_id: session.user.id, reported_user_id: reportTarget.userId,
    job_id: reportTarget.jobId, reason: f.get("reason"),
  });
  if (error) { toast(error.message); return; }
  toast("Report submitted. Our team will review it.");
  reportTarget = null;
  render();
}
window.submitReport = submitReport;

// ----------------------------------------------------------------------------
// Messaging (realtime)
// ----------------------------------------------------------------------------
async function openChat(jobId) {
  chatJobId = jobId;
  setView("messages");
}
window.openChat = openChat;

async function fetchMessages(jobId) {
  const { data } = await supabase.from("messages").select("*").eq("job_id", jobId).order("created_at", { ascending: true });
  return data || [];
}

function subscribeToMessages(jobId, onInsert) {
  if (messageChannel) supabase.removeChannel(messageChannel);
  messageChannel = supabase
    .channel(`messages-${jobId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `job_id=eq.${jobId}` }, onInsert)
    .subscribe();
}

async function sendMessage(e, jobId, toId) {
  e.preventDefault();
  const f = new FormData(e.target);
  const text = f.get("text");
  e.target.reset();
  const { error } = await supabase.from("messages").insert({ job_id: jobId, sender_id: session.user.id, recipient_id: toId, body: text });
  if (error) toast(error.message);
}
window.sendMessage = sendMessage;

// ----------------------------------------------------------------------------
// Profile / verification / payouts
// ----------------------------------------------------------------------------
async function verifyAbn(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    toast("Checking ABN against the Australian Business Register...");
    const result = await callFunction("abn-lookup", { abn: f.get("abn") });
    await refreshProfile();
    toast(result.valid ? `Verified: ${result.entityName}` : "ABN could not be verified (status: " + result.abnStatus + ")");
    render();
  } catch (err) {
    toast(err.message);
  }
}
window.verifyAbn = verifyAbn;

async function startStripeOnboarding() {
  try {
    toast("Opening Stripe onboarding...");
    const { url } = await callFunction("create-connect-account");
    window.location.href = url;
  } catch (err) {
    toast(err.message);
  }
}
window.startStripeOnboarding = startStripeOnboarding;

async function updateProfile(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await supabase.from("profiles").update({
    full_name: f.get("name"), postcode: f.get("postcode"), phone: f.get("phone"), bio: f.get("bio"),
  }).eq("id", session.user.id);
  if (error) { toast(error.message); return; }
  await refreshProfile();
  toast("Profile updated.");
  render();
}
window.updateProfile = updateProfile;

// ----------------------------------------------------------------------------
// Views
// ----------------------------------------------------------------------------
function appShell(body) {
  const roleLabel = profile.role === "tradie" ? (profile.trade || "Tradie") : profile.role === "admin" ? "Admin" : "Customer";
  return `<div class="shell">
    <header class="topbar">
      <div class="brand"><div class="logo">TT</div><div>TaskTrade AU</div></div>
      <div class="row"><span class="pill">${esc(roleLabel)}</span><button class="btn ghost" onclick="signOut()">Log out</button></div>
    </header>
    <main class="page">${errorMsg ? `<div class="banner-error">${esc(errorMsg)}</div>` : ""}${body}</main>
    <nav class="nav"><div class="nav-inner">
      ${navBtn("home", "⌂", "Home")}${navBtn("jobs", "⌕", profile.role === "customer" ? "My jobs" : "Leads")}
      ${profile.role === "customer" ? navBtn("post", "＋", "Post") : navBtn("jobs", "＋", "")}
      ${navBtn("messages", "✉", "Messages")}${navBtn("profile", "◎", "Profile")}
    </div></nav>
    ${reviewModal()}${reportModal()}
    <div class="footer-legal">© ${new Date().getFullYear()} TaskTrade AU · <a href="legal/terms-of-service.md" target="_blank">Terms</a> · <a href="legal/privacy-policy.md" target="_blank">Privacy</a> · <a href="legal/marketplace-rules.md" target="_blank">Marketplace rules</a> · <a href="legal/dispute-refund-policy.md" target="_blank">Disputes & refunds</a></div>
  </div>`;
}

function navBtn(v, icon, label) {
  return `<button class="${view === v ? "active" : ""}" onclick="setView('${v}')"><div>${icon}</div>${label}</button>`;
}

function verifiedBadge(status) {
  if (status === "verified") return `<span class="badge-verified">✓ ABN verified</span>`;
  if (status === "pending") return `<span class="badge-unverified">Verification pending</span>`;
  return `<span class="badge-unverified">Unverified</span>`;
}

function authView() {
  return `<div class="shell"><main class="page auth">
    <div class="hero"><h1>Jobs meet great tradies.</h1><p>Post work, compare verified local tradies, chat, pay securely and leave a review — all in one place.</p></div>
    <div class="card" style="margin-top:16px">
      <div class="seg"><button class="${authMode === "signin" ? "active" : ""}" onclick="setAuthMode('signin')">Log in</button><button class="${authMode === "signup" ? "active" : ""}" onclick="setAuthMode('signup')">Sign up</button></div>
      ${errorMsg ? `<div class="banner-error">${esc(errorMsg)}</div>` : ""}
      ${authMode === "signin" ? signInForm() : signUpForm()}
    </div>
  </main></div>`;
}

function signInForm() {
  return `<form onsubmit="signIn(event)" style="margin-top:16px">
    <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
    <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
    <button class="btn primary" style="width:100%">Log in</button>
  </form>`;
}

function signUpForm() {
  return `<form onsubmit="signUp(event)" style="margin-top:16px">
    <div class="field"><label>Name / business name</label><input name="name" required></div>
    <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
    <div class="field"><label>Password (min 8 characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
    <div class="field"><label>Postcode</label><input name="postcode" inputmode="numeric" pattern="[0-9]{4}" required></div>
    <div class="field"><label>I am a</label>
      <select name="role" onchange="setSignupRole(this.value)">
        <option value="customer" ${signupRole === "customer" ? "selected" : ""}>Customer</option>
        <option value="tradie" ${signupRole === "tradie" ? "selected" : ""}>Tradie</option>
      </select>
    </div>
    ${signupRole === "tradie" ? `<div class="field"><label>Primary trade</label><select name="trade">${TRADES.map((t) => `<option>${t}</option>`).join("")}</select></div>` : ""}
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:10px 0"><input type="checkbox" required style="margin-top:3px"><span>I agree to the <a href="legal/terms-of-service.md" target="_blank">Terms</a>, <a href="legal/privacy-policy.md" target="_blank">Privacy Policy</a> and <a href="legal/marketplace-rules.md" target="_blank">Marketplace Rules</a>.</span></label>
    <button class="btn primary" style="width:100%">Create account</button>
  </form>`;
}

async function renderHome() {
  if (profile.role === "customer") {
    const { data: jobs } = await supabase.from("jobs").select("*").eq("customer_id", session.user.id);
    const { data: quotes } = await supabase.from("quotes").select("id, job_id").in("job_id", (jobs || []).map((j) => j.id).length ? (jobs || []).map((j) => j.id) : ["00000000-0000-0000-0000-000000000000"]);
    return `<section class="hero"><h1>Get your next job sorted.</h1><p>Post the work once, compare tradies, then keep the conversation and quote in one place.</p>
      <div class="row" style="margin-top:18px"><button class="btn ghost" onclick="setView('post')">Post a job</button><button class="btn secondary" onclick="setView('jobs')">View my jobs</button></div></section>
      <div class="grid">
        <div class="card col4"><div class="muted">Open jobs</div><div class="stat">${(jobs || []).filter((j) => j.status === "open").length}</div></div>
        <div class="card col4"><div class="muted">Quotes received</div><div class="stat">${(quotes || []).length}</div></div>
        <div class="card col4"><div class="muted">Jobs hired/done</div><div class="stat">${(jobs || []).filter((j) => ["hired", "completed"].includes(j.status)).length}</div></div>
      </div>`;
  }
  const abnBanner = profile.abn_status !== "verified"
    ? `<div class="notice" style="margin-top:14px">Verify your ABN in <button class="link-btn" onclick="setView('profile')">Profile</button> before you can send quotes.</div>` : "";
  const payoutBanner = !profile.stripe_connect_ready
    ? `<div class="notice" style="margin-top:10px">Set up payouts in <button class="link-btn" onclick="setView('profile')">Profile</button> so customers can pay you securely.</div>` : "";
  const { data: leads } = await supabase.from("jobs").select("*").eq("status", "open").eq("category", profile.trade || "");
  return `<section class="hero"><h1>Win work near ${esc(profile.postcode || "")}.</h1><p>Browse relevant leads, send clear quotes and build your reputation with verified job reviews.</p>
    <div class="row" style="margin-top:18px"><button class="btn ghost" onclick="setView('jobs')">Browse leads</button></div></section>
    ${abnBanner}${payoutBanner}
    <div class="grid"><div class="card col12"><h2>Fresh leads in ${esc(profile.trade || "your trade")}</h2>${(leads || []).slice(0, 6).map(jobCard).join("") || '<div class="empty">No matching leads right now.</div>'}</div></div>`;
}

function jobCard(j) {
  return `<div class="job" style="padding:14px 0;border-bottom:1px solid var(--line)">
    <div class="row between"><h3>${esc(j.title)}</h3><span class="tag">${esc(j.status)}</span></div>
    <div class="row"><span class="tag">${esc(j.category)}</span><span class="tag">${esc(j.postcode)}</span>${j.budget ? `<span class="tag">Budget ${money(j.budget)}</span>` : ""}<span class="tag">${esc(j.timing || "")}</span></div>
    <div class="muted">${esc(j.description).slice(0, 160)}${j.description.length > 160 ? "…" : ""}</div>
    <div><button class="btn secondary" onclick="openJob('${j.id}')">View job</button></div>
  </div>`;
}

async function renderJobs() {
  if (selectedJobId) return renderJobDetail(selectedJobId);
  const jobs = await fetchJobs();
  return `<div class="row between"><div><h1>${profile.role === "customer" ? "My jobs" : "Available jobs"}</h1>
    <p class="muted">${profile.role === "tradie" ? "Showing open jobs matching your trade." : "Track quotes and choose who to hire."}</p></div>
    ${profile.role === "customer" ? '<button class="btn primary" onclick="setView(\'post\')">Post job</button>' : ""}</div>
    <div class="card">${jobs.length ? jobs.map(jobCard).join("") : '<div class="empty">Nothing here yet.</div>'}</div>`;
}

async function renderJobDetail(jobId) {
  const { job, customer, quotes, photoUrls } = await fetchJobDetail(jobId);
  const isOwner = job.customer_id === session.user.id;
  const myQuote = quotes.find((q) => q.tradie_id === session.user.id);
  let paymentBlock = "";
  if (isOwner && job.status === "hired") {
    const { data: payment } = await supabase.from("payments").select("*").eq("job_id", jobId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!payment) {
      const acceptedQuote = quotes.find((q) => q.status === "accepted");
      paymentBlock = `<div class="card" style="margin-top:14px"><h3>Pay for this job</h3><p class="muted">Funds are held securely by TaskTrade AU and only released to the tradie once you confirm the job is done.</p><button class="btn primary" onclick="payForQuote('${acceptedQuote.id}')">Pay ${money(acceptedQuote.amount)} securely</button></div>`;
    } else if (payment.status === "held") {
      paymentBlock = `<div class="card" style="margin-top:14px"><h3>Payment held: ${money(payment.amount)}</h3><p class="muted">Confirm once the work is finished so funds are released to the tradie.</p><div class="row"><button class="btn primary" onclick="releaseOrRefund('${jobId}','release')">Mark complete & release payment</button><button class="btn danger" onclick="releaseOrRefund('${jobId}','refund')">Cancel & refund me</button></div></div>`;
    } else {
      paymentBlock = `<div class="success" style="margin-top:14px">Payment ${esc(payment.status)}.</div>`;
    }
  }
  const reviewBlock = isOwner && job.status === "completed"
    ? `<button class="btn secondary" style="margin-top:10px" onclick="openReviewModal('${jobId}','${job.hired_tradie_id}')">Leave a review</button>` : "";

  return `<button class="btn ghost" onclick="selectedJobId=null;render()">← Back</button>
  <div class="grid">
    <div class="card col8">
      <div class="row between"><h1>${esc(job.title)}</h1><span class="tag">${esc(job.status)}</span></div>
      <div class="row"><span class="tag">${esc(job.category)}</span><span class="tag">${esc(job.postcode)}</span>${job.budget ? `<span class="tag">${money(job.budget)}</span>` : ""}</div>
      ${photoUrls.length ? `<div class="photo-thumbs">${photoUrls.map((u) => `<img src="${u}">`).join("")}</div>` : ""}
      <p>${esc(job.description)}</p>
      <p class="muted">Wanted: ${esc(job.timing || "Flexible")} · Posted by ${esc(customer?.name || customer?.full_name || "Customer")} · ${timeAgo(job.created_at)}</p>
      ${paymentBlock}${reviewBlock}
      ${profile.role === "tradie" && !isOwner ? quoteComposer(job, myQuote) : ""}
      ${isOwner ? customerQuotes(job, quotes) : ""}
    </div>
    <div class="card col4">
      <h3>Safety & trust</h3>
      <p class="muted">Payments are held until you confirm the job is complete. Only work with tradies whose ABN shows verified.</p>
      <button class="btn secondary" style="width:100%" onclick="openChat('${job.id}')">Open job chat</button>
      <button class="link-muted" style="margin-top:10px" onclick="openReport('${job.customer_id}','${job.id}')">Report this job</button>
    </div>
  </div>`;
}

function quoteComposer(job, existing) {
  if (existing) return `<div class="success" style="margin-top:14px"><strong>Quote sent: ${money(existing.amount)}</strong><br>${esc(existing.message)}<br><span class="tag" style="margin-top:6px">${esc(existing.status)}</span></div>`;
  return `<h2 style="margin-top:20px">Send quote</h2>
  <form onsubmit="submitQuote(event,'${job.id}')">
    <div class="field"><label>Quote amount (AUD)</label><input name="price" type="number" min="1" required></div>
    <div class="field"><label>Message / inclusions</label><textarea name="message" required placeholder="What is included? Any assumptions?"></textarea></div>
    <button class="btn primary">Send quote</button>
  </form>`;
}

function customerQuotes(job, quotes) {
  if (!quotes.length) return '<h2 style="margin-top:20px">Quotes</h2><div class="empty">No quotes yet.</div>';
  return `<h2 style="margin-top:20px">Quotes</h2>${quotes.map((q) => {
    const t = q.profiles;
    return `<div class="quote card" style="margin:10px 0">
      <div class="row between"><strong>${esc(t?.full_name || "Tradie")}</strong><strong>${money(q.amount)}</strong></div>
      <div class="row"><span class="stars">★ ${t?.rating || "New"}</span>${verifiedBadge(t?.abn_status)}</div>
      <p>${esc(q.message)}</p>
      ${q.status === "accepted" ? '<div class="success">Accepted</div>' : job.status === "open" || job.status === "quoted" ? `<button class="btn primary" onclick="acceptQuote('${q.id}','${job.id}')">Hire this tradie</button>` : `<span class="tag">${esc(q.status)}</span>`}
    </div>`;
  }).join("")}`;
}

function postView() {
  return `<div class="grid">
    <div class="card col8"><h1>Post a job</h1><p class="muted">Give tradies enough information to quote accurately.</p>
      <form onsubmit="postJob(event)">
        <div class="field"><label>Job title</label><input name="title" required placeholder="e.g. Install two outdoor power points"></div>
        <div class="field"><label>Trade category</label><select name="category">${TRADES.map((t) => `<option>${t}</option>`).join("")}</select></div>
        <div class="grid">
          <div class="col6 field"><label>Postcode</label><input name="postcode" value="${esc(profile.postcode || "")}" pattern="[0-9]{4}" required></div>
          <div class="col6 field"><label>Budget (AUD, optional)</label><input name="budget" type="number" min="0"></div>
        </div>
        <div class="field"><label>When do you need it?</label><select name="timing"><option>ASAP</option><option>This week</option><option>Within 2 weeks</option><option>This month</option><option>Flexible</option></select></div>
        <div class="field"><label>Description</label><textarea name="description" required minlength="10"></textarea></div>
        <div class="field"><label>Photos (optional, up to 6)</label><input id="jobPhotos" type="file" accept="image/*" multiple></div>
        <button class="btn primary">Publish job</button>
      </form>
    </div>
    <div class="card col4"><h3>Tips for a great job post</h3><p class="muted">Include measurements, access details and any council/strata constraints. Clear jobs get faster, more accurate quotes.</p></div>
  </div>`;
}

async function renderMessages() {
  let relevantJobs;
  if (profile.role === "customer") {
    const { data } = await supabase.from("jobs").select("*").eq("customer_id", session.user.id).in("status", ["quoted", "hired", "completed"]);
    relevantJobs = data || [];
  } else {
    const { data } = await supabase.from("quotes").select("jobs(*)").eq("tradie_id", session.user.id);
    relevantJobs = (data || []).map((r) => r.jobs).filter(Boolean);
  }
  const jid = chatJobId || relevantJobs[0]?.id;
  if (!jid) return '<div class="card empty">No conversations yet. Quotes unlock job chat.</div>';
  const job = relevantJobs.find((j) => j.id === jid) || (await supabase.from("jobs").select("*").eq("id", jid).single()).data;
  const { data: quotesForJob } = await supabase.from("quotes").select("*").eq("job_id", jid);
  const accepted = (quotesForJob || []).find((q) => q.status === "accepted");
  const tradieId = profile.role === "tradie" ? session.user.id : (accepted?.tradie_id || quotesForJob?.[0]?.tradie_id);
  const otherId = profile.role === "customer" ? tradieId : job.customer_id;
  const msgs = await fetchMessages(jid);

  subscribeToMessages(jid, (payload) => {
    if (view === "messages" && chatJobId === jid) render();
  });

  return `<div class="grid">
    <div class="card col4"><h2>Conversations</h2>${relevantJobs.map((x) => `<button class="btn ${x.id === jid ? "secondary" : "ghost"}" style="width:100%;margin:5px 0;text-align:left" onclick="chatJobId='${x.id}';render()">${esc(x.title)}</button>`).join("") || '<div class="empty">None yet.</div>'}</div>
    <div class="card col8"><h2>${esc(job?.title || "Chat")}</h2>
      <div class="chat">${msgs.map((m) => `<div class="bubble ${m.sender_id === session.user.id ? "me" : ""}">${esc(m.body)}</div>`).join("") || '<div class="empty">Start the conversation.</div>'}</div>
      ${otherId ? `<form class="row" style="margin-top:14px" onsubmit="sendMessage(event,'${jid}','${otherId}')"><input name="text" required placeholder="Write a message" style="flex:1;border:1px solid var(--line);border-radius:12px;padding:12px"><button class="btn primary">Send</button></form>` : '<div class="notice">Waiting on a quote before direct chat opens.</div>'}
    </div>
  </div>`;
}

async function renderProfile() {
  const p = profile;
  const tradieBlock = p.role === "tradie" ? `
    <div class="row" style="margin:10px 0"><span class="tag">${esc(p.trade || "")}</span>${verifiedBadge(p.abn_status)}<span class="tag">${p.stripe_connect_ready ? "Payouts ready" : "Payouts not set up"}</span></div>
    <p class="stars">★ ${p.rating || "New tradie"} (${p.rating_count} review${p.rating_count === 1 ? "" : "s"})</p>
    <div class="card" style="margin-top:14px"><h3>ABN verification</h3>
      <p class="muted">Required before you can send quotes. Checked live against the Australian Business Register.</p>
      <form onsubmit="verifyAbn(event)"><div class="field"><label>ABN (11 digits)</label><input name="abn" value="${esc(p.abn || "")}" pattern="[0-9\\s]{11,14}" required></div><button class="btn primary">Verify ABN</button></form>
    </div>
    <div class="card" style="margin-top:14px"><h3>Get paid</h3><p class="muted">Connect a Stripe account so customers can pay you securely through TaskTrade AU.</p><button class="btn primary" onclick="startStripeOnboarding()">${p.stripe_connect_ready ? "Manage payout account" : "Set up payouts with Stripe"}</button></div>
  ` : "";

  return `<div class="grid">
    <div class="card col8">
      <h1>${esc(p.full_name)}</h1>
      <p class="muted">${esc(session.user.email)} · ${esc(p.postcode || "")}</p>
      ${tradieBlock}
      <h3 style="margin-top:18px">Edit profile</h3>
      <form onsubmit="updateProfile(event)">
        <div class="field"><label>Name / business name</label><input name="name" value="${esc(p.full_name)}" required></div>
        <div class="field"><label>Postcode</label><input name="postcode" value="${esc(p.postcode || "")}" pattern="[0-9]{4}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(p.phone || "")}"></div>
        <div class="field"><label>Bio</label><textarea name="bio">${esc(p.bio || "")}</textarea></div>
        <button class="btn primary">Save changes</button>
      </form>
    </div>
    <div class="card col4"><h3>Account</h3><p class="muted">Signed in as ${esc(session.user.email)}.</p><button class="btn danger" style="width:100%" onclick="signOut()">Log out</button></div>
  </div>`;
}

function reviewModal() {
  if (!pendingReviewJob) return "";
  return `<div class="backdrop" onclick="if(event.target===this)closeReviewModal()"><div class="modal">
    <h2>Leave a review</h2>
    <div class="rating-input">${[1, 2, 3, 4, 5].map((n) => `<span class="${n <= draftRating ? "on" : ""}" onclick="setDraftRating(${n})">★</span>`).join("")}</div>
    <form onsubmit="submitReview(event,'${pendingReviewJob}','${pendingReviewTradieId}')">
      <div class="field"><label>Comment (optional)</label><textarea name="comment"></textarea></div>
      <div class="row"><button class="btn primary">Post review</button><button type="button" class="btn ghost" onclick="closeReviewModal()">Cancel</button></div>
    </form>
  </div></div>`;
}

function reportModal() {
  if (!reportTarget) return "";
  return `<div class="backdrop" onclick="if(event.target===this)closeReport()"><div class="modal">
    <h2>Report an issue</h2>
    <form onsubmit="submitReport(event)">
      <div class="field"><label>What happened?</label><textarea name="reason" required minlength="5"></textarea></div>
      <div class="row"><button class="btn primary">Submit report</button><button type="button" class="btn ghost" onclick="closeReport()">Cancel</button></div>
    </form>
  </div></div>`;
}

// ----------------------------------------------------------------------------
// Render loop
// ----------------------------------------------------------------------------
async function render() {
  const root = $("#app");
  if (loading) { root.innerHTML = '<div class="shell"><main class="page"><div class="skeleton" style="height:200px"></div></main></div>'; return; }
  if (!session || !profile) { root.innerHTML = authView(); return; }
  if (profile.is_suspended) { root.innerHTML = `<div class="shell"><main class="page"><div class="card"><h1>Account suspended</h1><p class="muted">${esc(profile.suspended_reason || "Contact support for details.")}</p><button class="btn ghost" onclick="signOut()">Log out</button></div></main></div>`; return; }

  let body = "<div class=\"skeleton\" style=\"height:160px\"></div>";
  root.innerHTML = appShell(body);

  if (view === "home") body = await renderHome();
  else if (view === "jobs") body = await renderJobs();
  else if (view === "post") body = profile.role === "customer" ? postView() : '<div class="card"><h2>Posting jobs is for customers</h2></div>';
  else if (view === "messages") body = await renderMessages();
  else if (view === "profile") body = await renderProfile();

  root.innerHTML = appShell(body);
}
window.render = render;

bootstrap();
