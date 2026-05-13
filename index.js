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
const userState = {};
const SESSION_DURATION = 10 * 60 * 1000;

bot.getMe().then(function(me) {
botUsername = me.username;
console.log(“הבוט מחובר: @” + botUsername);
});

async function initDB() {
await pool.query(
“CREATE TABLE IF NOT EXISTS shared_memory (” +
“id SERIAL PRIMARY KEY,” +
“content TEXT NOT NULL,” +
“sender_name TEXT,” +
“chat_type TEXT,” +
“created_at TIMESTAMP DEFAULT NOW())”
);
await pool.query(
“CREATE TABLE IF NOT EXISTS cashflow (” +
“id SERIAL PRIMARY KEY,” +
“company TEXT NOT NULL,” +
“type TEXT NOT NULL,” +
“amount NUMERIC NOT NULL,” +
“description TEXT,” +
“entry_date DATE DEFAULT CURRENT_DATE,” +
“created_at TIMESTAMP DEFAULT NOW())”
);
console.log(“מסד נתונים מוכן”);
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
const lines = result.rows.reverse().map(function(r) {
const time = new Date(r.created_at).toLocaleString(“he-IL”, { timeZone: “Asia/Jerusalem” });
return “[” + time + “] “ + r.sender_name + “: “ + r.content;
});
return “\n\n— זיכרון משותף —\n” + lines.join(”\n”) + “\n— סוף זיכרון —\n”;
}

async function saveCashflow(company, type, amount, description) {
await pool.query(
“INSERT INTO cashflow (company, type, amount, description) VALUES ($1, $2, $3, $4)”,
[company, type, amount, description || “”]
);
}

async function getCashflowReport(company, period) {
let dateFilter = “”;
if (period === “monthly”) dateFilter = “ AND DATE_TRUNC(‘month’, entry_date) = DATE_TRUNC(‘month’, CURRENT_DATE)”;
else if (period === “quarterly”) dateFilter = “ AND DATE_TRUNC(‘quarter’, entry_date) = DATE_TRUNC(‘quarter’, CURRENT_DATE)”;
else if (period === “yearly”) dateFilter = “ AND DATE_TRUNC(‘year’, entry_date) = DATE_TRUNC(‘year’, CURRENT_DATE)”;

const companyFilter = company !== “all” ? “ AND company = ‘” + company + “’” : “”;
const query = “SELECT type, SUM(amount) as total FROM cashflow WHERE 1=1” + companyFilter + dateFilter + “ GROUP BY type”;
const result = await pool.query(query);
const rows = result.rows;
const get = function(type) { return parseFloat((rows.find(function(r) { return r.type === type; }) || {}).total || 0); };
return {
incomeExpected: get(“income_expected”),
expenseExpected: get(“expense_expected”),
incomeActual: get(“income_actual”),
expenseActual: get(“expense_actual”),
};
}

function formatAmount(n) {
return “₪” + Number(n).toLocaleString(“he-IL”);
}

async function buildReport(company, period) {
const r = await getCashflowReport(company, period);
const periodLabels = { monthly: “חודשי”, quarterly: “רבעוני”, yearly: “שנתי” };
const companyName = company === “all” ? “כל החברות” : (COMPANY_NAMES[company] || company);
return “דוח תזרים “ + periodLabels[period] + “ - “ + companyName + “\n\n” +
“צפוי:\n” +
“הכנסות: “ + formatAmount(r.incomeExpected) + “\n” +
“הוצאות: “ + formatAmount(r.expenseExpected) + “\n” +
“מאזן צפוי: “ + formatAmount(r.incomeExpected - r.expenseExpected) + “\n\n” +
“בפועל:\n” +
“נכנס: “ + formatAmount(r.incomeActual) + “\n” +
“יצא: “ + formatAmount(r.expenseActual) + “\n” +
“מאזן בפועל: “ + formatAmount(r.incomeActual - r.expenseActual);
}

const COMPANY_NAMES = {
company_kolin: “Czech Israel קולין”,
company_cbrmy: “CBRMY”,
company_besiata: “BESIATA”,
company_beezrato: “BEEZRATO”,
company_holding: “Czech Israel הולדינג”,
};

const TYPE_LABELS = {
income_expected: “הכנסה צפויה”,
expense_expected: “הוצאה צפויה”,
income_actual: “הכנסה בפועל”,
expense_actual: “הוצאה בפועל”,
};

const SYSTEM_PROMPT =
“You MUST always respond in Hebrew only.\n\n” +
“אתה סוכן פיננסי אישי של מנחם שופל, מנהל קבוצת Czech-Israel.\n\n” +
“מבנה החברות:\n” +
“- Czech Israel הולדינג s.r.o - חברת האם. בעלים: מנחם שופל ורון זבנר שי (50/50)\n” +
“- Czech Israel קולין s.r.o - 70 דירות + 1,200 מר מסחר. בנייה צפויה אוגוסט 2025\n” +
“- CBRMY s.r.o - רוכשת ומוזגת את EDGON (30 דירות בצרניצה)\n” +
“- BESIATA s.r.o - מגרש בקולין\n” +
“- BEEZRATO s.r.o - פרויקט מלדה בולסוב\n\n” +
“יש לך גישה לזיכרון משותף ולנתוני תזרים של כל חברה.\n” +
“ענה תמיד בעברית. היה מקצועי וממוקד.”;

const PERSISTENT_KEYBOARD = {
reply_markup: {
keyboard: [
[“Czech Israel קולין”, “CBRMY”],
[“BESIATA”, “BEEZRATO”],
[“Czech Israel הולדינג”],
[“תזרים מרוכז”, “תפריט”],
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
{ text: “סטטוס”, callback_data: companyKey + “_status” },
{ text: “פיננסי”, callback_data: companyKey + “_finance” },
],
[
{ text: “לוח זמנים”, callback_data: companyKey + “_timeline” },
{ text: “אנשי קשר”, callback_data: companyKey + “_contacts” },
],
[{ text: “תזרים”, callback_data: companyKey + “_cashflow” }],
[{ text: “חזרה”, callback_data: “main_menu” }],
],
},
};
}

function getCashflowMenu(companyKey) {
return {
reply_markup: {
inline_keyboard: [
[
{ text: “הכנסה צפויה”, callback_data: “cf_” + companyKey + “*income_expected” },
{ text: “הוצאה צפויה”, callback_data: “cf*” + companyKey + “*expense_expected” },
],
[
{ text: “נכנס בפועל”, callback_data: “cf*” + companyKey + “*income_actual” },
{ text: “יצא בפועל”, callback_data: “cf*” + companyKey + “*expense_actual” },
],
[
{ text: “דוח חודשי”, callback_data: “rpt*” + companyKey + “*monthly” },
{ text: “דוח רבעוני”, callback_data: “rpt*” + companyKey + “*quarterly” },
],
[{ text: “דוח שנתי”, callback_data: “rpt*” + companyKey + “_yearly” }],
[{ text: “חזרה”, callback_data: companyKey }],
],
},
};
}

function getMergedCashflowMenu() {
return {
reply_markup: {
inline_keyboard: [
[
{ text: “דוח חודשי”, callback_data: “rpt_all_monthly” },
{ text: “דוח רבעוני”, callback_data: “rpt_all_quarterly” },
],
[{ text: “דוח שנתי”, callback_data: “rpt_all_yearly” }],
[{ text: “חזרה”, callback_data: “main_menu” }],
],
},
};
}

const INLINE_MAIN_MENU = {
reply_markup: {
inline_keyboard: [
[
{ text: “Czech Israel קולין”, callback_data: “company_kolin” },
{ text: “CBRMY”, callback_data: “company_cbrmy” },
],
[
{ text: “BESIATA”, callback_data: “company_besiata” },
{ text: “BEEZRATO”, callback_data: “company_beezrato” },
],
[{ text: “Czech Israel הולדינג”, callback_data: “company_holding” }],
[{ text: “תזרים מרוכז”, callback_data: “cashflow_all” }],
],
},
};

const COMPANY_INFO = {
company_kolin: { name: “Czech Israel קולין”, info: “Czech Israel קולין s.r.o\n\n70 דירות + 1,200 מר מסחר\nבנייה צפויה: אוגוסט 2025\nCzech-Israel מחזיקה 50%” },
company_cbrmy: { name: “CBRMY”, info: “CBRMY s.r.o\n\nרוכשת ומוזגת את EDGON\n30 דירות בצרניצה” },
company_besiata: { name: “BESIATA”, info: “BESIATA s.r.o\n\nמגרש בקולין” },
company_beezrato: { name: “BEEZRATO”, info: “BEEZRATO s.r.o\n\nפרויקט מלדה בולסוב” },
company_holding: { name: “Czech Israel הולדינג”, info: “Czech Israel הולדינג s.r.o\n\nחברת האם\nבעלים: מנחם שופל ורון זבנר שי (50/50)” },
};

const KEYBOARD_TO_COMPANY = {
“Czech Israel קולין”: “company_kolin”,
“CBRMY”: “company_cbrmy”,
“BESIATA”: “company_besiata”,
“BEEZRATO”: “company_beezrato”,
“Czech Israel הולדינג”: “company_holding”,
};

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
text.toLowerCase().indexOf(”@” + botUsername.toLowerCase()) !== -1 ||
text.indexOf(“קלוד”) !== -1
);
const replyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.username === botUsername;
if (mentionedBot || replyToBot) { activateSession(msg.chat.id); return true; }
if (isSessionActive(msg.chat.id)) { activateSession(msg.chat.id); return true; }
return false;
}

function cleanText(text) {
return (text || “”).replace(/@\S+/g, “”).trim();
}

function getSenderName(msg) {
const first = (msg.from && msg.from.first_name) || “”;
const last = (msg.from && msg.from.last_name) || “”;
return (first + “ “ + last).trim() || “משתמש”;
}

async function downloadFile(fileId) {
const fileLink = await bot.getFileLink(fileId);
const response = await axios.get(fileLink, { responseType: “arraybuffer” });
return Buffer.from(response.data);
}

async function extractText(fileId, fileName, mimeType) {
const buffer = await downloadFile(fileId);
const ext = path.extname(fileName || “”).toLowerCase();
if (ext === “.xlsx” || ext === “.xls” || (mimeType && (mimeType.indexOf(“spreadsheet”) !== -1 || mimeType.indexOf(“excel”) !== -1))) {
const workbook = XLSX.read(buffer, { type: “buffer” });
let text = “”;
workbook.SheetNames.forEach(function(sheet) {
text += “\nגיליון: “ + sheet + “\n”;
text += XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
});
return text;
}
if (ext === “.csv”) return buffer.toString(“utf-8”);
if (ext === “.pdf” || (mimeType && mimeType.indexOf(“pdf”) !== -1)) {
const data = await pdf(buffer);
return data.text;
}
if (ext === “.docx” || (mimeType && mimeType.indexOf(“wordprocessingml”) !== -1)) {
const result = await mammoth.extractRawText({ buffer: buffer });
return result.value;
}
if (ext === “.txt”) return buffer.toString(“utf-8”);
return null;
}

async function askClaude(chatId, prompt) {
if (!conversations[chatId]) conversations[chatId] = [];
const memory = await getSharedMemory();
const userMessage = memory ? prompt + “\n\n(” + memory + “)” : prompt;
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

async function detectCashflowEntry(text) {
const prompt =
“האם הטקסט מכיל הזנת תזרים? טקסט: "” + text + “"\n” +
“חברות: company_kolin, company_cbrmy, company_besiata, company_beezrato, company_holding\n” +
“סוגים: income_expected, expense_expected, income_actual, expense_actual\n” +
“ענה רק JSON: {"is_cashflow":true,"company":"key","type":"type","amount":12345,"description":"תיאור"} או {"is_cashflow":false}”;

const response = await anthropic.messages.create({
model: “claude-haiku-4-5-20251001”,
max_tokens: 200,
messages: [{ role: “user”, content: prompt }],
});
try {
const match = response.content[0].text.match(/{[\s\S]*}/);
return JSON.parse(match[0]);
} catch (e) {
return { is_cashflow: false };
}
}

bot.onText(//start/, function(msg) {
conversations[msg.chat.id] = [];
bot.sendMessage(msg.chat.id,
“שלום מנחם! אני הסוכן הפיננסי של Czech-Israel\n\nאפשר לנהל תזרים לכל חברה.\nפשוט כתוב: נכנסו 50000 מקולין\n\nבקבוצה כתוב קלוד או תייג אותי.”,
PERSISTENT_KEYBOARD
);
});

bot.onText(//menu/, function(msg) {
bot.sendMessage(msg.chat.id, “בחר חברה:”, INLINE_MAIN_MENU);
});

bot.on(“document”, async function(msg) {
const isGroup = msg.chat.type === “group” || msg.chat.type === “supergroup”;
if (isGroup && !shouldRespond(msg)) {
const senderName = getSenderName(msg);
try { await saveToSharedMemory(”[קובץ] “ + msg.document.file_name, senderName, msg.chat.type); } catch (e) {}
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
await saveToSharedMemory(“קובץ “ + doc.file_name + “:\n” + text.slice(0, 500), senderName, msg.chat.type);
const prompt = caption
? caption + “\n\nתוכן הקובץ “ + doc.file_name + “:\n” + text.slice(0, 8000)
: “נתח את הקובץ “ + doc.file_name + “:\n” + text.slice(0, 8000);
const reply = await askClaude(chatId, prompt);
bot.sendMessage(chatId, reply);
} else {
bot.sendMessage(chatId, “סוג קובץ זה לא נתמך. נסה Excel, PDF, Word או CSV.”);
}
} catch (err) {
bot.sendMessage(chatId, “אופס, לא הצלחתי לקרוא את הקובץ”);
}
});

bot.on(“callback_query”, async function(query) {
const chatId = query.message.chat.id;
const data = query.data;

if (data === “main_menu”) {
bot.editMessageText(“בחר חברה:”, { chat_id: chatId, message_id: query.message.message_id, reply_markup: INLINE_MAIN_MENU.reply_markup });
bot.answerCallbackQuery(query.id);
return;
}

if (data === “cashflow_all”) {
bot.editMessageText(“תזרים מרוכז - כל החברות\nבחר תקופה:”, { chat_id: chatId, message_id: query.message.message_id, reply_markup: getMergedCashflowMenu().reply_markup });
bot.answerCallbackQuery(query.id);
return;
}

if (COMPANY_INFO[data]) {
bot.editMessageText(COMPANY_INFO[data].info, { chat_id: chatId, message_id: query.message.message_id, reply_markup: getCompanyMenu(data).reply_markup });
bot.answerCallbackQuery(query.id);
return;
}

if (data.endsWith(”_cashflow”)) {
const companyKey = data.replace(”_cashflow”, “”);
const companyName = COMPANY_NAMES[companyKey] || companyKey;
bot.editMessageText(“תזרים - “ + companyName + “\nבחר פעולה:”, { chat_id: chatId, message_id: query.message.message_id, reply_markup: getCashflowMenu(companyKey).reply_markup });
bot.answerCallbackQuery(query.id);
return;
}

if (data.indexOf(“cf_”) === 0) {
const parts = data.split(”*”);
const cfType = parts[parts.length - 2] + “*” + parts[parts.length - 1];
const companyKey = parts.slice(1, -2).join(”_”);
const companyName = COMPANY_NAMES[companyKey] || companyKey;
const typeLabel = TYPE_LABELS[cfType];
userState[chatId] = { action: “cashflow_entry”, companyKey: companyKey, type: cfType, companyName: companyName, typeLabel: typeLabel };
bot.answerCallbackQuery(query.id);
bot.sendMessage(chatId, “הזן סכום ותיאור עבור “ + typeLabel + “ ב-” + companyName + “:\nלדוגמה: 50000 תשלום קבלן”);
return;
}

if (data.indexOf(“rpt_”) === 0) {
const parts = data.split(”*”);
const period = parts[parts.length - 1];
const companyKey = parts.slice(1, -1).join(”*”);
bot.answerCallbackQuery(query.id, { text: “מכין דוח…” });
bot.sendChatAction(chatId, “typing”);
try {
const reportMsg = await buildReport(companyKey, period);
bot.sendMessage(chatId, reportMsg);
} catch (err) {
bot.sendMessage(chatId, “אופס, לא הצלחתי להכין דוח”);
}
return;
}

const parts = data.split(”*”);
const action = parts[parts.length - 1];
const companyKey = parts.slice(0, -1).join(”*”);
const companyName = (COMPANY_INFO[companyKey] && COMPANY_INFO[companyKey].name) || companyKey;
const actionMap = { status: “סטטוס עדכני”, finance: “מצב פיננסי”, timeline: “לוח זמנים”, contacts: “אנשי קשר” };
const prompt = “תן לי “ + (actionMap[action] || action) + “ על “ + companyName;
bot.answerCallbackQuery(query.id, { text: “מחפש מידע…” });
bot.sendChatAction(chatId, “typing”);
try {
const reply = await askClaude(chatId, prompt);
bot.sendMessage(chatId, reply);
} catch (err) {
bot.sendMessage(chatId, “אופס, נתקלתי בבעיה. נסה שוב”);
}
});

bot.on(“message”, async function(msg) {
const chatId = msg.chat.id;
const text = msg.text;
if (!text || text.indexOf(”/”) === 0) return;

const senderName = getSenderName(msg);
const chatType = msg.chat.type;

try { await saveToSharedMemory(text, senderName, chatType); } catch (err) {}

if (userState[chatId] && userState[chatId].action === “cashflow_entry”) {
const state = userState[chatId];
delete userState[chatId];
const match = text.match(/^(\d[\d,.]*)(.*)/);
if (match) {
const amount = parseFloat(match[1].replace(/,/g, “”));
const description = match[2].trim() || state.typeLabel;
try {
await saveCashflow(state.companyKey, state.type, amount, description);
bot.sendMessage(chatId, “נשמר!\n” + state.typeLabel + “ - “ + formatAmount(amount) + “\n” + description + “\nחברה: “ + state.companyName);
} catch (err) {
bot.sendMessage(chatId, “שגיאה בשמירה, נסה שוב”);
}
} else {
bot.sendMessage(chatId, “לא הבנתי את הסכום. נסה שוב, למשל: 50000 תשלום קבלן”);
}
return;
}

if (KEYBOARD_TO_COMPANY[text]) {
bot.sendMessage(chatId, COMPANY_INFO[KEYBOARD_TO_COMPANY[text]].info, getCompanyMenu(KEYBOARD_TO_COMPANY[text]));
return;
}

if (text === “תפריט”) { bot.sendMessage(chatId, “בחר חברה:”, INLINE_MAIN_MENU); return; }
if (text === “תזרים מרוכז”) {
bot.sendMessage(chatId, “תזרים מרוכז - כל החברות\nבחר תקופה:”, getMergedCashflowMenu());
return;
}

if (!shouldRespond(msg)) return;

const cleanedText = cleanText(text);
if (!cleanedText) return;

try {
const cf = await detectCashflowEntry(cleanedText);
if (cf.is_cashflow && cf.company && cf.type && cf.amount) {
await saveCashflow(cf.company, cf.type, cf.amount, cf.description || “”);
const companyName = COMPANY_NAMES[cf.company] || cf.company;
bot.sendMessage(chatId, “תועד!\n” + TYPE_LABELS[cf.type] + “ - “ + formatAmount(cf.amount) + “\n” + (cf.description || “”) + “\nחברה: “ + companyName);
return;
}
} catch (err) {}

bot.sendChatAction(chatId, “typing”);
try {
const reply = await askClaude(chatId, cleanedText);
bot.sendMessage(chatId, reply);
} catch (err) {
bot.sendMessage(chatId, “אופס, נתקלתי בבעיה. נסה שוב”);
}
});

console.log(“סוכן פיננסי Czech-Israel פועל!”);
