/**
 * دالة لتقسيم الرسائل الطويلة لتفادي حد الـ 4096 حرف في تليجرام
 * @param {string} text 
 * @param {number} maxLength 
 * @returns {string[]}
 */
function splitMessage(text, maxLength = 3800) {
  if (!text || typeof text !== "string") {
    return [""];
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // البحث عن أفضل مكان للتقسيم (سطرين فارغين، سطر، مسافة)
    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

module.exports = {
  splitMessage,
};
