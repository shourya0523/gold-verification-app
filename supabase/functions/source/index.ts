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
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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

  // SEC asks automated clients to name a contact; the project sets one in
  // app_config (key sec_contact). Other hosts get the same honest agent.
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: config } = await admin
    .from("app_config").select("value").eq("key", "sec_contact").maybeSingle();
  const agent = `GoldVerification/1.0 (document preview for a review team${
    config?.value ? `; ${config.value}` : ""})`;

  const get = () => fetch(target, {
    headers: { "User-Agent": agent, Accept: "text/html,application/pdf,*/*" },
    redirect: "follow",
  });
  let upstream: Response;
  try {
    upstream = await get();
    // Hosts (SEC among them) answer 429 or 5xx briefly under load; one retry.
    if (upstream.status === 429 || upstream.status >= 500) {
      await upstream.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
