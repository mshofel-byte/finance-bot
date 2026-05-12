const TelegramBot = require('node-telegram-bot-api');
const { Anthropic } = require('@anthropic-ai/sdk');

// התחברות למשתני המערכת מ-Railway
const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(token, { polling: true });
const anthropic = new Anthropic({ apiKey: apiKey });

// זיכרון זמני של 50 ההודעות האחרונות בקבוצה
let chatHistory = [];

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const firstName = msg.from.first_name || "משתמש";
    
    if (!text) return;

    // הגדרות זיהוי: הודעה פרטית, תיוג הבוט, או תגובה אליו
    const isPrivate = msg.chat.type === 'private';
    const isMentioned = text.includes('@CzechIsraelFinance_bot');
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from.username === 'CzechIsraelFinance_bot';

    // הבוט תמיד מוסיף את ההודעה לזיכרון (האזנה שקטה)
    chatHistory.push({ role: "user", content: `${firstName}: ${text}` });
    
    if (chatHistory.length > 50) {
        chatHistory.shift();
    }

    // הבוט מגיב רק אם פנו אליו ישירות
    if (isPrivate || isMentioned || isReplyToBot) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-latest", // התיקון פה - השם שה-API מזהה בוודאות
                max_tokens: 1000,
                system: "אתה סוכן פיננסי חכם בשם מני. אתה עוזר למנחם ורוני לנהל את קבוצת צ'כיה-ישראל. תענה בעברית עסקית אך ידידותית.",
                messages: chatHistory
            });

            const reply = response.content[0].text;
            bot.sendMessage(chatId, reply);
            
            // הוספת התשובה של הבוט להיסטוריה
            chatHistory.push({ role: "assistant", content: reply });
            
        } catch (error) {
            console.error("Error calling Claude:", error);
            // אם עדיין יש שגיאה, הבוט יכתוב לנו בלוג מה הבעיה
        }
    }
});

console.log("מני הבוט התעדכן ומחכה לתיוג...");
