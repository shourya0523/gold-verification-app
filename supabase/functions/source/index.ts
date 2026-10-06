// Fetches a gold row's source document so the app can show it inline.
//
// GET /functions/v1/source?url=<source_url>  (apikey: the app's key)
//
// Only URLs that some gold row cites are fetched, which keeps this from being
// an open proxy. The app has no sign-in, so the function is deployed with
// verify_jwt off and the lookup runs with the project's anon key. The response
// is the document's bytes, with X-Final-Url (after redirects) so relative
// links in an HTML page can be resolved, and X-Source-Content-Type because the
// platform serves text/html from functions as text/plain.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-reviewer",
  "Access-Control-Expose-Headers": "x-final-url, x-source-content-type, content-type",
};

function reply(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const target = new URL(req.url).searchParams.get("url");
  if (!target) return reply(400, "missing url");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anon = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: cited, error } = await anon
    .from("rows").select("gold_id").eq("source_url", target).limit(1);
  if (error) return reply(500, error.message);
  if (!cited?.length) return reply(403, "not a source any gold row cites");

  // SEC asks automated clients to name a contact, and rate-limits per
  // User-Agent/IP. Each request declares the requesting reviewer's own email
  // (x-reviewer, accepted only if it is on team_members) so reviewers get
  // separate limits; app_config's sec_contact is the fallback.
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let contact: string | undefined;
  const reviewer = req.headers.get("x-reviewer")?.trim();
  if (reviewer) {
    const { data: member } = await admin
      .from("team_members").select("email").eq("email", reviewer).maybeSingle();
    contact = member?.email;
  }
  if (!contact) {
    const { data: config } = await admin
      .from("app_config").select("value").eq("key", "sec_contact").maybeSingle();
    contact = config?.value;
  }
  const agent = `GoldVerification/1.0 (document preview for a review team${
    contact ? `; ${contact}` : ""})`;

  const get = () => fetch(target, {
    headers: { "User-Agent": agent, Accept: "text/html,application/pdf,*/*" },
    redirect: "follow",
  });
  // Hosts (SEC among them) answer 429 or 5xx under load. Retry with
  // exponential backoff plus jitter (1s, 2s, 4s, 8s), honouring Retry-After.
  const MAX_RETRIES = 4;
  const BASE_MS = 1000;
  const MAX_WAIT_MS = 10000;
  let upstream: Response;
  try {
    upstream = await get();
    for (let attempt = 0;
         attempt < MAX_RETRIES && (upstream.status === 429 || upstream.status >= 500);
         attempt++) {
      const retryAfter = Number(upstream.headers.get("Retry-After")) * 1000;
      await upstream.body?.cancel();
      const backoff = BASE_MS * 2 ** attempt * (0.5 + Math.random() / 2);
      const wait = Math.min(MAX_WAIT_MS, Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.max(retryAfter, backoff) : backoff);
      await new Promise((resolve) => setTimeout(resolve, wait));
      upstream = await get();
    }
  } catch (err) {
    return reply(502, `could not reach the source: ${err}`);
  }
  if (!upstream.ok) return reply(502, `source answered ${upstream.status}`);
  return new Response(upstream.body, {
    headers: {
      ...CORS,
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "X-Final-Url": upstream.url,
      "X-Source-Content-Type": upstream.headers.get("Content-Type") ?? "",
      "Cache-Control": "private, max-age=86400",
    },
  });
});
