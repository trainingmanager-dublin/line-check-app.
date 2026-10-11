/*
 * Local preview of the app: serves public/ on http://localhost:8888
 *   npm start      (PORT=9000 npm start for another port)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT) || 8888;
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

createServer(async (req, res) => {
  try {
    let file = normalize(decodeURIComponent(new URL(req.url, "http://localhost").pathname)).replace(/^(\.\.[/\\])+/, "");
    if (file.endsWith("/")) file += "index.html";
    const body = await readFile(join(root, file));
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, () => console.log(`Line check on http://localhost:${port}`));
