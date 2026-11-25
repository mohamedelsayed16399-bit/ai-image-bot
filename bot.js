// bot.js - entry point.
//   node bot.js            -> web UI on http://localhost:3000
//   TELEGRAM_TOKEN=... node bot.js  -> web UI + Telegram bot together
import { startServer } from "./server.js";
import { startTelegram } from "./telegram.js";

const port = Number(process.env.PORT) || 3000;
startServer(port);

if (process.env.TELEGRAM_TOKEN) {
  startTelegram(process.env.TELEGRAM_TOKEN);
} else {
  console.log("No TELEGRAM_TOKEN set - web UI only. (See README to enable the Telegram bot.)");
}
