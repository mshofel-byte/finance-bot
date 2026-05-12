const TelegramBot = require('node-telegram-bot-api');
const { Anthropic } = require('@anthropic-ai/sdk');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// משתנה זמני לשמירת היסטוריית השיחה (זיכרון לטווח קצר)
let chatHistory = [];

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const isPrivate = msg.chat.type === 'private';
    const mentioned = text && text.includes('@CzechIsraelFinance_bot');
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from.username === 'CzechIsraelFinance_bot';

    if (!text) return;

    // הבוט תמיד שומר את המידע בזיכרון (האזנה שקטה)
    chatHistory.push({ role: "user", content: `${msg.from.first_name}: ${text}` });
    if (chatHistory.length > 50) chatHistory.shift(); // שומר רק 50 הודעות אחרונות

    // הבוט מגיב רק אם זה פרטי, תיוג, או תגובה אליו
    if (isPrivate || mentioned || isReplyToBot) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 1000,
                system: "אתה סוכן פיננסי חכם בשם מני. אתה עוזר למנחם ורוני לנהל את קבוצת צ'כיה-ישראל. תענה בקצרה ובענייניות.",
                messages: chatHistory
            });

            const reply = response.content[0].text;
            bot.sendMessage(chatId, reply);
            chatHistory.push({ role: "assistant", content: reply });
        } catch (error) {
            console.error("Error calling Claude:", error);
        }
    }
});
