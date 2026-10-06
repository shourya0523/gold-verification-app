// Stands in for the Supabase API gateway: serves web/ with a local config.js,
// and forwards /rest/v1 to PostgREST and /functions/v1 to the Edge Function.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [port, webDir, restPort, fnPort, configJs] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function forward(req, res, targetPort, targetPath) {
  const headers = { ...req.headers, host: `localhost:${targetPort}` };
  const up = http.request({ host: "127.0.0.1", port: targetPort, path: targetPath, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/rest/v1/")) return forward(req, res, restPort, req.url.slice("/rest/v1".length));
  if (url.pathname.startsWith("/functions/v1/source")) {
    const rest = req.url.slice("/functions/v1/source".length);
    return forward(req, res, fnPort, rest.startsWith("/") ? rest : `/${rest}`);
  }
  if (url.pathname === "/config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(configJs)); }
  const file = path.join(webDir, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(webDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), () => console.log(`gateway on ${port}`));
