const axios = require("axios");
const cheerio = require("cheerio");

/**
 * استخراج اسم القناة النظيف من أي رابط أو معرف
 * @param {string} input 
 * @returns {string|null}
 */
function extractChannelUsername(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // match t.me/s/username or t.me/username or telegram.me/username
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([a-zA-Z0-9_]{4,})/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  // match @username
  const atMatch = trimmed.match(/^@([a-zA-Z0-9_]{4,})$/);
  if (atMatch) {
    return atMatch[1];
  }

  // match pure username if it fits telegram format
  if (/^[a-zA-Z0-9_]{4,}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * جلب منشورات القناة لآخر عدد ساعات محدد (الافتراضي 48 ساعة)
 * @param {string} channelUsername 
 * @param {number} hours 
 * @param {number} maxPages 
 * @returns {Promise<{title: string, username: string, messages: Array<{id: string, text: string, date: Date, timeStr: string}>}>}
 */
async function fetchChannelPosts(channelUsername, hours = 48, maxPages = 5) {
  const cleanUsername = extractChannelUsername(channelUsername);
  if (!cleanUsername) {
    throw new Error("معرف القناة غير صالح.");
  }

  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  let url = `https://t.me/s/${cleanUsername}`;
  let allMessages = [];
  let channelTitle = cleanUsername;
  let pageCount = 0;

  while (url && pageCount < maxPages) {
    pageCount++;
    let response;
    try {
      response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "ar,en;q=0.9",
        },
        timeout: 12000,
      });
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new Error("القناة غير موجودة أو تم حذفها.");
      }
      throw new Error(`تعذر الاتصال بالتليجرام: ${err.message}`);
    }

    const html = response.data;
    const $ = cheerio.load(html);

    // التحقق هل الصفحة لقناة عامة متاحة
    const pageTitle = $("title").text().trim();
    if (pageTitle.includes("Contact @") || html.includes("If you have Telegram, you can contact")) {
      throw new Error("هذا المعرف ليس لقناة عامة متاحة (قد يكون حساب شخصي أو مجموعة مغلقة أو قناة خاصة).");
    }

    const titleEl = $(".tgme_channel_info_header_title");
    if (titleEl.length > 0) {
      channelTitle = titleEl.text().trim();
    }

    const pageMessages = [];
    $(".tgme_widget_message_wrap").each((_, el) => {
      const wrap = $(el);
      const text = wrap.find(".tgme_widget_message_text").text().trim();
      const timeStr = wrap.find("time").attr("datetime");
      const postAttr = wrap.find(".tgme_widget_message").attr("data-post");
      const date = timeStr ? new Date(timeStr) : null;

      if (text) {
        pageMessages.push({
          id: postAttr || "",
          text,
          date,
          timeStr: timeStr || "",
        });
      }
    });

    if (pageMessages.length === 0) {
      break;
    }

    allMessages.unshift(...pageMessages);

    // فحص أقدم رسالة في الصفحة
    const oldestOnPage = pageMessages.find((m) => m.date);
    if (oldestOnPage && oldestOnPage.date < cutoffTime) {
      break;
    }

    // رابط الصفحة السابقة للأقدم
    const prevLink = $("a.tme_messages_more").attr("href");
    if (prevLink) {
      url = `https://t.me${prevLink}`;
    } else {
      break;
    }
  }

  // تصفية وتجريد التكرار
  const uniqueMessagesMap = new Map();
  for (const msg of allMessages) {
    const key = msg.id || `${msg.timeStr}_${msg.text.slice(0, 30)}`;
    uniqueMessagesMap.set(key, msg);
  }
  const uniqueMessages = Array.from(uniqueMessagesMap.values());

  // تصفية المنشورات لتكون فقط خلال آخر 48 ساعة
  const recentMessages = uniqueMessages.filter(
    (m) => !m.date || m.date >= cutoffTime
  );

  return {
    title: channelTitle,
    username: cleanUsername,
    messages: recentMessages,
  };
}

module.exports = {
  extractChannelUsername,
  fetchChannelPosts,
};
