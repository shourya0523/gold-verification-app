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
//
// Every document fetched is kept, gzipped, in the private `sources` bucket and
// listed in source_cache; later requests are served from there. A cited
// document is a fixed thing to review against, and SEC throttles by address,
// which this function shares with every other tenant of the platform, so a
// document fetched once should not be asked for again. X-Source-Cache says
// whether a response was a "hit" or a "miss".
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "x-final-url, x-source-content-type, x-source-cache, content-type",
};
const BUCKET = "sources";
// Waits before each retry of a 429 or 5xx, unless the host's Retry-After asks
// for longer (capped, so a reviewer is not left waiting on a page).
const RETRY_WAITS_MS = [2000, 5000];
const MAX_RETRY_AFTER_MS = 10000;

function reply(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** The cache object's name: the URL's SHA-256, so any URL makes a safe path. */
async function cachePath(url: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return `${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}.gz`;
}

async function gzip(bytes: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function served(body: BodyInit, type: string, finalUrl: string, cache: "hit" | "miss"): Response {
  return new Response(body, {
    headers: {
      ...CORS,
      "Content-Type": type || "application/octet-stream",
      "X-Final-Url": finalUrl,
      "X-Source-Content-Type": type,
      "X-Source-Cache": cache,
      "Cache-Control": "private, max-age=86400",
    },
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

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: kept } = await admin
    .from("source_cache").select("path, content_type, final_url").eq("url", target).maybeSingle();
  if (kept) {
    const { data: blob } = await admin.storage.from(BUCKET).download(kept.path);
    if (blob) {
      const body = blob.stream().pipeThrough(new DecompressionStream("gzip"));
      return served(body, kept.content_type, kept.final_url, "hit");
    }
  }

  // SEC asks automated clients to name a contact; the project sets one in
  // app_config (key sec_contact). Other hosts get the same honest agent.
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
    for (const wait of RETRY_WAITS_MS) {
      if (upstream.status !== 429 && upstream.status < 500) break;
      const asked = Number(upstream.headers.get("Retry-After")) * 1000;
      await upstream.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(Math.max(wait, asked || 0), MAX_RETRY_AFTER_MS)));
      upstream = await get();
    }
  } catch (err) {
    return reply(502, `could not reach the source: ${err}`);
  }
  if (!upstream.ok) return reply(502, `source answered ${upstream.status}`);

  const bytes = await upstream.arrayBuffer();
  const type = upstream.headers.get("Content-Type") ?? "";
  // Kept before answering, so the next reviewer is served from the cache; a
  // failure to keep it costs only that.
  try {
    const path = await cachePath(target);
    const { error: upload } = await admin.storage.from(BUCKET)
      .upload(path, await gzip(bytes), { contentType: "application/gzip", upsert: true });
    if (!upload) {
      await admin.from("source_cache").upsert({
        url: target, path, content_type: type, final_url: upstream.url, bytes: bytes.byteLength,
      });
    }
  } catch (err) {
    console.error("could not cache", target, err);
  }
  return served(bytes, type, upstream.url, "miss");
});
