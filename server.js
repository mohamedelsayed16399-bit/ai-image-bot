// server.js - zero-dependency web server: serves the chat UI and the JSON API.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createImage, editImage, SIZES, STYLES } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, "index.html");
const MAX_BODY = 15 * 1024 * 1024; // 15 MB uploads

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("الصورة أكبر من 15 ميجا"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("طلب غير صالح"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function toDataUrl(result) {
  return {
    ok: true,
    mime: result.mime,
    image: `data:${result.mime};base64,${result.buffer.toString("base64")}`,
    backend: result.backend,
    note: result.note || null,
  };
}

export function startServer(port = 3000, host = "0.0.0.0") {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        const html = await readFile(INDEX);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url === "/api/health") {
        sendJson(res, 200, { ok: true, sizes: Object.keys(SIZES), styles: Object.keys(STYLES) });
        return;
      }

      if (req.method === "POST" && req.url === "/api/create") {
        const body = await readJson(req);
        const prompt = String(body.prompt || "").trim();
        if (!prompt) return sendJson(res, 400, { ok: false, error: "اكتب وصف الصورة الأول" });
        const result = await createImage(prompt, { size: body.size, style: body.style });
        return sendJson(res, 200, toDataUrl(result));
      }

      if (req.method === "POST" && req.url === "/api/edit") {
        const body = await readJson(req);
        const prompt = String(body.prompt || "").trim();
        const imageBase64 = String(body.image || "").replace(/^data:image\/\w+;base64,/, "");
        if (!prompt) return sendJson(res, 400, { ok: false, error: "اكتب التعديل المطلوب الأول" });
        if (!imageBase64) return sendJson(res, 400, { ok: false, error: "ابعت الصورة اللي عايز تعدلها" });
        const result = await editImage(Buffer.from(imageBase64, "base64"), prompt, {
          size: body.size,
          style: body.style,
          strength: body.strength,
        });
        return sendJson(res, 200, toDataUrl(result));
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  });

  server.listen(port, host, () => {
    console.log(`AI Image Bot UI: http://localhost:${port}`);
  });
  return server;
}
