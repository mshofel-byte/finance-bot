const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const XLSX = require("xlsx");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const { Pool } = require("pg");
const path = require("path");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let botUsername = null;
const conversations = {};

const activeSessions = {};
const SESSION_DURATION = 10 * 60 * 1000;

bot.getMe().then((me) => {
  botUsername = me.username;
  console.log(`🤖 הבוט מחובר: @${botUsername}`);
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_memory (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      sender_name TEXT,
      chat_type TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("✅ מסד נתונים מוכן");
}
initDB();

async function saveToSharedMemory(content, senderName, chatType) {
  await pool.query(
    "INSERT INTO shared_memory (content, sender_name, chat_type) VALUES ($1, $2, $3)",
    [content, senderName, chatType]
  );
}

async function getSharedMemory() {
  const result = await pool.query(
    "SELECT sender_name, content, created_at FROM shared_memory ORDER BY created_at DESC LIMIT 100"
  );
  if (result.rows.length === 0) return "";
  const lines = result.rows.reverse().map((r) => {
    const time = new Date(r.created_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
    return `[${time}] ${r.sender_name}: ${r.content}`;
  });
  return `\n\n--- זיכרון משותף ---\n${lines.join("\n")}\n--- סוף זיכרון ---\n`;
}

const SYSTEM_PROMPT = `You MUST always respond in Hebrew only.

אתה סוכן פיננסי אישי של מנחם שופל, מנהל קבוצת Czech-Israel.

מבנה החברות:
- Czech-Israel Holding s.r.o — חברת האם. בעלים: מנחם שופל ורון זבנר שי (50/50)
- Czech-Israel s.r.o — מחזיקה 50% בפרויקט קולין
- Rezidence Kolín s.r.o — 70 דירות + 1,200 מ"ר מסחר. בנייה צפויה אוגוסט 2025
- CBRMY s.r.o — רוכשת ומוזגת את EDGON (30 דירות בצ'רניצ'ה)
- BESIATA s.r.o — מגרש בקולין
- BEEZRATO s.r.o — פרויקט מלדה בולסוב
- Osterhauer — חברה משותפת מנחם ורוני

יש לך גישה לזיכרון משותף — כל מה שנאמר בכל צ'אט שמור שם.
השתמש בו כדי לענות בצורה מדויקת ומועילה.
ענה תמיד בעברית. היה מקצועי וממוקד.`;

const PERSISTENT_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["🏗️ Rezidence Kolín", "🏘️ CBRMY"],
      ["🌳 BESIATA", "🏙️ BEEZRATO"],
      ["🤝 Osterhauer", "🏛️ Czech-Israel Holding"],
      ["📋 תפריט"],
    ],
    resize_keyboard: true,
    persistent: true,
  },
};

function getCompanyMenu(companyKey) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 סטטוס", callback_data: `${companyKey}_status` },
          { text: "💰 פיננסי", callback_data: `${companyKey}_finance` },
        ],
        [
          { text: "📅 לוח זמנים", callback_data: `${companyKey}_timeline` },
          { text: "👥 אנשי קשר", callback_data: `${companyKey}_contacts` },
        ],
        [{ text: "🔙 חזרה", callback_data: "main_menu" }],
      ],
    },
  };
}

const INLINE_MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🏗️ Rezidence Kolín", callback_data: "company_kolin" },
        { text: "🏘️ CBRMY", callback_data: "company_cbrmy" },
      ],
      [
        { text: "🌳 BESIATA", callback_data: "company_besiata" },
        { text: "🏙️ BEEZRATO", callback_data: "company_beezrato" },
      ],
      [
        { text: "🤝 Osterhauer", callback_data: "company_osterhauer" },
        { text: "🏛️ Czech-Israel Holding", callback_data: "company_holding" },
      ],
    ],
  },
};

const COMPANY_INFO = {
  company_kolin: { name: "Rezidence Kolín", info: "🏗️ Rezidence Kolín s.r.o\n\n70 דירות + 1,200 מ\"ר מסחר\nבנייה צפויה: אוגוסט 2025\nCzech-Israel מחזיקה 50%" },
  company_cbrmy: { name: "CBRMY", info: "🏘️ CBRMY s.r.o\n\nרוכשת ומוזגת את EDGON\n30 דירות בצ'רניצ'ה" },
  company_besiata: { name: "BESIATA", info: "🌳 BESIATA s.r.o\n\nמגרש בקולין" },
  company_beezrato: { name: "BEEZRATO", info: "🏙️ BEEZRATO s.r.o\n\nפרויקט מלדה בולסוב" },
  company_osterhauer: { name: "Osterhauer", info: "🤝 Osterhauer\n\nחברה משותפת מנחם ורוני" },
  company_holding: { name: "Czech-Israel Holding", info: "🏛️ Czech-Israel Holding s.r.o\n\nחברת האם\nבעלים: מנחם שופל ורון זבנר שי (50/50)" },
};

const KEYBOARD_TO_COMPANY = {
  "🏗️ Rezidence Kolín": "company_kolin",
  "🏘️ CBRMY": "company_cbrmy",
  "🌳 BESIATA": "company_besiata",
  "🏙️ BEEZRATO": "company_beezrato",
  "🤝 Osterhauer": "company_osterhauer",
  "🏛️ Czech-Israel Holding": "company_holding",
};

function isSessionActive(chatId) {
  const expiry = activeSessions[chatId];
  if (!expiry) return false;
  if (Date.now() > expiry) {
    delete activeSessions[chatId];
    return false;
  }
  return true;
}

function activateSession(chatId) {
  activeSessions[chatId] = Date.now() + SESSION_DURATION;
}

function shouldRespond(msg) {
  if (msg.chat.type === "private") return true;

  const text = msg.text || msg.caption || "";
  const mentionedBot = botUsername && (
    text.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ||
    text.includes("קלוד")
  );
  const replyToBot = msg.reply_to_message?.from?.username === botUsername;

  if (mentionedBot || replyToBot) {
    activateSession(msg.chat.id);
    return true;
  }

  if (isSessionActive(msg.chat.id)) {
    activateSession(msg.chat.id);
    return true;
  }

  return false;
}

function cleanText(text) {
  return (text || "").replace(/@\S+/g, "").trim();
}

function getSenderName(msg) {
  return `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() || "משתמש";
}

async function downloadFile(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const response = await axios.get(fileLink, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

async function extractText(fileId, fileName, mimeType) {
  const buffer = await downloadFile(fileId);
  const ext = path.extname(fileName || "").toLowerCase();

  if (ext === ".xlsx" || ext === ".xls" || mimeType?.includes("spreadsheet") || mimeType?.includes("excel")) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    let text = "";
    workbook.SheetNames.forEach((sheet) => {
      text += `\nגיליון: ${sheet}\n`;
      text += XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
    });
    return text;
  }
  if (ext === ".csv") return buffer.toString("utf-8");
  if (ext === ".pdf" || mimeType?.includes("pdf")) {
    const data = await pdf(buffer);
    return data.text;
  }
  if (ext === ".docx" || mimeType?.includes("wordprocessingml")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === ".txt") return buffer.toString("utf-8");
  return null;
}

async function askClaude(chatId, prompt) {
  if (!conversations[chatId]) conversations[chatId] = [];
  const memory = await getSharedMemory();
  const userMessage = memory ? `${prompt}\n\n(${memory})` : prompt;

  conversations[chatId].push({ role: "user", content: userMessage });

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: conversations[chatId],
  });

  const reply = response.content[0].text;
  conversations[chatId].pop();
  conversations[chatId].push({ role: "user", content: prompt });
  conversations[chatId].push({ role: "assistant", content: reply });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  return reply;
}

bot.onText(/\/start/, (msg) => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,
    "שלום מנחם! אני הסוכן הפיננסי של Czech-Israel 🏢\n\nבקבוצה — כתוב 'קלוד' או תייג אותי פעם אחת ואני אענה לכל השיחה למשך 10 דקות.\n\nבחר חברה מהתפריט או שאל אותי כל שאלה.",
    PERSISTENT_KEYBOARD
  );
});

bot.onText(/\/תפריט|\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, "בחר חברה:", INLINE_MAIN_MENU);
});

bot.on("document", async (msg) => {
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (isGroup && !shouldRespond(msg)) {
    const senderName = getSenderName(msg);
    const caption = msg.caption || "";
    try {
      await saveToSharedMemory(`[קובץ] ${msg.document.file_name} ${caption ? `- ${caption}` : ""}`, senderName, msg.chat.type);
    } catch (err) {}
    return;
  }

  const doc = msg.document;
  const chatId = msg.chat.id;
  const caption = cleanText(msg.caption || "");
  const senderName = getSenderName(msg);

  bot.sendChatAction(chatId, "typing");
  try {
    const text = await extractText(doc.file_id, doc.file_name, doc.mime_type);
    if (text) {
      const summary = `קובץ "${doc.file_name}" נשלח ע"י ${senderName}:\n${text.slice(0, 500)}`;
      await saveToSharedMemory(summary, senderName, msg.chat.type);
      const prompt = caption
        ? `${caption}\n\nתוכן הקובץ "${doc.file_name}":\n${text.slice(0, 8000)}`
        : `נתח את הקובץ "${doc.file_name}":\n${text.slice(0, 8000)}`;
      const reply = await askClaude(chatId, prompt);
      bot.sendMessage(chatId, reply);
    } else {
      bot.sendMessage(chatId, "סוג קובץ זה לא נתמך. נסה Excel, PDF, Word או CSV.");
    }
  } catch (err) {
    console.error("File error:", err.message);
    bot.sendMessage(chatId, "אופס, לא הצלחתי לקרוא את הקובץ 🙏");
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "main_menu") {
    bot.editMessageText("בחר חברה:", { chat_id: chatId, message_id: query.message.message_id, ...INLINE_MAIN_MENU });
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (COMPANY_INFO[data]) {
    bot.editMessageText(COMPANY_INFO[data].info, { chat_id: chatId, message_id: query.message.message_id, ...getCompanyMenu(data) });
    bot.answerCallbackQuery(query.id);
    return;
  }

  const parts = data.split("_");
  const action = parts[parts.length - 1];
  const companyKey = parts.slice(0, -1).join("_");
  const companyName = COMPANY_INFO[companyKey]?.name || companyKey;
  const actionMap = { status: "סטטוס עדכני", finance: "מצב פיננסי", timeline: "לוח זמנים", contacts: "אנשי קשר" };
  const prompt = `תן לי ${actionMap[action] || action} על ${companyName}`;

  bot.answerCallbackQuery(query.id, { text: "מחפש מידע..." });
  bot.sendChatAction(chatId, "typing");
  try {
    const reply = await askClaude(chatId, prompt);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    bot.sendMessage(chatId, "אופס, נתקלתי בבעיה. נסה שוב 🙏");
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const senderName = getSenderName(msg);
  const chatType = msg.chat.type;

  try {
    await saveToSharedMemory(text, senderName, chatType);
  } catch (err) {
    console.error("Memory error:", err.message);
  }

  if (KEYBOARD_TO_COMPANY[text]) {
    bot.sendMessage(chatId, COMPANY_INFO[KEYBOARD_TO_COMPANY[text]].info, getCompanyMenu(KEYBOARD_TO_COMPANY[text]));
    return;
  }

  if (text === "📋 תפריט") {
    bot.sendMessage(chatId, "בחר חברה:", INLINE_MAIN_MENU);
    return;
  }

  if (!shouldRespond(msg)) return;

  const cleanedText = cleanText(text);
  if (!cleanedText) return;

  bot.sendChatAction(chatId, "typing");
  try {
    const reply = await askClaude(chatId, cleanedText);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "אופס, נתקלתי בבעיה. נסה שוב 🙏");
  }
});

console.log("🏢 סוכן פיננסי Czech-Israel פועל!");
