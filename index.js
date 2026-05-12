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

const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🏗️ Rezidence Kolín", callback_data: "company_kolin" },
        { text: "🏢 EDGON", callback_data: "company_edgon" },
      ],
      [
        { text: "🏘️ CBRMY", callback_data: "company_cbrmy" },
        { text: "🌳 BESIATA", callback_data: "company_besiata" },
      ],
      [
        { text: "🏙️ BEEZRATO", callback_data: "company_beezrato" },
        { text: "🤝 Osterhauer", callback_data: "company_osterhauer" },
      ],
      [
        { text: "🏛️ Czech-Israel Holding", callback_data: "company_holding" },
      ],
    ],
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
        [{ text: "🔙 חזרה לתפריט", callback_data: "main_menu" }],
      ],
    },
  };
}

const COMPANY_INFO = {
  company_kolin: {
    name: "Rezidence Kolín",
    info: "🏗️ Rezidence Kolín s.r.o\n\n70 דירות + 1,200 מ\"ר מסחר\nבנייה צפויה: אוגוסט 2025\nCzech-Israel מחזיקה 50%",
  },
  company_edgon: {
    name: "EDGON",
    info: "🏢 EDGON a.s\n\n2 בניינים בצ'רניצ'ה\nנרכשת ע\"י CBRMY s.r.o",
  },
  company_cbrmy: {
    name: "CBRMY",
    info: "🏘️ CBRMY s.r.o\n\nרוכשת את EDGON\n30 דירות בצ'רניצ'ה",
  },
  company_besiata: {
    name: "BESIATA",
    info: "🌳 BESIATA s.r.o\n\nמגרש בקולין",
  },
  company_beezrato: {
    name: "BEEZRATO",
    info: "🏙️ BEEZRATO s.r.o\n\nפרויקט מלדה בולסוב",
  },
  company_osterhauer: {
    name: "Osterhauer",
    info: "🤝 Osterhauer\n\nחברה משותפת מנחם ורוני",
  },
  company_holding: {
    name: "Czech-Israel Holding",
    info: "🏛️ Czech-Israel Holding s.r.o\n\nחברת האם\nבעלים: מנחם שופל ורון זבנר שי (50/50)",
  },
};

function saveToMemory(chatId, senderName, text) {
  if (!groupMemory[chatId]) groupMemory[chatId] = [];
  const timestamp = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
  groupMemory[chatId].push(`[${timestamp}] ${senderName}: ${text}`);
  if (groupMemory[chatId].length > 200) groupMemory[chatId] = groupMemory[chatId].slice(-200);
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
  return (text || "").replace(/@\S+/g, "").trim();
}

function getSenderName(msg) {
  return `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() || "משתמש";
}

bot.onText(/\/start/, (msg) => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, "שלום מנחם! אני הסוכן הפיננסי של Czech-Israel 🏢\nאני מקשיב לכל השיחות ואענה כשתפנה אליי.\n\nבמה אוכל לעזור?", MAIN_MENU);
});

bot.onText(/\/תפריט|\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, "בחר חברה:", MAIN_MENU);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "main_menu") {
    bot.editMessageText("בחר חברה:", {
      chat_id: chatId,
      message_id: query.message.message_id,
      ...MAIN_MENU,
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (COMPANY_INFO[data]) {
    const company = COMPANY_INFO[data];
    bot.editMessageText(company.info, {
      chat_id: chatId,
      message_id: query.message.message_id,
      ...getCompanyMenu(data),
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  const parts = data.split("_");
  const action = parts[parts.length - 1];
  const companyKey = parts.slice(0, -1).join("_");
  const companyName = COMPANY_INFO[companyKey]?.name || companyKey;

  const actionMap = {
    status: "סטטוס עדכני",
    finance: "מצב פיננסי",
    timeline: "לוח זמנים",
    contacts: "אנשי קשר",
  };

  const actionText = actionMap[action] || action;
  const prompt = `תן לי ${actionText} על ${companyName}`;

  bot.answerCallbackQuery(query.id, { text: "מחפש מידע..." });
  bot.sendChatAction(chatId, "typing");

  if (!conversations[chatId]) conversations[chatId] = [];
  const context = buildContext(chatId);
  const userMessage = context ? `${prompt}\n\n(הקשר: ${context})` : prompt;
  conversations[chatId].push({ role: "user", content: userMessage });

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;
    conversations[chatId].pop();
    conversations[chatId].push({ role: "user", content: prompt });
    conversations[chatId].push({ role: "assistant", content: reply });
    if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);

    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "אופס, נתקלתי בבעיה. נסה שוב 🙏");
  }
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
    if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);

    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "אופס, נתקלתי בבעיה. נסה שוב 🙏");
  }
});

console.log("🏢 סוכן פיננסי Czech-Israel פועל!");
