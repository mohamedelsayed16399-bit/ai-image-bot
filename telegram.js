// telegram.js - optional Telegram adapter. Runs only when TELEGRAM_TOKEN is set.
// Zero dependencies: plain Bot API calls over fetch + long polling.
import { createImage, editImage } from "./engine.js";

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

const HELP = `أهلاً! أنا بوت صور بالذكاء الاصطناعي، مجاني 100%.

🎨 لإنشاء صورة: ابعت أي وصف، مثال:
قطة لابسة بدلة فضاء فوق القمر

✏️ لتعديل صورة: ابعت الصورة وفي نفس الرسالة اكتب التعديل، مثال:
(صورة + الكابشن: خلي الخلفية شاطئ)

أوامر:
/imagine <وصف> - إنشاء صورة
/edit <تعديل> - رد بيه على صورة عشان تعدلها
/strength <0.2-0.9> - قوة التعديل (الافتراضي 0.6، كل ما تزيد كل ما التغيير يكبر)
/size square|portrait|landscape - مقاس الصورة
/help - المساعدة دي

ملحوظة: التوليد بياخد من 10 ثواني لدقيقتين حسب الضغط على السيرفرات المجانية.`;

async function tg(token, method, payload) {
  const res = await fetch(API(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram ${method}: ${body.description || res.status}`);
  return body.result;
}

async function sendImage(token, chatId, result, caption) {
  const blob = new Blob([result.buffer], { type: result.mime });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  // Telegram shows webp inline only as document for some clients; photos prefer jpeg/png
  const method = result.mime.includes("webp") ? "sendDocument" : "sendPhoto";
  form.append(method === "sendPhoto" ? "photo" : "document", blob, "image" + extOf(result.mime));
  if (caption) form.append("caption", caption.slice(0, 1000));
  const res = await fetch(API(token, method), { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram ${method}: ${body.description || res.status}`);
}

function extOf(mime) {
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  return ".jpg";
}

async function downloadPhoto(token, fileId) {
  const file = await tg(token, "getFile", { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function startTelegram(token) {
  let offset = 0;
  const userSettings = new Map(); // chatId -> { size, strength }
  const settingsFor = (id) => userSettings.get(id) || { size: "square", strength: 0.6 };

  async function handle(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || msg.caption || "").trim();
    const photo = msg.photo && msg.photo[msg.photo.length - 1];
    const replyPhoto = msg.reply_to_message && msg.reply_to_message.photo &&
      msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1];

    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    const arg = text.slice(cmd.length).trim();

    if (cmd === "/start" || cmd === "/help") {
      await tg(token, "sendMessage", { chat_id: chatId, text: HELP });
      return;
    }
    if (cmd === "/strength") {
      const v = Math.min(0.9, Math.max(0.2, parseFloat(arg) || 0.6));
      userSettings.set(chatId, { ...settingsFor(chatId), strength: v });
      await tg(token, "sendMessage", { chat_id: chatId, text: `قوة التعديل بقت ${v}` });
      return;
    }
    if (cmd === "/size") {
      const v = ["square", "portrait", "landscape"].includes(arg) ? arg : "square";
      userSettings.set(chatId, { ...settingsFor(chatId), size: v });
      await tg(token, "sendMessage", { chat_id: chatId, text: `المقاس بقى ${v}` });
      return;
    }

    const settings = settingsFor(chatId);

    // Edit triggers: (1) a photo with a caption, (2) /edit <text> replying to a photo,
    // (3) any plain text replying to a photo.
    const wantsEdit = photo ? Boolean(text) : Boolean(replyPhoto && (cmd === "/edit" || (text && !cmd.startsWith("/"))));
    if (wantsEdit) {
      const editSource = photo || replyPhoto;
      const instruction = photo ? text : (cmd === "/edit" ? arg : text);
      if (!instruction) {
        await tg(token, "sendMessage", { chat_id: chatId, text: "اكتب التعديل بعد الأمر، مثال:\n/edit خلي الشعر أشقر" });
        return;
      }
      await tg(token, "sendChatAction", { chat_id: chatId, action: "upload_photo" });
      const wait = await tg(token, "sendMessage", { chat_id: chatId, text: "⏳ بعدّل الصورة... ثواني لدقيقتين." });
      try {
        const img = await downloadPhoto(token, editSource.file_id);
        const result = await editImage(img, instruction, settings);
        await sendImage(token, chatId, result, `✏️ ${instruction}`);
      } catch (err) {
        await tg(token, "sendMessage", { chat_id: chatId, text: `حصل خطأ: ${err.message}` });
      } finally {
        await tg(token, "deleteMessage", { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
      }
      return;
    }

    // Create: /imagine <prompt> or any plain text
    const prompt = cmd === "/imagine" ? arg : (!cmd.startsWith("/") && text ? text : null);
    if (prompt) {
      await tg(token, "sendChatAction", { chat_id: chatId, action: "upload_photo" });
      const wait = await tg(token, "sendMessage", { chat_id: chatId, text: "⏳ برسم الصورة... ثواني لدقيقتين." });
      try {
        const result = await createImage(prompt, settings);
        await sendImage(token, chatId, result, `🎨 ${prompt}`);
      } catch (err) {
        await tg(token, "sendMessage", { chat_id: chatId, text: `حصل خطأ: ${err.message}` });
      } finally {
        await tg(token, "deleteMessage", { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
      }
    }
  }

  (async function poll() {
    console.log("Telegram bot polling started.");
    for (;;) {
      try {
        const updates = await tg(token, "getUpdates", { offset, timeout: 30 });
        for (const up of updates) {
          offset = up.update_id + 1;
          if (up.message) handle(up.message).catch((e) => console.error("handle error:", e));
        }
      } catch (err) {
        console.error("polling error:", err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
