const TelegramBot = require(“node-telegram-bot-api”);
const Anthropic = require(”@anthropic-ai/sdk”);
const axios = require(“axios”);
const XLSX = require(“xlsx”);
const pdf = require(“pdf-parse”);
const mammoth = require(“mammoth”);
const { Pool } = require(“pg”);
const path = require(“path”);

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
const userState = {}; // מצב המתנה להזנת נתונים
const SESSION_DURATION = 10 * 60 * 1000;

bot.getMe().then((me) => {
botUsername = me.username;
console.log(`🤖 הבוט מחובר: @${botUsername}`);
});

async function initDB() {
await pool.query(`CREATE TABLE IF NOT EXISTS shared_memory ( id SERIAL PRIMARY KEY, content TEXT NOT NULL, sender_name TEXT, chat_type TEXT, created_at TIMESTAMP DEFAULT NOW() )`);
await pool.query(`CREATE TABLE IF NOT EXISTS cashflow ( id SERIAL PRIMARY KEY, company TEXT NOT NULL, type TEXT NOT NULL, amount NUMERIC NOT NULL, description TEXT, entry_date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMP DEFAULT NOW() )`);
console.log(“✅ מסד נתונים מוכן”);
}
initDB();

async function saveToSharedMemory(content, senderName, chatType) {
await pool.query(
“INSERT INTO shared_memory (content, sender_name, chat_type) VALUES ($1, $2, $3)”,
[content, senderName, chatType]
);
}

async function getSharedMemory() {
const result = await pool.query(
“SELECT sender_name, content, created_at FROM shared_memory ORDER BY created_at DESC LIMIT 100”
);
if (result.rows.length === 0) return “”;
const lines = result.rows.reverse().map((r) => {
const time = new Date(r.created_at).toLocaleString(“he-IL”, { timeZone: “Asia/Jerusalem” });
return `[${time}] ${r.sender_name}: ${r.content}`;
});
return `\n\n--- זיכרון משותף ---\n${lines.join("\n")}\n--- סוף זיכרון ---\n`;
}

async function saveCashflow(company, type, amount, description, date) {
await pool.query(
“INSERT INTO cashflow (company, type, amount, description, entry_date) VALUES ($1, $2, $3, $4, $5)”,
[company, type, amount, description, date || new Date()]
);
}

async function getCashflowReport(company, period) {
let dateFilter = “”;
const now = new Date();

if (period === “monthly”) {
dateFilter = `AND DATE_TRUNC('month', entry_date) = DATE_TRUNC('month', CURRENT_DATE)`;
} else if (period === “quarterly”) {
dateFilter = `AND DATE_TRUNC('quarter', entry_date) = DATE_TRUNC('quarter', CURRENT_DATE)`;
} else if (period === “yearly”) {
dateFilter = `AND DATE_TRUNC('year', entry_date) = DATE_TRUNC('year', CURRENT_DATE)`;
}

const companyFilter = company !== “all” ? `AND company = '${company}'` : “”;

const result = await pool.query(`SELECT type, SUM(amount) as total, COUNT(*) as count FROM cashflow WHERE 1=1 ${companyFilter} ${dateFilter} GROUP BY type`);

const rows = result.rows;
const get = (type) => parseFloat(rows.find((r) => r.type === type)?.total || 0);

const incomeExpected = get(“income_expected”);
const expenseExpected = get(“expense_expected”);
const incomeActual = get(“income_actual”);
const expenseActual = get(“expense_actual”);

const balanceExpected = incomeExpected - expenseExpected;
const balanceActual = incomeActual - expenseActual;

return { incomeExpected, expenseExpected, incomeActual, expenseActual, balanceExpected, balanceActual };
}

async function getDetailedCashflow(company, period) {
let dateFilter = “”;
if (period === “monthly”) dateFilter = `AND DATE_TRUNC('month', entry_date) = DATE_TRUNC('month', CURRENT_DATE)`;
else if (period === “quarterly”) dateFilter = `AND DATE_TRUNC('quarter', entry_date) = DATE_TRUNC('quarter', CURRENT_DATE)`;
else if (period === “yearly”) dateFilter = `AND DATE_TRUNC('year', entry_date) = DATE_TRUNC('year', CURRENT_DATE)`;

const companyFilter = company !== “all” ? `AND company = '${company}'` : “”;

const result = await pool.query(`SELECT company, type, amount, description, entry_date FROM cashflow WHERE 1=1 ${companyFilter} ${dateFilter} ORDER BY entry_date DESC LIMIT 50`);
return result.rows;
}

const SYSTEM_PROMPT = `You MUST always respond in Hebrew only.

אתה סוכן פיננסי אישי של מנחם שופל, מנהל קבוצת Czech-Israel.

מבנה החברות:

- צ’כיה ישראל הולדינג s.r.o — חברת האם. בעלים: מנחם שופל ורון זבנר שי (50/50)
- Czech-Israel s.r.o — מחזיקה 50% בפרויקט קולין
- צ’כיה ישראל קולין s.r.o — 70 דירות + 1,200 מ”ר מסחר. בנייה צפויה אוגוסט 2025
- CBRMY s.r.o — רוכשת ומוזגת את EDGON (30 דירות בצ’רניצ’ה)
- BESIATA s.r.o — מגרש בקולין
- BEEZRATO s.r.o — פרויקט מלדה בולסוב

יש לך גישה לזיכרון משותף וגם לנתוני תזרים מזומנים של כל חברה.
השתמש בכל המידע כדי לענות בצורה מדויקת ומועילה.
ענה תמיד בעברית. היה מקצועי וממוקד.

כשמזהים הזנת תזרים טבעית (למשל “נכנסו 50,000 מקולין”), חלץ:

- חברה
- סוג (הכנסה/הוצאה, צפויה/בפועל)
- סכום
- תיאור`;

const COMPANIES = {
company_kolin: “צ’כיה ישראל קולין”,
company_cbrmy: “CBRMY”,
company_besiata: “BESIATA”,
company_beezrato: “BEEZRATO”,
company_holding: “צ’כיה ישראל הולדינג”,
};

const PERSISTENT_KEYBOARD = {
reply_markup: {
keyboard: [
[“🏗️ צ’כיה ישראל קולין”, “🏘️ CBRMY”],
[“🌳 BESIATA”, “🏙️ BEEZRATO”],
[“🏛️ צ’כיה ישראל הולדינג”],
[“💼 תזרים מרוכז”, “📋 תפריט”],
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
{ text: “📊 סטטוס”, callback_data: `${companyKey}_status` },
{ text: “💰 פיננסי”, callback_data: `${companyKey}_finance` },
],
[
{ text: “📅 לוח זמנים”, callback_data: `${companyKey}_timeline` },
{ text: “👥 אנשי קשר”, callback_data: `${companyKey}_contacts` },
],
[{ text: “💵 תזרים”, callback_data: `${companyKey}_cashflow` }],
[{ text: “🔙 חזרה”, callback_data: “main_menu” }],
],
},
};
}

function getCashflowMenu(companyKey) {
return {
reply_markup: {
inline_keyboard: [
[
{ text: “➕ הכנסה צפויה”, callback_data: `cf_${companyKey}_income_expected` },
{ text: “➖ הוצאה צפויה”, callback_data: `cf_${companyKey}_expense_expected` },
],
[
{ text: “✅ נכנס בפועל”, callback_data: `cf_${companyKey}_income_actual` },
{ text: “❌ יצא בפועל”, callback_data: `cf_${companyKey}_expense_actual` },
],
[
{ text: “📈 דוח חודשי”, callback_data: `rpt_${companyKey}_monthly` },
{ text: “📊 דוח רבעוני”, callback_data: `rpt_${companyKey}_quarterly` },
],
[{ text: “📅 דוח שנתי”, callback_data: `rpt_${companyKey}_yearly` }],
[{ text: “🔙 חזרה”, callback_data: companyKey }],
],
},
};
}

function getMergedCashflowMenu() {
return {
reply_markup: {
inline_keyboard: [
[
{ text: “📈 דוח חודשי”, callback_data: “rpt_all_monthly” },
{ text: “📊 דוח רבעוני”, callback_data: “rpt_all_quarterly” },
],
[{ text: “📅 דוח שנתי”, callback_data: “rpt_all_yearly” }],
[{ text: “🔙 חזרה”, callback_data: “main_menu” }],
],
},
};
}

const INLINE_MAIN_MENU = {
reply_markup: {
inline_keyboard: [
[
{ text: “🏗️ צ’כיה ישראל קולין”, callback_data: “company_kolin” },
{ text: “🏘️ CBRMY”, callback_data: “company_cbrmy” },
],
[
{ text: “🌳 BESIATA”, callback_data: “company_besiata” },
{ text: “🏙️ BEEZRATO”, callback_data: “company_beezrato” },
],
[{ text: “🏛️ צ’כיה ישראל הולדינג”, callback_data: “company_holding” }],
[{ text: “💼 תזרים מרוכז”, callback_data: “cashflow_all” }],
],
},
};

const COMPANY_INFO = {
company_kolin: { name: “צ’כיה ישראל קולין”, info: “🏗️ צ’כיה ישראל קולין s.r.o\n\n70 דירות + 1,200 מ"ר מסחר\nבנייה צפויה: אוגוסט 2025\nCzech-Israel מחזיקה 50%” },
company_cbrmy: { name: “CBRMY”, info: “🏘️ CBRMY s.r.o\n\nרוכשת ומוזגת את EDGON\n30 דירות בצ’רניצ’ה” },
company_besiata: { name: “BESIATA”, info: “🌳 BESIATA s.r.o\n\nמגרש בקולין” },
company_beezrato: { name: “BEEZRATO”, info: “🏙️ BEEZRATO s.r.o\n\nפרויקט מלדה בולסוב” },
company_holding: { name: “צ’כיה ישראל הולדינג”, info: “🏛️ צ’כיה ישראל הולדינג s.r.o\n\nחברת האם\nבעלים: מנחם שופל ורון זבנר שי (50/50)” },
};

const KEYBOARD_TO_COMPANY = {
“🏗️ צ’כיה ישראל קולין”: “company_kolin”,
“🏘️ CBRMY”: “company_cbrmy”,
“🌳 BESIATA”: “company_besiata”,
“🏙️ BEEZRATO”: “company_beezrato”,
“🏛️ צ’כיה ישראל הולדינג”: “company_holding”,
};

const TYPE_LABELS = {
income_expected: “הכנסה צפויה”,
expense_expected: “הוצאה צפויה”,
income_actual: “הכנסה בפועל”,
expense_actual: “הוצאה בפועל”,
};

const PERIOD_LABELS = {
monthly: “חודשי”,
quarterly: “רבעוני”,
yearly: “שנתי”,
};

function formatAmount(n) {
return “₪” + Number(n).toLocaleString(“he-IL”);
}

async function buildReport(company, period, chatId) {
const r = await getCashflowReport(company, period);
const companyName = company === “all” ? “כל החברות” : COMPANIES[company] || company;
const periodLabel = PERIOD_LABELS[period];

let msg = `📊 *דוח תזרים ${periodLabel} — ${companyName}*\n\n`;
msg += `*צפוי:*\n`;
msg += `➕ הכנסות: ${formatAmount(r.incomeExpected)}\n`;
msg += `➖ הוצאות: ${formatAmount(r.expenseExpected)}\n`;
msg += `💰 מאזן צפוי: ${formatAmount(r.balanceExpected)}\n\n`;
msg += `*בפועל:*\n`;
msg += `✅ נכנס: ${formatAmount(r.incomeActual)}\n`;
msg += `❌ יצא: ${formatAmount(r.expenseActual)}\n`;
msg += `💵 מאזן בפועל: ${formatAmount(r.balanceActual)}`;

return msg;
}

function isSessionActive(chatId) {
const expiry = activeSessions[chatId];
if (!expiry) return false;
if (Date.now() > expiry) { delete activeSessions[chatId]; return false; }
return true;
}

function activateSession(chatId) {
activeSessions[chatId] = Date.now() + SESSION_DURATION;
}

function shouldRespond(msg) {
if (msg.chat.type === “private”) return true;
const text = msg.text || msg.caption || “”;
const mentionedBot = botUsername && (
text.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ||
text.includes(“קלוד”)
);
const replyToBot = msg.reply_to_message?.from?.username === botUsername;
if (mentionedBot || replyToBot) { activateSession(msg.chat.id); return true; }
if (isSessionActive(msg.chat.id)) { activateSession(msg.chat.id); return true; }
return false;
}

function cleanText(text) {
return (text || “”).replace(/@\S+/g, “”).trim();
}

function getSenderName(msg) {
return `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() || “משתמש”;
}

async function downloadFile(fileId) {
const fileLink = await bot.getFileLink(fileId);
const response = await axios.get(fileLink, { responseType: “arraybuffer” });
return Buffer.from(response.data);
}

async function extractText(fileId, fileName, mimeType) {
const buffer = await downloadFile(fileId);
const ext = path.extname(fileName || “”).toLowerCase();
if (ext === “.xlsx” || ext === “.xls” || mimeType?.includes(“spreadsheet”) || mimeType?.includes(“excel”)) {
const workbook = XLSX.read(buffer, { type: “buffer” });
let text = “”;
workbook.SheetNames.forEach((sheet) => {
text += `\nגיליון: ${sheet}\n`;
text += XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
});
return text;
}
if (ext === “.csv”) return buffer.toString(“utf-8”);
if (ext === “.pdf” || mimeType?.includes(“pdf”)) { const data = await pdf(buffer); return data.text; }
if (ext === “.docx” || mimeType?.includes(“wordprocessingml”)) { const result = await mammoth.extractRawText({ buffer }); return result.value; }
if (ext === “.txt”) return buffer.toString(“utf-8”);
return null;
}

async function askClaude(chatId, prompt) {
if (!conversations[chatId]) conversations[chatId] = [];
const memory = await getSharedMemory();
const userMessage = memory ? `${prompt}\n\n(${memory})` : prompt;
conversations[chatId].push({ role: “user”, content: userMessage });
const response = await anthropic.messages.create({
model: “claude-haiku-4-5-20251001”,
max_tokens: 2000,
system: SYSTEM_PROMPT,
messages: conversations[chatId],
});
const reply = response.content[0].text;
conversations[chatId].pop();
conversations[chatId].push({ role: “user”, content: prompt });
conversations[chatId].push({ role: “assistant”, content: reply });
if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
return reply;
}

// זיהוי הזנת תזרים טבעית
async function detectCashflowEntry(text) {
const prompt = `האם הטקסט הבא מכיל הזנת תזרים מזומנים? אם כן, חלץ את הפרטים.
טקסט: “${text}”

חברות אפשריות: צ’כיה ישראל קולין (company_kolin), CBRMY (company_cbrmy), BESIATA (company_besiata), BEEZRATO (company_beezrato), צ’כיה ישראל הולדינג (company_holding)
סוגים: income_expected, expense_expected, income_actual, expense_actual

ענה ONLY בJSON כך: {“is_cashflow”:true,“company”:“company_key”,“type”:“type”,“amount”:12345,“description”:“תיאור”}
או אם לא תזרים: {“is_cashflow”:false}`;

const response = await anthropic.messages.create({
model: “claude-haiku-4-5-20251001”,
max_tokens: 200,
messages: [{ role: “user”, content: prompt }],
});

try {
const json = JSON.parse(response.content[0].text.match(/{[\s\S]*}/)[0]);
return json;
} catch {
return { is_cashflow: false };
}
}

// — פקודות —
bot.onText(//start/, (msg) => {
conversations[msg.chat.id] = [];
bot.sendMessage(msg.chat.id,
“שלום מנחם! אני הסוכן הפיננסי של Czech-Israel 🏢\n\nאפשר לנהל תזרים לכל חברה בנפרד ולראות דוח מרוכז.\nפשוט כתוב בטבעי: ‘נכנסו 50,000 מקולין’ ואני אתעד!\n\nבקבוצה — כתוב ‘קלוד’ או תייג אותי.”,
PERSISTENT_KEYBOARD
);
});

bot.onText(//תפריט|/menu/, (msg) => {
bot.sendMessage(msg.chat.id, “בחר חברה:”, INLINE_MAIN_MENU);
});

// — קבלת קבצים —
bot.on(“document”, async (msg) => {
const isGroup = msg.chat.type === “group” || msg.chat.type === “supergroup”;
if (isGroup && !shouldRespond(msg)) {
const senderName = getSenderName(msg);
try { await saveToSharedMemory(`[קובץ] ${msg.document.file_name}`, senderName, msg.chat.type); } catch (err) {}
return;
}
const doc = msg.document;
const chatId = msg.chat.id;
const caption = cleanText(msg.caption || “”);
const senderName = getSenderName(msg);
bot.sendChatAction(chatId, “typing”);
try {
const text = await extractText(doc.file_id, doc.file_name, doc.mime_type);
if (text) {
await saveToSharedMemory(`קובץ "${doc.file_name}":\n${text.slice(0, 500)}`, senderName, msg.chat.type);
const prompt = caption ? `${caption}\n\nתוכן הקובץ "${doc.file_name}":\n${text.slice(0, 8000)}` : `נתח את הקובץ "${doc.file_name}":\n${text.slice(0, 8000)}`;
const reply = await askClaude(chatId, prompt);
bot.sendMessage(chatId, reply);
} else {
bot.sendMessage(chatId, “סוג קובץ זה לא נתמך. נסה Excel, PDF, Word או CSV.”);
}
} catch (err) {
bot.sendMessage(chatId, “אופס, לא הצלחתי לקרוא את הקובץ 🙏”);
}
});

// — כפתורי inline —
bot.on(“callback_query”, async (query) => {
const chatId = query.message.chat.id;
const data = query.data;

// תפריט ראשי
if (data === “main_menu”) {
bot.editMessageText(“בחר חברה:”, { chat_id: chatId, message_id: query.message.message_id, …INLINE_MAIN_MENU });
bot.answerCallbackQuery(query.id);
return;
}

// תזרים מרוכז
if (data === “cashflow_all”) {
bot.editMessageText(“💼 *תזרים מרוכז — כל החברות*\nבחר תקופה:”, {
chat_id: chatId, message_id: query.message.message_id, parse_mode: “Markdown”, …getMergedCashflowMenu()
});
bot.answerCallbackQuery(query.id);
return;
}

// תפריט חברה
if (COMPANY_INFO[data]) {
bot.editMessageText(COMPANY_INFO[data].info, { chat_id: chatId, message_id: query.message.message_id, …getCompanyMenu(data) });
bot.answerCallbackQuery(query.id);
return;
}

// תפריט תזרים לחברה
if (data.endsWith(”_cashflow”)) {
const companyKey = data.replace(”_cashflow”, “”);
const companyName = COMPANIES[companyKey] || companyKey;
bot.editMessageText(`💵 *תזרים — ${companyName}*\nבחר פעולה:`, {
chat_id: chatId, message_id: query.message.message_id, parse_mode: “Markdown”, …getCashflowMenu(companyKey)
});
bot.answerCallbackQuery(query.id);
return;
}

// הזנת תזרים דרך כפתור
if (data.startsWith(“cf_”)) {
const parts = data.split(”*”);
const type = parts[parts.length - 2] + “*” + parts[parts.length - 1];
const companyKey = parts.slice(1, -2).join(”_”);
const companyName = COMPANIES[companyKey] || companyKey;
const typeLabel = TYPE_LABELS[type];

```
userState[chatId] = { action: "cashflow_entry", companyKey, type, companyName, typeLabel };
bot.answerCallbackQuery(query.id);
bot.sendMessage(chatId, `הזן סכום ותיאור עבור *${typeLabel}* ב-*${companyName}*:\nלדוגמה: \`50000 תשלום קבלן\``, { parse_mode: "Markdown" });
return;
```

}

// דוחות
if (data.startsWith(“rpt_”)) {
const parts = data.split(”*”);
const period = parts[parts.length - 1];
const companyKey = parts.slice(1, -1).join(”*”);
bot.answerCallbackQuery(query.id, { text: “מכין דוח…” });
bot.sendChatAction(chatId, “typing”);
try {
const msg = await buildReport(companyKey, period, chatId);
bot.sendMessage(chatId, msg, { parse_mode: “Markdown” });
} catch (err) {
bot.sendMessage(chatId, “אופס, לא הצלחתי להכין דוח 🙏”);
}
return;
}

// תת-תפריט חברה
const parts = data.split(”*”);
const action = parts[parts.length - 1];
const companyKey = parts.slice(0, -1).join(”*”);
const companyName = COMPANY_INFO[companyKey]?.name || companyKey;
const actionMap = { status: “סטטוס עדכני”, finance: “מצב פיננסי”, timeline: “לוח זמנים”, contacts: “אנשי קשר” };
const prompt = `תן לי ${actionMap[action] || action} על ${companyName}`;
bot.answerCallbackQuery(query.id, { text: “מחפש מידע…” });
bot.sendChatAction(chatId, “typing”);
try {
const reply = await askClaude(chatId, prompt);
bot.sendMessage(chatId, reply);
} catch (err) {
bot.sendMessage(chatId, “אופס, נתקלתי בבעיה. נסה שוב 🙏”);
}
});

// — הודעות רגילות —
bot.on(“message”, async (msg) => {
const chatId = msg.chat.id;
const text = msg.text;
if (!text || text.startsWith(”/”)) return;

const senderName = getSenderName(msg);
const chatType = msg.chat.type;

try { await saveToSharedMemory(text, senderName, chatType); } catch (err) {}

// מצב המתנה להזנת תזרים
if (userState[chatId]?.action === “cashflow_entry”) {
const state = userState[chatId];
delete userState[chatId];

```
const match = text.match(/^(\d[\d,.]*)(.*)$/);
if (match) {
  const amount = parseFloat(match[1].replace(/,/g, ""));
  const description = match[2].trim() || state.typeLabel;
  try {
    await saveCashflow(state.companyKey, state.type, amount, description);
    bot.sendMessage(chatId, `✅ נשמר!\n*${state.typeLabel}* — *${formatAmount(amount)}*\n${description}\nחברה: ${state.companyName}`, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(chatId, "אופס, שגיאה בשמירה 🙏");
  }
} else {
  bot.sendMessage(chatId, "לא הבנתי את הסכום. נסה שוב, למשל: `50000 תשלום קבלן`", { parse_mode: "Markdown" });
}
return;
```

}

if (KEYBOARD_TO_COMPANY[text]) {
bot.sendMessage(chatId, COMPANY_INFO[KEYBOARD_TO_COMPANY[text]].info, getCompanyMenu(KEYBOARD_TO_COMPANY[text]));
return;
}

if (text === “📋 תפריט”) { bot.sendMessage(chatId, “בחר חברה:”, INLINE_MAIN_MENU); return; }
if (text === “💼 תזרים מרוכז”) {
bot.sendMessage(chatId, “💼 *תזרים מרוכז — כל החברות*\nבחר תקופה:”, { parse_mode: “Markdown”, …getMergedCashflowMenu() });
return;
}

if (!shouldRespond(msg)) return;

const cleanedText = cleanText(text);
if (!cleanedText) return;

// זיהוי הזנת תזרים טבעית
try {
const cf = await detectCashflowEntry(cleanedText);
if (cf.is_cashflow && cf.company && cf.type && cf.amount) {
await saveCashflow(cf.company, cf.type, cf.amount, cf.description || “”);
const companyName = COMPANIES[cf.company] || cf.company;
bot.sendMessage(chatId, `✅ תועד!\n*${TYPE_LABELS[cf.type]}* — *${formatAmount(cf.amount)}*\n${cf.description || ""}\nחברה: ${companyName}`, { parse_mode: “Markdown” });
return;
}
} catch (err) {}

bot.sendChatAction(chatId, “typing”);
try {
const reply = await askClaude(chatId, cleanedText);
bot.sendMessage(chatId, reply);
} catch (err) {
bot.sendMessage(chatId, “אופס, נתקלתי בבעיה. נסה שוב 🙏”);
}
});

console.log(“🏢 סוכן פיננסי Czech-Israel פועל!”);
