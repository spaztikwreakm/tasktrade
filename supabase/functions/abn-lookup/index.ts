// Supabase Edge Function: abn-lookup
//
// Verifies a tradie's ABN against the real Australian Business Register.
// You need a free ABR Web Services GUID: register at
//   https://abr.business.gov.au/Tools/WebServices
// (approval is usually same-day). This does NOT verify trade licences —
// those are state-based (see README "Licence verification" section) and
// mostly require manual document upload + human review at launch.
//
// Deploy:  supabase functions deploy abn-lookup
// Secrets: ABR_GUID

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const { abn } = await req.json();
    const cleanAbn = String(abn ?? "").replace(/\s+/g, "");

    if (!/^\d{11}$/.test(cleanAbn) || !isValidAbnChecksum(cleanAbn)) {
      return new Response(JSON.stringify({ valid: false, error: "Invalid ABN format or checksum" }), { status: 400 });
    }

    const guid = Deno.env.get("ABR_GUID")!;
    const url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${cleanAbn}&guid=${guid}`;
    const res = await fetch(url);
    const text = await res.text();
    // ABR returns JSONP-ish text; strip the callback wrapper if present.
    const jsonText = text.replace(/^callback\(/, "").replace(/\)$/, "");
    const data = JSON.parse(jsonText);

    if (data.Message) {
      return new Response(JSON.stringify({ valid: false, error: data.Message }), { status: 400 });
    }

    const isActive = data.AbnStatus === "Active";
    const entityName = data.EntityName || data.BusinessName?.[0] || null;

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await anonClient.auth.getUser();
    if (userData?.user) {
      await supabase
        .from("profiles")
        .update({
          abn: cleanAbn,
          abn_status: isActive ? "verified" : "rejected",
          abn_verified_name: entityName,
        })
        .eq("id", userData.user.id);
    }

    return new Response(
      JSON.stringify({ valid: isActive, entityName, abnStatus: data.AbnStatus }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});

// Official ABN checksum algorithm (modulus 89) — catches typos before
// spending an ABR lookup call.
function isValidAbnChecksum(abn: string): boolean {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = abn.split("").map(Number);
  digits[0] -= 1;
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  return sum % 89 === 0;
}
