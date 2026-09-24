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

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  handlerTimeout: 300000, // 5 دقائق لتجنب انتهاء المهلة أثناء المعالجة
});

// التعامل الشامل مع الأخطاء لمنع انهيار أو توقف البوت
bot.catch((err, ctx) => {
  console.error(`❌ خطأ غير متوقع أثناء معالجة (${ctx?.updateType || "غير محدد"}):`, err);
  ctx?.reply("⚠️ حدث خطأ غير متوقع أثناء المعالجة، يرجى المحاولة مجدداً.").catch(() => {});
});

/**
 * إبقاء حالة "يكتب..." (typing) نشطة طوال فترة المعالجة
 * @param {object} ctx 
 * @returns {Function} دالة لإيقاف المؤشر
 */
function startTyping(ctx) {
  ctx.sendChatAction("typing").catch(() => {});
  const interval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4500);
  return () => clearInterval(interval);
}

/**
 * إرسال الرسائل الطويلة مقسمة دون تجاوز حد التيليجرام
 * @param {object} ctx 
 * @param {string} text 
 * @param {object} extra 
 */
async function sendSafeReply(ctx, text, extra = {}) {
  let chunks = [text];
  try {
    if (typeof splitMessage === "function") {
      chunks = splitMessage(text, 3800);
    }
  } catch {
    chunks = [text];
  }

  for (const chunk of chunks) {
    if (!chunk || !chunk.trim()) continue;
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown", ...extra });
    } catch {
      // في حال وجود خلل في كود Markdown يتم الإرسال كنص عادي
      await ctx.reply(chunk, extra).catch((e) => console.error("فشل إرسال الرد:", e.message));
    }
  }
}

// رسالة الترحيب والتعليمات
const WELCOME_MESSAGE = `
👋 *أهلاً بك في بوت التلخيص الذكي!*

أنا هنا لمساعدتك في قراءة وتلخيص المحتوى بسرعة ودقة عالية:

🔹 *1. تلخيص قنوات التليجرام العامة (آخر 48 ساعة)*:
أرسل معرف القناة أو رابطها مباشرة:
• \`@alarabiya\`
• \`https://t.me/saudioffers0\`
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

// معالجة كافة الرسائل
bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (!msg) return;

  const text = (msg.text || msg.caption || "").trim();
  const isForwarded = Boolean(
    msg.forward_date ||
    msg.forward_origin ||
    msg.forward_from ||
    msg.forward_from_chat
  );

  // 1. إذا كانت رسالة محولة (Forwarded)
  if (isForwarded && text) {
    let sourceName = "";
    if (msg.forward_from_chat && msg.forward_from_chat.title) {
      sourceName = msg.forward_from_chat.title;
    } else if (msg.forward_from && msg.forward_from.first_name) {
      sourceName = msg.forward_from.first_name;
    }

    const waitMsg = await ctx.reply("⏳ جاري قراءة وتلخيص الرسالة المحولة...");
    const stopTyping = startTyping(ctx);

    try {
      const summary = await summarizeContent(text, {
        isForwarded: true,
        from: sourceName,
      });

      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await sendSafeReply(ctx, summary);
    } catch (err) {
      console.error("خطأ في تلخيص الرسالة المحولة:", err);
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await ctx.reply("❌ عذراً، واجهنا صعوبة في تلخيص هذه الرسالة. يرجى المحاولة بعد لحظات.");
    } finally {
      stopTyping();
    }
    return;
  }

  // 2. إذا كانت رسالة وسائط بدون نص
  if (!text) {
    if (msg.photo || msg.document || msg.voice || msg.video) {
      await ctx.reply("💡 يرجى إرسال نص أو تحويل رسالة نصية أو إرسال رابط قناة لتلخيصها.");
    }
    return;
  }

  // 3. فحص هل المدخل رابط قناة أو معرف تليجرام
  const isChannelPattern =
    /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([a-zA-Z0-9_]{4,})(?:\/\d+)?\/?$/i.test(text) ||
    /^@([a-zA-Z0-9_]{4,})$/.test(text) ||
    (/^\/summary\s+([a-zA-Z0-9_@]+)/i.test(text));

  if (isChannelPattern) {
    const rawUsername = text.replace(/^\/summary\s+/i, "").trim();
    const cleanUsername = extractChannelUsername(rawUsername);

    const statusMsg = await ctx.reply(
      `🔍 جاري جلب منشورات آخر 48 ساعة من قناة *@${cleanUsername}*...`,
      { parse_mode: "Markdown" }
    );
    const stopTyping = startTyping(ctx);

    let channelData;
    try {
      channelData = await fetchChannelPosts(cleanUsername, 48);
    } catch (err) {
      console.error("خطأ في جلب القناة:", err);
      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      const errorMessage = `⚠️ *تعذر جلب منشورات القناة:*\n${err.message || "تأكد من صحة الرابط وأن القناة عامة."}\n\n🔒 *للقنوات الخاصة:* يمكنك ببساطة إعادة توجيه (Forward) المنشورات منها وسألخصها فوراً!`;
      await ctx.reply(errorMessage, { parse_mode: "Markdown" });
      stopTyping();
      return;
    }

    if (!channelData || channelData.messages.length === 0) {
      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      await ctx.reply(
        `ℹ️ لم يتم نشر أي منشورات جديدة في قناة *${channelData?.title || cleanUsername}* خلال آخر 48 ساعة.`,
        { parse_mode: "Markdown" }
      );
      stopTyping();
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `📊 تم استخراج *${channelData.messages.length}* منشوراً من *${channelData.title}*.\n🧠 جاري إنشاء الملخص الذكي بواسطة Gemini...`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    try {
      const summary = await summarizeChannelPosts(
        channelData.title,
        channelData.username,
        channelData.messages
      );

      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      await sendSafeReply(ctx, summary);
    } catch (err) {
      console.error("خطأ في تلخيص القناة بالذكاء الاصطناعي:", err);
      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      await ctx.reply(`⚠️ تم جلب منشورات القناة بنجاح، لكن حدث خطأ أثناء التلخيص: ${err.message || "يرجى المحاولة بعد قليل."}`);
    } finally {
      stopTyping();
    }
    return;
  }

  // 4. نصوص طويلة (أكثر من 50 حرف)
  if (text.length > 50) {
    const waitMsg = await ctx.reply("⏳ جاري قراءة وتلخيص النص بالذكاء الاصطناعي...");
    const stopTyping = startTyping(ctx);

    try {
      const summary = await summarizeContent(text, { isForwarded: false });
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await sendSafeReply(ctx, summary);
    } catch (err) {
      console.error("خطأ في تلخيص النص:", err);
      await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
      await ctx.reply("❌ حدث خطأ أثناء محاولة تلخيص هذا النص. يرجى المحاولة بعد لحظات.");
    } finally {
      stopTyping();
    }
    return;
  }

  // 5. التحقق من الكلمات الفردية بالإنجليزية (قد تكون اسم قناة كُتب بدون @)
  if (/^[a-zA-Z0-9_]{4,32}$/.test(text)) {
    const maybeChannel = text;
    const stopTyping = startTyping(ctx);
    try {
      const channelData = await fetchChannelPosts(maybeChannel, 48);
      if (channelData && channelData.messages.length > 0) {
        const waitMsg = await ctx.reply(
          `📊 تم التعرف على قناة *${channelData.title}* وجلب *${channelData.messages.length}* منشوراً لآخر 48 ساعة.\n🧠 جاري التلخيص...`,
          { parse_mode: "Markdown" }
        );
        const summary = await summarizeChannelPosts(
          channelData.title,
          channelData.username,
          channelData.messages
        );
        await ctx.deleteMessage(waitMsg.message_id).catch(() => {});
        await sendSafeReply(ctx, summary);
        stopTyping();
        return;
      }
    } catch {
      // ليس قناة عامة صالحة
    } finally {
      stopTyping();
    }
  }

  // 6. التحيات والرسائل القصيرة
  const greetings = ["مرحبا", "مرحباً", "السلام عليكم", "سلام", "هلا", "أهلا", "أهلاً", "hi", "hello", "hey"];
  const isGreeting = greetings.some((g) => text.toLowerCase().includes(g));

  if (isGreeting) {
    await ctx.reply(
      `أهلاً بك! 👋\n\nأنا جاهز لمساعدتك في أي وقت:\n• أرسل رابط أو معرف أي قناة عامة (مثل \`@saudioffers0\` أو \`@alarabiya\`) لتلخيص آخر 48 ساعة فيها.\n• أرسل أي نص طويل أو حوّل أي رسالة لتلخيصها فوراً.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // 7. رسالة إرشادية عامة
  await ctx.reply(
    "💡 أرسل رابط أو معرف أي قناة عامة (مثل `@alarabiya`) لتلخيص منشورات آخر 48 ساعة، أو أرسل نصاً طويلاً أو حوّل رسالة لتلخيصها.",
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