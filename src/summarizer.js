const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const MODEL_NAME = "gemini-3-flash-preview";

/**
 * تنفيذ استدعاء الذكاء الاصطناعي مع إعادة المحاولة تلقائياً عند الضغط أو أخطاء 503/429
 * @param {string} prompt 
 * @param {number} retries 
 * @param {number} delayMs 
 * @returns {Promise<string>}
 */
async function generateWithRetry(prompt, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          thinkingConfig: {
            thinkingBudget: 0, // تسريع التلخيص الفوري بدون انتظار تفكير داخلي
          },
        },
      });
      return response.text;
    } catch (err) {
      const isRetryable =
        err.status === 503 ||
        err.status === 429 ||
        (err.message && (err.message.includes("503") || err.message.includes("high demand") || err.message.includes("quota")));

      if (isRetryable && attempt < retries) {
        console.warn(`⚠️ ضغط مؤقت على النموذج، جاري إعادة المحاولة (${attempt}/${retries}) بعد ${delayMs}ms...`);
        await new Promise((res) => setTimeout(res, delayMs));
        delayMs *= 1.5;
        continue;
      }
      throw err;
    }
  }
}

/**
 * تلخيص منشورات قناة تليجرام لآخر 48 ساعة
 * @param {string} channelTitle 
 * @param {string} channelUsername 
 * @param {Array<{text: string, timeStr: string}>} messages 
 * @returns {Promise<string>}
 */
async function summarizeChannelPosts(channelTitle, channelUsername, messages) {
  if (!messages || messages.length === 0) {
    return "لم يتم العثور على أي منشورات جديدة في هذه القناة خلال آخر 48 ساعة.";
  }

  // تجميع المنشورات مع التواريخ
  const formattedPosts = messages
    .map((m, idx) => `[منشور ${idx + 1}] (${m.timeStr || "بدون تاريخ"}):\n${m.text}`)
    .join("\n\n---\n\n");

  const prompt = `أنت محلل محتوى ومحرر إخباري محترف. لديك قائمة بالمنشورات التي نُشرت خلال آخر يومين (48 ساعة) في قناة تليجرام بعنوان "${channelTitle}" (@${channelUsername}).
إجمالي عدد المنشورات المستخرجة: ${messages.length}.

المطلوب منك:
1. صياغة ملخص احترافي وشامل باللغة العربية الفصحى.
2. تقسيم الملخص بشكل منظم وفق الأقسام التالية:
   - 📌 **ملخص قناة ${channelTitle} (@${channelUsername})**
   - ⏱️ **الفترة المشمولة**: آخر 48 ساعة (تم تحليل ${messages.length} منشوراً)
   - ⚡ **أبرز العناوين والأحداث العاجلة**: (نقاط لأهم 3 إلى 5 أحداث رئيسية)
   - 📂 **التفاصيل مقسمة حسب المواضيع**: (اجمع الأخبار/المعلومات المترابطة معاً في عناوين فرعية مع نقاط واضحة)
   - 💡 **الخلاصة وأهم النتائج**: سطرين إلى ثلاثة تلخص اتجاه المحتوى في القناة.
3. التزم بالدقة والموضوعية المستندة حصراً على المنشورات الواردة أدناه.
4. استخدم تنسيق Markdown المتوافق مع تليجرام (استخدم **bold** و *italic* والقوائم النقطية).

المنشورات:
${formattedPosts}
`;

  return await generateWithRetry(prompt);
}

/**
 * تلخيص نص عادي أو رسالة محولة
 * @param {string} content 
 * @param {object} [metadata] 
 * @returns {Promise<string>}
 */
async function summarizeContent(content, metadata = {}) {
  const sourceHint = metadata.isForwarded
    ? `هذه رسالة مُعاد توجيهها (Forwarded Message)${metadata.from ? ` من: ${metadata.from}` : ""}.`
    : "هذا نص أرسله المستخدم.";

  const prompt = `أنت مساعد ذكي متميز في تلخيص واستيعاب النصوص.
${sourceHint}

المطلوب:
1. قراءة المحتوى بعناية وتقديم تلخيص ذكي ومنظم باللغة العربية الفصحى.
2. البدء بـ:
   - 📋 **ملخص المحتوى**
   - 🎯 **الفكرة العامة الأساسية**
   - 🔹 **أهم النقاط والتفاصيل الرئيسية** (على شكل نقاط نقطية واضحة)
   - 💡 **الخلاصة أو التوصيات** (إن وجدت)
3. نسق الإجابة بتنسيق Markdown أنيق وواضح للقراءة على تطبيق تليجرام.

المحتوى:
${content}
`;

  return await generateWithRetry(prompt);
}

module.exports = {
  summarizeChannelPosts,
  summarizeContent,
};
