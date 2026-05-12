const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const conversations = {};

const SYSTEM_PROMPT = `You MUST always respond in Hebrew only.

אתה סוכן פיננסי אישי של מנחם שופל, מנהל קבוצת Czech-Israel.

מבנה החברות:
- Czech-Israel Holding s.r.o — חברת האם. בעלים: מנחם שופל ורון זבנר שי (50/50)
- Czech-Israel s.r.o — בת של ההולדינג. מחזיקה 50% בפרויקט קולין
- Rezidence Kolín s.r.o — פרויקט קולין: 70 דירות + 1,200 מ"ר מסחר. בנייה צפויה אוגוסט 2025, 2 שנות בנייה. משקיעים מקבלים 60% מהרווח של 50% שלנו
- CBRMY s.r.o — רוכשת את Edgon (2 בניינים, 30 דירות בכפר צ'רניצ'ה, מחוז קולין). יש משקיעים
- BESIATA s.r.o — מחזיקה מגרש בעיר קולין, הולכים להוציא היתרים ולבנות
- BEEZRATO s.r.o — עומדים לקנות 50% מפרויקט במלדה בולסוב
- Shemes s.r.o — תחת BEEZRATO
- EDGON a.s. — 2 בניינים בצ'רניצ'ה, נרכש על ידי CBRMY
- Osterhauer — חברה משותפת של מנחם ורוני

השקעות עד היום בפרויקט קולין:
- רכישת קרקע: 67.5 מיליון CZK (מנחם שילם ~50M, דוד שלף שילם ~17.5M)
- הוצאות נוספות: ~20 מיליון CZK (10M כל אחד)
- סה"כ הושקע: ~87.5M CZK (~3.5M €) בשער 24.68 CZK/€

תוכנית עסקית קולין:
- שטח דירות: 3,919 מ"ר, מחיר: 110,000 CZK/מ"ר
- שטח מסחרי: 1,199 מ"ר, מחיר: 65,000 CZK/מ"ר
- עלות בנייה: 60,000 CZK/מ"ר
- ליווי בנקאי: 6% מעלויות בנייה

תפקידך:
1. לענות על שאלות פיננסיות על החברות
2. לנתח מסמכים שמנחם שולח (דפי בנק, חשבוניות, דוחות)
3. לעקוב אחרי תזרים מזומנים
4. להתריע על בעיות
5. לחשב רווחים, עלויות, וחלוקות למשקיעים

כשמנחם שולח קובץ או מספרים, נתח אותם ותן תמונה ברורה.
היה ידידותי, מקצועי, וממוקד. ענה תמיד בעברית.`;

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  bot.sendMessage(chatId, 
    `שלום מנחם! 👋\n\nאני הסוכן הפיננסי של קבוצת Czech-Israel 🏢\n\nאני מכיר את כל החברות שלך ויכול לעזור לך עם:\n💰 תזרים מזומנים\n📊 ניתוח מסמכים\n🏗️ מעקב פרויקטים\n👥 חלוקות למשקיעים\n\nמה תרצה לדעת?`
  );
});

bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  bot.sendMessage(chatId, "השיחה אופסה! במה אוכל לעזור?");
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `📊 *סטטוס קבוצת Czech-Israel*\n\n` +
    `🏗️ *פרויקט קולין:*\n` +
    `• 70 דירות + 1,200 מ"ר מסחר\n` +
    `• השקעה עד היום: ~87.5M CZK\n` +
    `• בנייה צפויה: אוגוסט 2025\n\n` +
    `🏘️ *EDGON (צ'רניצ'ה):*\n` +
    `• 30 דירות ב-2 בניינים\n` +
    `• בתהליך רכישה\n\n` +
    `📍 *BESIATA:*\n` +
    `• מגרש קולין — בתהליך היתרים\n\n` +
    `🔄 *BEEZRATO:*\n` +
    `• פרויקט מלדה בולסוב — בתהליך`,
    { parse_mode: "Markdown" }
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: text });
  bot.sendChatAction(chatId, "typing");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;
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
