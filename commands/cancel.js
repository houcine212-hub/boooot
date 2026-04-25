const session = require('../middleware/sessionManager');
const permissions = require('../utils/permissions');
const botFight = require('../handlers/botFight');
const pvpFight = require('../commands/pvp');

const ACTION_LABELS = {
  login: '📝 تسجيل الدخول',
  identity_card: '🎭 إنشاء بطاقة تعريفية',
  bot_identity_card: '🤖 إنشاء بطاقة تعريفية للبوت',
  play_card: '⚔️ إنشاء بطاقة لعب',
  bot_play_card: '🤖 إنشاء بطاقة لعب للبوت',
  skill_card: '🌟 إنشاء بطاقة مهارة',
  bot_skill_card: '🤖 إنشاء بطاقة مهارة للبوت',
  weapon_card: '🗡️ إنشاء بطاقة سلاح',
  bot_weapon_card: '🤖 إنشاء بطاقة سلاح للبوت',
  newbotcard: '🤖 إنشاء مجموعة بطاقات بوت',
  fast_player_cards: '🧪 إنشاء مجموعة تجريبية للاعب',
  fast_bot_cards: '🤖 إنشاء مجموعة بوت تجريبية',
  setcardbot: '🔗 ربط بطاقة ببوت',
  bot_fight: '⚔️ نزال مع KimiBot',
  pvp_fight: '🤝 Friendly PvP'
};

function register(bot) {
  bot.onText(/^\$cancel$/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const isAdmin = await permissions.isAdmin(telegramId);

    const cancelled = [];

    if (session.hasActiveSession(telegramId)) {
      const { action } = session.getSession(telegramId);
      session.clearSession(telegramId);
      cancelled.push(ACTION_LABELS[action] || `Session (${action})`);
    }

    if (botFight.hasFight(chatId)) {
      const fight = botFight.getFight(chatId);
      const isParticipant = fight && fight.playerTelegramId === telegramId;

      if (isAdmin || isParticipant) {
        botFight.cancelFight(chatId);

        if (fight && fight.playerTelegramId !== telegramId) {
          session.clearSession(fight.playerTelegramId);
        }

        cancelled.push('⚔️ نزال مع KimiBot');
      }
    }

    if (pvpFight.hasPendingChallenge(chatId)) {
      const challenge = pvpFight.getPendingChallenge(chatId);
      const isParticipant = pvpFight.isChallengeParticipant(challenge, telegramId);

      if (isAdmin || isParticipant) {
        const cancelledChallenge = pvpFight.cancelPendingChallenge(chatId);

        if (cancelledChallenge?.requestMessageId) {
          try {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: chatId, message_id: cancelledChallenge.requestMessageId }
            );
          } catch {}
        }

        cancelled.push('🤝 تحدي Friendly PvP');
      }
    }

    if (pvpFight.hasFight(chatId)) {
      const fight = pvpFight.getFight(chatId);
      const isParticipant = pvpFight.isFightParticipant(fight, telegramId);

      if (isAdmin || isParticipant) {
        pvpFight.cancelFight(chatId);
        cancelled.push('🤝 Friendly PvP');
      }
    }

    if (cancelled.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ لا توجد عملية جارية لإلغائها.');
    }

    const list = cancelled.map(label => `• ${label}`).join('\n');
    return bot.sendMessage(
      chatId,
      `✅ *تم الإلغاء بنجاح!*\n\n${list}\n\n_يمكنك البدء من جديد في أي وقت._`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { register };
