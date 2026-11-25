// engine.js - the image brain of the bot.
// Two free backends, no paid keys needed:
//   1. Pollinations "classic" endpoint (anonymous, model: sana) - text -> image
//   2. Stable Horde (anonymous key "0000000000", crowdsourced GPUs) - text -> image AND image editing (img2img)
// Every function returns { buffer: Buffer, mime: string, backend: string }.

const HORDE_BASE = "https://stablehorde.net/api/v2";
const HORDE_ANON_KEY = "0000000000"; // official anonymous key, lowest priority but free forever
const CLIENT_AGENT = "ai-image-bot:1.0:github";

export const SIZES = {
  square: { width: 768, height: 768 },
  portrait: { width: 576, height: 960 },
  landscape: { width: 960, height: 576 },
};

export const STYLES = {
  none: "",
  realistic: ", ultra realistic photo, 85mm lens, studio lighting, sharp focus",
  anime: ", anime style, studio ghibli inspired, vibrant colors, clean line art",
  oil: ", classical oil painting, visible brush strokes, canvas texture",
  logo: ", minimal flat vector logo, white background, crisp edges",
  sticker: ", die-cut sticker, thick white outline, bold colors, plain background",
  cyberpunk: ", cyberpunk style, neon lights, rain, cinematic",
  "3d": ", 3d render, pixar style, soft lighting, subsurface scattering",
};

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// ---------- Backend 1: Pollinations (text -> image) ----------

async function pollinationsCreate(prompt, { width, height }) {
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const url =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(prompt) +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true`;
  const { signal, done } = withTimeout(120_000);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
    const mime = res.headers.get("content-type") || "";
    if (!mime.startsWith("image/")) throw new Error(`Pollinations returned ${mime}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 10_000) throw new Error("Pollinations returned a tiny/empty image");
    return { buffer, mime, backend: "pollinations" };
  } finally {
    done();
  }
}

// ---------- Backend 2: Stable Horde (text -> image, and image -> image edit) ----------

async function hordeSubmit(payload) {
  const res = await fetch(`${HORDE_BASE}/generate/async`, {
    method: "POST",
    headers: {
      apikey: HORDE_ANON_KEY,
      "Content-Type": "application/json",
      "Client-Agent": CLIENT_AGENT,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stable Horde HTTP ${res.status}: ${body.message || "request rejected"}`);
  }
  if (!body.id) throw new Error(`Stable Horde: ${body.message || "no job id returned"}`);
  return body.id;
}

async function hordeWait(id, timeoutMs = 8 * 60_000) {
  const started = Date.now();
  let lastQueue = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${HORDE_BASE}/generate/check/${id}`);
    if (!res.ok) throw new Error(`Stable Horde check HTTP ${res.status}`);
    const check = await res.json();
    if (check.faulted) throw new Error("Stable Horde: job faulted");
    if (check.done) return id;
    lastQueue = check.queue_position;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Stable Horde: timed out waiting (queue position was ${lastQueue}). Anonymous jobs wait for a free volunteer GPU; try again in a minute.`
      );
    }
  }
}

async function hordeFetch(id) {
  const res = await fetch(`${HORDE_BASE}/generate/status/${id}`);
  if (!res.ok) throw new Error(`Stable Horde status HTTP ${res.status}`);
  const status = await res.json();
  const gen = status.generations && status.generations[0];
  if (!gen || !gen.img) throw new Error("Stable Horde: no image in result");
  const imgRes = await fetch(gen.img);
  if (!imgRes.ok) throw new Error(`Stable Horde image download HTTP ${imgRes.status}`);
  const mime = imgRes.headers.get("content-type") || "image/webp";
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return { buffer, mime, backend: `stable-horde (${gen.model || "community model"})` };
}

// Anonymous Horde jobs must stay within the free work budget: max side 576,
// and Horde workers require dimensions divisible by 64.
function hordeDims(width, height) {
  const scale = Math.min(1, 576 / Math.max(width, height));
  return {
    width: Math.max(64, Math.round((width * scale) / 64) * 64),
    height: Math.max(64, Math.round((height * scale) / 64) * 64),
  };
}

async function hordeCreate(prompt, dims) {
  const { width, height } = hordeDims(dims.width, dims.height);
  const id = await hordeSubmit({
    prompt,
    params: { width, height, n: 1, steps: 30 },
    models: ["stable_diffusion"],
    nsfw: false,
    censor_nsfw: true,
  });
  await hordeWait(id);
  return hordeFetch(id);
}

async function hordeEdit(imageBuffer, prompt, { width, height, strength }) {
  const dims = hordeDims(width, height);
  const id = await hordeSubmit({
    prompt,
    params: {
      width: dims.width,
      height: dims.height,
      n: 1,
      steps: 30,
      denoising_strength: strength,
    },
    models: ["stable_diffusion"],
    nsfw: false,
    censor_nsfw: true,
    source_image: imageBuffer.toString("base64"),
  });
  await hordeWait(id);
  return hordeFetch(id);
}

// ---------- Public API ----------

export async function createImage(prompt, { size = "square", style = "none" } = {}) {
  const dims = SIZES[size] || SIZES.square;
  const fullPrompt = prompt + (STYLES[style] || "");
  try {
    return await pollinationsCreate(fullPrompt, dims);
  } catch (err) {
    const result = await hordeCreate(fullPrompt, dims);
    result.note = `Primary backend failed (${err.message}); used Stable Horde.`;
    return result;
  }
}

export async function editImage(imageBuffer, prompt, { size = "square", strength = 0.6, style = "none" } = {}) {
  const dims = SIZES[size] || SIZES.square;
  const clamped = Math.min(0.95, Math.max(0.2, Number(strength) || 0.6));
  const fullPrompt = prompt + (STYLES[style] || "");
  return hordeEdit(imageBuffer, fullPrompt, { ...dims, strength: clamped });
}
