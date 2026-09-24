const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// قائمة النماذج المعتمدة بالترتيب، نبدأ بالأكثر استقراراً وسرعة
const CANDIDATE_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
];

/**
 * تنفيذ استدعاء الذكاء الاصطناعي مع التبديل التلقائي الفوري بين النماذج عند الضغط
 * @param {string} prompt 
 * @returns {Promise<string>}
 */
async function generateWithFallback(prompt) {
  let lastError = null;

  for (const model of CANDIDATE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
      });
      return response.text;
    } catch (err) {
      lastError = err;
      const isOverloaded =
        err.status === 503 ||
        err.status === 429 ||
        (err.message && (
          err.message.includes("503") ||
          err.message.includes("high demand") ||
          err.message.includes("quota") ||
          err.message.includes("RESOURCE_EXHAUSTED") ||
          err.message.includes("UNAVAILABLE")
        ));

      if (isOverloaded) {
        console.warn(`⚠️ ضغط على النموذج ${model}، جاري التبديل الفوري للنموذج البديل...`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("تعذر الحصول على استجابة من نماذج الذكاء الاصطناعي.");
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

  // تجميع المنشورات مع التواريخ (بحد أقصى 50 منشوراً)
  const selectedMessages = messages.slice(0, 50);
  const formattedPosts = selectedMessages
    .map((m, idx) => `[منشور ${idx + 1}] (${m.timeStr || "بدون تاريخ"}):\n${m.text}`)
    .join("\n\n---\n\n");

  const prompt = `أنت محلل محتوى ومحرر إخباري محترف. لديك قائمة بالمنشورات التي نُشرت خلال آخر يومين (48 ساعة) في قناة تليجرام بعنوان "${channelTitle}" (@${channelUsername}).
إجمالي عدد المنشورات المستخرجة: ${selectedMessages.length}.

المطلوب منك:
1. صياغة ملخص احترافي وشامل باللغة العربية الفصحى.
2. تقسيم الملخص بشكل منظم وفق الأقسام التالية:
   - 📌 **ملخص قناة ${channelTitle} (@${channelUsername})**
   - ⏱️ **الفترة المشمولة**: آخر 48 ساعة (تم تحليل ${selectedMessages.length} منشوراً)
   - ⚡ **أبرز العناوين والأحداث العاجلة**: (نقاط لأهم 3 إلى 5 أحداث أو عروض رئيسية)
   - 📂 **التفاصيل مقسمة حسب المواضيع**: (اجمع الأخبار/المعلومات/العروض المترابطة معاً في عناوين فرعية مع نقاط واضحة)
   - 💡 **الخلاصة وأهم النتائج**: سطرين إلى ثلاثة تلخص اتجاه المحتوى في القناة.
3. التزم بالدقة والموضوعية المستندة حصراً على المنشورات الواردة أدناه.
4. استخدم تنسيق Markdown المتوافق مع تليجرام (استخدم **bold** و *italic* والقوائم النقطية).

المنشورات:
${formattedPosts}
`;

  return await generateWithFallback(prompt);
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

  return await generateWithFallback(prompt);
}

module.exports = {
  summarizeChannelPosts,
  summarizeContent,
};
