require("dotenv").config();

const { Telegraf } = require("telegraf");
const { extractChannelUsername, fetchChannelPosts } = require("./src/channelScraper");
const { summarizeChannelPosts, summarizeContent } = require("./src/summarizer");
const { splitMessage } = require("./src/utils");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("❌ خطأ: يرجى وضع TELEGRAM_BOT_TOKEN في ملف .env");
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ خطأ: يرجى وضع GEMINI_API_KEY في ملف .env");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// دالة مساعدة لإرسال الرسائل الطويلة مقسمة دون تجاوز حد التيليجرام
async function sendSafeReply(ctx, text, extra = {}) {
  const chunks = splitMessage(text, 3800);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown", ...extra });
    } catch {
      // في حال وجود خلل في تنسيق الماركداون من الـ API يتم الإرسال كنص عادي
      await ctx.reply(chunk, extra);
    }
  }
}

// رسالة الترحيب والتعليمات
const WELCOME_MESSAGE = `
👋 *أهلاً بك في بوت التلخيص الذكي المدعوم بـ Gemini!*

أنا هنا لمساعدتك في قراءة وتلخيص المحتوى بسرعة وبشكل منظم:

🔹 *1. تلخيص قنوات التليجرام العامة (آخر 48 ساعة)*:
أرسل معرف القناة أو رابطها مباشرة:
• \`@alarabiya\`
• \`https://t.me/aljazeeramubasher\`
وسأقوم بجلب منشورات آخر يومين، وفرزها وتلخيص أهم أحداثها ومواضيعها.

🔹 *2. تلخيص الرسائل المحولة (Forwarded)*:
حوّل أي رسالة من أي محادثة أو قناة خاصة، وسأستخرج خلاصتها وأهم نقاطها فوراً.

🔹 *3. تلخيص النصوص والمقالات الطويلة*:
أرسل أي نص طويل أو مقال، وسأقوم بتحليله وتلخيصه في نقاط رئيسية مركزة.

⚡ *جرّب الآن بإرسال معرف قناة أو نص!*
`;

bot.command(["start", "help"], async (ctx) => {
  await ctx.reply(WELCOME_MESSAGE, { parse_mode: "Markdown" });
});

// معالجة كافة الرسائل النصية والرسائل المحولة
bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (!msg) return;

  const text = msg.text || msg.caption || "";
  const isForwarded = Boolean(
    msg.forward_date ||
    msg.forward_origin ||
    msg.forward_from ||
    msg.forward_from_chat
  );

  // 1. إذا كانت رسالة محولة
  if (isForwarded && text) {
    let sourceName = "";
    if (msg.forward_from_chat && msg.forward_from_chat.title) {
      sourceName = msg.forward_from_chat.title;
    } else if (msg.forward_from && msg.forward_from.first_name) {
      sourceName = msg.forward_from.first_name;
    }

    const waitMsg = await ctx.reply("⏳ جاري قراءة وتلخيص الرسالة المحولة...");
    try {
      await ctx.sendChatAction("typing");
      const summary = await summarizeContent(text, {
        isForwarded: true,
        from: sourceName,
      });

      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await sendSafeReply(ctx, summary);
    } catch (err) {
      console.error("خطأ في تلخيص الرسالة المحولة:", err);
      await ctx.reply("❌ عذراً، حدث خطأ أثناء تلخيص هذه الرسالة.");
    }
    return;
  }

  // 2. إذا لم يكن هناك نص
  if (!text) {
    if (msg.photo || msg.document) {
      await ctx.reply("💡 يرجى إرسال نص أو تحويل رسالة نصية أو إرسال رابط قناة لتلخيصها.");
    }
    return;
  }

  // فحص هل المدخل رابط قناة أو معرف تليجرام
  const isChannelPattern =
    /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([a-zA-Z0-9_]{4,})\/?$/i.test(text.trim()) ||
    /^@([a-zA-Z0-9_]{4,})$/.test(text.trim()) ||
    (/^\/summary\s+([a-zA-Z0-9_@]+)/i.test(text.trim()));

  if (isChannelPattern) {
    const rawUsername = text.replace(/^\/summary\s+/i, "").trim();
    const cleanUsername = extractChannelUsername(rawUsername);

    const statusMsg = await ctx.reply(
      `🔍 جاري جلب منشورات آخر 48 ساعة من قناة *@${cleanUsername}*...`,
      { parse_mode: "Markdown" }
    );

    try {
      await ctx.sendChatAction("typing");
      const channelData = await fetchChannelPosts(cleanUsername, 48);

      if (channelData.messages.length === 0) {
        await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
        await ctx.reply(
          `ℹ️ لم يتم نشر أي منشورات جديدة في قناة *${channelData.title}* خلال آخر 48 ساعة.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `📊 تم استخراج *${channelData.messages.length}* منشوراً من *${channelData.title}*.\n🧠 جاري إنشاء الملخص الذكي بواسطة Gemini...`,
        { parse_mode: "Markdown" }
      ).catch(() => {});

      await ctx.sendChatAction("typing");
      const summary = await summarizeChannelPosts(channelData.title, channelData.username, channelData.messages);

      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      await sendSafeReply(ctx, summary);

    } catch (err) {
      console.error("خطأ في معالجة القناة:", err);
      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      await ctx.reply(`⚠️ ${err.message || "تعذر جلب منشورات القناة. تأكد من أن المعرف صحيح والقناة عامة وليست خاصة."}`);
    }
    return;
  }

  // 3. نصوص طويلة (أكثر من 60 حرف)
  if (text.length > 60) {
    const waitMsg = await ctx.reply("⏳ جاري قراءة وتلخيص النص بالذكاء الاصطناعي...");
    try {
      await ctx.sendChatAction("typing");
      const summary = await summarizeContent(text, { isForwarded: false });
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await sendSafeReply(ctx, summary);
    } catch (err) {
      console.error("خطأ في تلخيص النص:", err);
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await ctx.reply("❌ حدث خطأ أثناء محاولة تلخيص هذا النص.");
    }
    return;
  }

  // 4. نصوص قصيرة أو كلمات مفردة قد تكون اسم قناة بدون @
  if (/^[a-zA-Z0-9_]{4,32}$/.test(text.trim())) {
    const maybeChannel = text.trim();
    try {
      await ctx.sendChatAction("typing");
      const channelData = await fetchChannelPosts(maybeChannel, 48);
      if (channelData && channelData.messages.length > 0) {
        const waitMsg = await ctx.reply(
          `📊 تم التعرف على قناة *${channelData.title}* وجلب *${channelData.messages.length}* منشوراً لآخر 48 ساعة.\n🧠 جاري التلخيص...`,
          { parse_mode: "Markdown" }
        );
        const summary = await summarizeChannelPosts(channelData.title, channelData.username, channelData.messages);
        await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
        await sendSafeReply(ctx, summary);
        return;
      }
    } catch {
      // ليس قناة عامة، المتابعة لرسالة الإرشاد
    }
  }

  // رسالة إرشادية في حال كان النص قصيراً جداً
  await ctx.reply(
    "💡 أرسل رابط أو معرف أي قناة عامة (مثل `@alarabiya`) لتلخيص آخر يومين فيها، أو أرسل نصاً طويلاً / رسالة محولة لتلخيصها.",
    { parse_mode: "Markdown" }
  );
});

// خادم HTTP خفيف للتوافق التام مع استضافات السحابة مثل Render (Web Service)
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("🤖 بوت تليجرام يعمل بنجاح على السحابة!");
}).listen(PORT, () => {
  console.log(`🌐 خادم الفحص (Health-check) يعمل على المنفذ: ${PORT}`);
});

// بدء التشغيل وإظهار معلومات البوت
bot.telegram.getMe().then((botInfo) => {
  console.log(`🤖 البوت @${botInfo.username} متصل ويعمل بنجاح!`);
}).catch((err) => {
  console.error("❌ فشل الاتصال بتليجرام:", err.message);
});

bot.launch().catch((err) => {
  console.error("❌ خطأ أثناء تشغيل البوت:", err);
});

// إيقاف آمن عند إنهاء التطبيق
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));