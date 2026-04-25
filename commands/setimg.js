const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const permissions = require('../utils/permissions');
const { escapeMarkdown } = require('../utils/cardVisuals');

const CARD_TABLES = {
  IDC: {
    table: 'identity_cards',
    label: 'Identity Card'
  },
  PLC: {
    table: 'play_cards',
    label: 'Play Card'
  },
  SKL: {
    table: 'skill_cards',
    label: 'Skill Card'
  },
  WPN: {
    table: 'weapon_cards',
    label: 'Weapon Card'
  }
};

function extractCardId(input) {
  const match = String(input || '').trim().match(/\b(?:IDC|PLC|SKL|WPN)-\d{5}\b/i);
  return match ? match[0].toUpperCase() : null;
}

function getCardConfig(cardId) {
  const prefix = String(cardId || '').split('-')[0].toUpperCase();
  return CARD_TABLES[prefix] || null;
}

async function loadCard(cardId) {
  const config = getCardConfig(cardId);
  if (!config) return null;

  const card = await db.queryOne(
    `SELECT card_id, name FROM ${config.table} WHERE card_id = ?`,
    [cardId]
  );

  if (!card) return null;
  return { ...card, ...config };
}

async function promptForPhoto(bot, chatId, telegramId, card) {
  session.setSession(telegramId, 'setimg', 'awaiting_photo', {
    cardId: card.card_id,
    table: card.table,
    label: card.label,
    cardName: card.name
  });

  await bot.sendMessage(
    chatId,
    `🖼️ ${card.label}: *${escapeMarkdown(card.name)}*\n🆔 \`${card.card_id}\`\n\nدابا صيفط الصورة ديال هاد البطاقة.`,
    { parse_mode: 'Markdown' }
  );
}

function register(bot) {
  bot.onText(/^\$setimg(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    if (!(await permissions.isAdmin(telegramId))) {
      return bot.sendMessage(chatId, '🚫 أدمن فقط.');
    }

    const cardId = extractCardId(match?.[1] || '');

    if (!cardId) {
      session.setSession(telegramId, 'setimg', 'awaiting_card_id');
      return bot.sendMessage(
        chatId,
        '🖼️ صيفط ID ديال البطاقة أولاً.\nمثال: `$setimg IDC-12345` أو صيفط غير `IDC-12345`.',
        { parse_mode: 'Markdown' }
      );
    }

    const card = await loadCard(cardId);
    if (!card) {
      return bot.sendMessage(chatId, `❌ البطاقة \`${cardId}\` غير موجودة.`, { parse_mode: 'Markdown' });
    }

    return promptForPhoto(bot, chatId, telegramId, card);
  });
}

async function handleStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = (msg.text || msg.caption || '').trim();
  const currentSession = session.getSession(telegramId);

  if (currentSession.action !== 'setimg') return false;

  if (!(await permissions.isAdmin(telegramId))) {
    session.clearSession(telegramId);
    await bot.sendMessage(chatId, '🚫 أدمن فقط.');
    return true;
  }

  if (currentSession.step === 'awaiting_card_id') {
    const cardId = extractCardId(text);
    if (!cardId) {
      await bot.sendMessage(chatId, '❌ صيفط ID صالح بحال `IDC-12345`.', { parse_mode: 'Markdown' });
      return true;
    }

    const card = await loadCard(cardId);
    if (!card) {
      await bot.sendMessage(chatId, `❌ البطاقة \`${cardId}\` غير موجودة.`, { parse_mode: 'Markdown' });
      return true;
    }

    await promptForPhoto(bot, chatId, telegramId, card);
    return true;
  }

  if (currentSession.step !== 'awaiting_photo') return false;

  if (!msg.photo || msg.photo.length === 0) {
    await bot.sendMessage(
      chatId,
      `🖼️ ما زلت كنتسنى الصورة ديال \`${currentSession.data.cardId}\`.\nصيفط Photo أو استعمل \`$cancel\`.`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  const fileId = msg.photo[msg.photo.length - 1].file_id;

  await db.query(
    `UPDATE ${currentSession.data.table} SET image_id = ? WHERE card_id = ?`,
    [fileId, currentSession.data.cardId]
  );

  session.clearSession(telegramId);
  await bot.sendMessage(
    chatId,
    `✅ تم حفظ صورة البطاقة \`${currentSession.data.cardId}\` بنجاح.`,
    { parse_mode: 'Markdown' }
  );
  return true;
}

module.exports = { register, handleStep };
