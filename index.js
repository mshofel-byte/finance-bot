const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let botUsername = null;
const groupMemory = {};
const conversations = {};

bot.getMe().then((me) => {
  botUsername = me.username;
  console.log(`🤖 הבוט מחובר: @${botUsername}`);
});

const SYSTEM_PROMPT = `You MUST always respond in Hebrew only.

אתה סוכן פיננסי אישי של מנחם שופל, מנהל קבוצת Czech-Israel.

מבנה החברות:
- Czech-Israel Holding s.r.o — חברת האם. בעלים: מנחם שופל ורון זבנר שי (50/50)
- Czech-Israel s.r.o — מחזיקה 50% בפרויקט קולין
- Rezidence Kolín s.r.o — 70 דירות + 1,200 מ"ר מסחר. בנייה צפויה אוגוסט 2025
- CBRMY s.r.o — רוכשת את Edgon (30 דירות בצ'רניצ'ה)
- BESIATA s.r.o — מגרש בקולין
- BEEZRATO s.r.o — פרויקט מלדה בולסוב
- EDGON a.s. — 2 בניינים בצ'רניצ'ה
- Osterhauer — חברה משותפת מנחם ורוני

אתה מקשיב לכל השיחות בקבוצה ושומר את המידע בזיכרון.
כשפונים אליך, השתמש בכל מה ששמעת כדי לענות בצורה מדויקת ומועילה.
ענה תמיד בעברית. היה מקצועי וממוקד.`;

function saveToMemory(chatId, senderName, text) {
  if (!groupMemory[chatId]) groupMemory[chatId] = [];
  const timestamp = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
  groupMemory[chatId].push(`[${timestamp}] ${senderName}: ${text}`);
  if (groupMemory[chatId].length > 200) {
    groupMemory[chatId] = groupMemory[chatId].slice(-200);
  }
}

function buildContext(chatId) {
  if (!groupMemory[chatId] || groupMemory[chatId].length === 0) return "";
  const recent = groupMemory[chatId].slice(-50);
  return `\n\n--- היסטוריית השיחה בקבוצה ---\n${recent.join("\n")}\n--- סוף היסטוריה ---\n`;
}

function shouldRespond(msg) {
  if (msg.chat.type === "private") return true;
  const mentionedBot = botUsername && msg.text && msg.text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
  const replyToBot = msg.reply_to_message?.from?.username === botUsername;
  return mentionedBot || replyToBot;
}

function cleanText(text) {
  if (!text) return "";
  return text.replace(/@\S+/g, "").trim();
}

function getSenderName(msg) {
  const first = msg.from?.first_name || "";
  const last = msg.from?.last_name || "";
  return `${first} ${last}`.trim() || "משתמש";
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  bot.sendMessage(chatId, "שלום מנחם! אני הסוכן הפיננסי של Czech-Israel 🏢\nאני מקשיב לכל השיחות ואענה כשתפנה אליי.\nבמה אוכל לעזור?");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const senderName = getSenderName(msg);
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (isGroup) saveToMemory(chatId, senderName, text);
  if (!shouldRespond(msg)) return;

  const cleanedText = cleanText(text);
  if (!cleanedText) return;

  if (!conversations[chatId]) conversations[chatId] = [];

  const context = buildContext(chatId);
  const userMessage = context ? `${cleanedText}\n\n(הקשר: ${context})` : cleanedText;

  conversations[chatId].push({ role: "user", content: userMessage });
  bot.sendChatAction(chatId, "typing");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;
    conversations[chatId].pop();
    conversations[chatId].push({ role: "user", content: cleanedText });
    conversations[chatId].push({ role: "assistant", content: reply });

    if (conversations[chatId].length > 20) {
      conversations[chatId] = conversations[chatId].slice(-20);
    }

    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "אופס, נתקלתי בבעיה. נסה שוב 🙏");
  }
});

console.log("🏢 סוכן פיננסי Czech-Israel פועל!");
