function escapeMarkdown(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/([_*`\[])/g, '\\$1');
}

async function sendCardVisual(bot, chatId, card, caption) {
  if (!card) return null;

  const text = String(caption || '').trim() || `🎴 \`${card.card_id || card.name || 'CARD'}\``;
  const imageId = String(card.image_id || '').trim();

  if (imageId) {
    try {
      return await bot.sendPhoto(chatId, imageId, {
        caption: text,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      console.error(`Card visual photo error (${card.card_id || 'unknown'}):`, err.message);
    }
  }

  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

module.exports = { sendCardVisual, escapeMarkdown };
