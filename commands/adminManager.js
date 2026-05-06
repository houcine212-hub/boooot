const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const permissions = require('../utils/permissions');

async function grantAdminByPlayerCode(bot, chatId, playerCode, grantedByTelegramId) {
  if (!permissions.isMainAdmin(grantedByTelegramId)) {
    await bot.sendMessage(chatId, ' هذا الأمر مخصص للأدمن الرئيسي فقط.');
    return false;
  }

  const normalizedCode = String(playerCode || '').trim();
  if (!normalizedCode) {
    await bot.sendMessage(chatId, ' أدخل كود لاعب صالح.');
    return false;
  }

  const player = await db.queryOne(
    'SELECT id, telegram_id, character_name, player_code, is_admin, can_manage_cards FROM players WHERE player_code = ?',
    [normalizedCode]
  );

  if (!player) {
    await bot.sendMessage(chatId, ` لم يتم العثور على لاعب بهذا الكود: \`${normalizedCode}\``, { parse_mode: 'Markdown' });
    return false;
  }

  const alreadyAdmin = Boolean(player.is_admin);
  await permissions.grantAdmin(player.telegram_id);

  await bot.sendMessage(
    chatId,
    alreadyAdmin
      ? `ℹ اللاعب *${player.character_name}* (\`${player.player_code}\`) أدمن بالفعل، وتم تأكيد صلاحياته.`
      : ` تم منح *${player.character_name}* (\`${player.player_code}\`) صلاحية الأدمن الكاملة.`,
    { parse_mode: 'Markdown' }
  );
  return true;
}

function register(bot) {
  bot.onText(/^\$addadmin(?:\s+(\S+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للأدمن الرئيسي فقط.');
    }

    const playerCode = match[1]?.trim();
    if (playerCode) {
      return grantAdminByPlayerCode(bot, chatId, playerCode, telegramId);
    }

    session.setSession(telegramId, 'add_admin', 'awaiting_player_code');
    return bot.sendMessage(
      chatId,
      ' أرسل *كود اللاعب* الذي تريد منحه صلاحية الأدمن.\nمثال: `ABC123` أو أي كود لاعب مسجل عندك.',
      { parse_mode: 'Markdown' }
    );
  });
}

async function handleStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const currentSession = session.getSession(telegramId);

  if (currentSession.action !== 'add_admin') return false;

  if (!permissions.isMainAdmin(telegramId)) {
    session.clearSession(telegramId);
    await bot.sendMessage(chatId, ' هذا الأمر مخصص للأدمن الرئيسي فقط.');
    return true;
  }

  const completed = await grantAdminByPlayerCode(bot, chatId, msg.text, telegramId);
  if (completed) {
    session.clearSession(telegramId);
  }
  return true;
}

module.exports = { register, handleStep };