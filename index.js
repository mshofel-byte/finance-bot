const TelegramBot = require(“node-telegram-bot-api”);
const Anthropic = require(”@anthropic-ai/sdk”);
const axios = require(“axios”);
const XLSX = require(“xlsx”);
const pdf = require(“pdf-parse”);
const mammoth = require(“mammoth”);
const ExcelJS = require(“exceljs”);
const PDFDocument = require(“pdfkit”);
const { Document, Packer, Paragraph, TextRun } = require(“docx”);
const fs = require(“fs”);
const path = require(“path”);

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
- Rezidence Kolín s.r.o — 70 דירות + 1,200 מ”ר מסחר. בנייה צפויה אוגוסט 2025
- CBRMY s.r.o — רוכשת את Edgon (30 דירות בצ’רניצ’ה)
- BESIATA s.r.o — מגרש בקולין
- BEEZRATO s.r.o — פרויקט מלדה בולסוב
- EDGON a.s. — 2 בניינים בצ’רניצ’ה
- Osterhauer — חברה משותפת מנחם ורוני

אתה מקשיב לכל השיחות בקבוצה ושומר את המידע בזיכרון.
כשפונים אליך, השתמש בכל מה ששמעת כדי לענות בצורה מדויקת ומועילה.
אתה יכול לקרוא קבצים שמשלחים אליך ולנתח אותם.
אתה יכול גם ליצור קבצי Excel, PDF ו-Word לפי בקשה.
ענה תמיד בעברית. היה מקצועי וממוקד.`;

// — מקלדת קבועה —
const PERSISTENT_KEYBOARD = {
reply_markup: {
keyboard: [
[“🏗️ Rezidence Kolín”, “🏢 EDGON”],
[“🏘️ CBRMY”, “🌳 BESIATA”],
[“🏙️ BEEZRATO”, “🤝 Osterhauer”],
[“🏛️ Czech-Israel Holding”, “📋 תפריט”],
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
[{ text: “🔙 חזרה”, callback_data: “main_menu” }],
],
},
};
}

const INLINE_MAIN_MENU = {
reply_markup: {
inline_keyboard: [
[
{ text: “🏗️ Rezidence Kolín”, callback_data: “company_kolin” },
{ text: “🏢 EDGON”, callback_data: “company_edgon” },
],
[
{ text: “🏘️ CBRMY”, callback_data: “company_cbrmy” },
{ text: “🌳 BESIATA”, callback_data: “company_besiata” },
],
[
{ text: “🏙️ BEEZRATO”, callback_data: “company_beezrato” },
{ text: “🤝 Osterhauer”, callback_data: “company_osterhauer” },
],
[{ text: “🏛️ Czech-Israel Holding”, callback_data: “company_holding” }],
],
},
};

const COMPANY_INFO = {
company_kolin: { name: “Rezidence Kolín”, info: “🏗️ Rezidence Kolín s.r.o\n\n70 דירות + 1,200 מ"ר מסחר\nבנייה צפויה: אוגוסט 2025\nCzech-Israel מחזיקה 50%” },
company_edgon: { name: “EDGON”, info: “🏢 EDGON a.s\n\n2 בניינים בצ’רניצ’ה\nנרכשת ע"י CBRMY s.r.o” },
company_cbrmy: { name: “CBRMY”, info: “🏘️ CBRMY s.r.o\n\nרוכשת את EDGON\n30 דירות בצ’רניצ’ה” },
company_besiata: { name: “BESIATA”, info: “🌳 BESIATA s.r.o\n\nמגרש בקולין” },
company_beezrato: { name: “BEEZRATO”, info: “🏙️ BEEZRATO s.r.o\n\nפרויקט מלדה בולסוב” },
company_osterhauer: { name: “Osterhauer”, info: “🤝 Osterhauer\n\nחברה משותפת מנחם ורוני” },
company_holding: { name: “Czech-Israel Holding”, info: “🏛️ Czech-Israel Holding s.r.o\n\nחברת האם\nבעלים: מנחם שופל ורון זבנר שי (50/50)” },
};

const KEYBOARD_TO_COMPANY = {
“🏗️ Rezidence Kolín”: “company_kolin”,
“🏢 EDGON”: “company_edgon”,
“🏘️ CBRMY”: “company_cbrmy”,
“🌳 BESIATA”: “company_besiata”,
“🏙️ BEEZRATO”: “company_beezrato”,
“🤝 Osterhauer”: “company_osterhauer”,
“🏛️ Czech-Israel Holding”: “company_holding”,
};

// — עזר —
function saveToMemory(chatId, senderName, text) {
if (!groupMemory[chatId]) groupMemory[chatId] = [];
const timestamp = new Date().toLocaleString(“he-IL”, { timeZone: “Asia/Jerusalem” });
groupMemory[chatId].push(`[${timestamp}] ${senderName}: ${text}`);
if (groupMemory[chatId].length > 200) groupMemory[chatId] = groupMemory[chatId].slice(-200);
}

function buildContext(chatId) {
if (!groupMemory[chatId] || groupMemory[chatId].length === 0) return “”;
const recent = groupMemory[chatId].slice(-50);
return `\n\n--- היסטוריית השיחה בקבוצה ---\n${recent.join("\n")}\n--- סוף היסטוריה ---\n`;
}

function shouldRespond(msg) {
if (msg.chat.type === “private”) return true;
const mentionedBot = botUsername && msg.text && msg.text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
const replyToBot = msg.reply_to_message?.from?.username === botUsername;
return mentionedBot || replyToBot;
}

function shouldRespondToFile(msg) {
if (msg.chat.type === “private”) return true;
const caption = msg.caption || “”;
const mentionedBot = botUsername && caption.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
const replyToBot = msg.reply_to_message?.from?.username === botUsername;
return mentionedBot || replyToBot;
}

function cleanText(text) {
return (text || “”).replace(/@\S+/g, “”).trim();
}

function getSenderName(msg) {
return `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim() || “משתמש”;
}

// — הורדת קובץ מטלגרם —
async function downloadFile(fileId) {
const fileLink = await bot.getFileLink(fileId);
const response = await axios.get(fileLink, { responseType: “arraybuffer” });
return Buffer.from(response.data);
}

// — קריאת קבצים —
async function extractTextFromFile(fileId, fileName, mimeType) {
const buffer = await downloadFile(fileId);
const ext = path.extname(fileName || “”).toLowerCase();

// Excel
if (ext === “.xlsx” || ext === “.xls” || mimeType?.includes(“spreadsheet”) || mimeType?.includes(“excel”)) {
const workbook = XLSX.read(buffer, { type: “buffer” });
let text = “”;
workbook.SheetNames.forEach((sheet) => {
text += `\n📊 גיליון: ${sheet}\n`;
text += XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
});
return text;
}

// CSV
if (ext === “.csv” || mimeType?.includes(“csv”)) {
return buffer.toString(“utf-8”);
}

// PDF
if (ext === “.pdf” || mimeType?.includes(“pdf”)) {
const data = await pdf(buffer);
return data.text;
}

// Word
if (ext === “.docx” || mimeType?.includes(“wordprocessingml”) || mimeType?.includes(“msword”)) {
const result = await mammoth.extractRawText({ buffer });
return result.value;
}

// טקסט רגיל
if (ext === “.txt” || mimeType?.includes(“text”)) {
return buffer.toString(“utf-8”);
}

return null;
}

// — יצירת קבצים —
async function createExcel(chatId, prompt) {
const response = await askClaude(chatId,
`${prompt}\n\nענה ONLY בפורמט JSON כך: {"title":"כותרת","headers":["עמודה1","עמודה2"],"rows":[["ערך1","ערך2"]]}`
);

let data;
try {
const jsonMatch = response.match(/{[\s\S]*}/);
data = JSON.parse(jsonMatch[0]);
} catch {
return null;
}

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet(data.title || “דוח”);
sheet.addRow(data.headers);
sheet.getRow(1).font = { bold: true };
data.rows.forEach((row) => sheet.addRow(row));

const filePath = `/tmp/report_${Date.now()}.xlsx`;
await workbook.xlsx.writeFile(filePath);
return filePath;
}

async function createPDF(chatId, prompt) {
const content = await askClaude(chatId, prompt);
const filePath = `/tmp/report_${Date.now()}.pdf`;

return new Promise((resolve) => {
const doc = new PDFDocument({ margin: 50 });
const stream = fs.createWriteStream(filePath);
doc.pipe(stream);
doc.fontSize(14).text(content, { align: “right” });
doc.end();
stream.on(“finish”, () => resolve(filePath));
});
}

async function createWord(chatId, prompt) {
const content = await askClaude(chatId, prompt);
const paragraphs = content.split(”\n”).map(
(line) => new Paragraph({ children: [new TextRun(line)] })
);

const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
const buffer = await Packer.toBuffer(doc);
const filePath = `/tmp/report_${Date.now()}.docx`;
fs.writeFileSync(filePath, buffer);
return filePath;
}

// — Claude —
async function askClaude(chatId, prompt, imageBuffer = null) {
if (!conversations[chatId]) conversations[chatId] = [];
const context = buildContext(chatId);
const userMessage = context ? `${prompt}\n\n(הקשר: ${context})` : prompt;

let content;
if (imageBuffer) {
content = [
{ type: “image”, source: { type: “base64”, media_type: “image/jpeg”, data: imageBuffer.toString(“base64”) } },
{ type: “text”, text: userMessage },
];
} else {
content = userMessage;
}

conversations[chatId].push({ role: “user”, content });

const response = await anthropic.messages.create({
model: “claude-haiku-4-5-20251001”,
max_tokens: 2000,
system: SYSTEM_PROMPT,
messages: conversations[chatId],
});

const reply = response.content[0].text;
conversations[chatId].pop();
conversations[chatId].push({ role: “user”, content: userMessage });
conversations[chatId].push({ role: “assistant”, content: reply });
if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
return reply;
}

// — טיפול בקבצים שמתקבלים —
async function handleIncomingFile(msg, fileId, fileName, mimeType) {
const chatId = msg.chat.id;
const caption = cleanText(msg.caption || “”);

bot.sendChatAction(chatId, “typing”);

try {
// תמונה
if (mimeType?.startsWith(“image/”) || msg.photo) {
const buffer = await downloadFile(fileId);
const prompt = caption || “תאר ונתח את התמונה הזו”;
const reply = await askClaude(chatId, prompt, buffer);
bot.sendMessage(chatId, reply);
return;
}

```
// קובץ טקסטואלי
const text = await extractTextFromFile(fileId, fileName, mimeType);
if (text) {
  const prompt = caption
    ? `${caption}\n\nתוכן הקובץ "${fileName}":\n${text.slice(0, 8000)}`
    : `נתח את הקובץ "${fileName}":\n${text.slice(0, 8000)}`;
  const reply = await askClaude(chatId, prompt);
  bot.sendMessage(chatId, reply);
} else {
  bot.sendMessage(chatId, "סוג הקובץ הזה עדיין לא נתמך. נסה Excel, PDF, Word, CSV או תמונה.");
}
```

} catch (err) {
console.error(“File error:”, err.message);
bot.sendMessage(chatId, “אופס, לא הצלחתי לקרוא את הקובץ 🙏”);
}
}

// — זיהוי בקשת יצירת קובץ —
function detectFileCreationRequest(text) {
const lower = text.toLowerCase();
if (lower.includes(“צור”) || lower.includes(“הכן”) || lower.includes(“בנה”) || lower.includes(“עשה”)) {
if (lower.includes(“excel”) || lower.includes(“אקסל”) || lower.includes(“xlsx”)) return “excel”;
if (lower.includes(“pdf”)) return “pdf”;
if (lower.includes(“word”) || lower.includes(“docx”) || lower.includes(“מסמך”)) return “word”;
}
return null;
}

// — פקודות —
bot.onText(//start/, (msg) => {
conversations[msg.chat.id] = [];
bot.sendMessage(msg.chat.id,
“שלום מנחם! אני הסוכן הפיננסי של Czech-Israel 🏢\n\nאני יכול:\n📂 לקרוא קבצים (Excel, PDF, Word, תמונות)\n📄 ליצור קבצים לפי בקשה\n💬 לענות על שאלות\n\nבחר חברה מהתפריט למטה או שאל אותי כל שאלה.”,
PERSISTENT_KEYBOARD
);
});

bot.onText(//תפריט|/menu/, (msg) => {
bot.sendMessage(msg.chat.id, “בחר חברה:”, INLINE_MAIN_MENU);
});

// — קבלת קבצים —
bot.on(“document”, async (msg) => {
if (!shouldRespondToFile(msg)) return;
const doc = msg.document;
await handleIncomingFile(msg, doc.file_id, doc.file_name, doc.mime_type);
});

bot.on(“photo”, async (msg) => {
if (!shouldRespondToFile(msg)) return;
const photo = msg.photo[msg.photo.length - 1];
await handleIncomingFile(msg, photo.file_id, “photo.jpg”, “image/jpeg”);
});

// — כפתורי inline —
bot.on(“callback_query”, async (query) => {
const chatId = query.message.chat.id;
const data = query.data;

if (data === “main_menu”) {
bot.editMessageText(“בחר חברה:”, { chat_id: chatId, message_id: query.message.message_id, …INLINE_MAIN_MENU });
bot.answerCallbackQuery(query.id);
return;
}

if (COMPANY_INFO[data]) {
bot.editMessageText(COMPANY_INFO[data].info, { chat_id: chatId, message_id: query.message.message_id, …getCompanyMenu(data) });
bot.answerCallbackQuery(query.id);
return;
}

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
const isGroup = msg.chat.type === “group” || msg.chat.type === “supergroup”;

if (isGroup) saveToMemory(chatId, senderName, text);

if (KEYBOARD_TO_COMPANY[text]) {
const companyKey = KEYBOARD_TO_COMPANY[text];
bot.sendMessage(chatId, COMPANY_INFO[companyKey].info, getCompanyMenu(companyKey));
return;
}

if (text === “📋 תפריט”) {
bot.sendMessage(chatId, “בחר חברה:”, INLINE_MAIN_MENU);
return;
}

if (!shouldRespond(msg)) return;

const cleanedText = cleanText(text);
if (!cleanedText) return;

// בדוק אם בקשת יצירת קובץ
const fileType = detectFileCreationRequest(cleanedText);
if (fileType) {
bot.sendChatAction(chatId, “upload_document”);
try {
let filePath;
if (fileType === “excel”) filePath = await createExcel(chatId, cleanedText);
else if (fileType === “pdf”) filePath = await createPDF(chatId, cleanedText);
else if (fileType === “word”) filePath = await createWord(chatId, cleanedText);

```
  if (filePath) {
    await bot.sendDocument(chatId, filePath);
    fs.unlinkSync(filePath);
  }
} catch (err) {
  console.error("Create file error:", err.message);
  bot.sendMessage(chatId, "אופס, לא הצלחתי ליצור את הקובץ 🙏");
}
return;
```

}

bot.sendChatAction(chatId, “typing”);
try {
const reply = await askClaude(chatId, cleanedText);
bot.sendMessage(chatId, reply);
} catch (err) {
console.error(“Error:”, err.message);
bot.sendMessage(chatId, “אופס, נתקלתי בבעיה. נסה שוב 🙏”);
}
});

console.log(“🏢 סוכן פיננסי Czech-Israel פועל!”);
