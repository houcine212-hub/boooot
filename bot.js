require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db/connection');
const session = require('./middleware/sessionManager');
const permissions = require('./utils/permissions');

// Commands
const aboutCmd = require('./commands/about');
const loginCmd = require('./commands/login');
const panelCmd = require('./commands/panel');
const panelBotCmd = require('./commands/panelBot');
const botLevelFightCmd = require('./commands/botLevelFight');
const fightCmd = require('./commands/fight');
const pvpCmd = require('./commands/pvp');
const lootPvpCmd = require('./commands/lootPvp');
const botCardManager = require('./commands/botCardManager');
const botCardWizard = require('./commands/botCardWizard');
const adminManager = require('./commands/adminManager');
const fastCards = require('./commands/fastCards');
const cancelCmd = require('./commands/cancel');
const removeMessages = require('./commands/removeMessages');
const setImgCmd = require('./commands/setimg');
const statusCmd    = require('./commands/status');
const settitleCmd  = require('./commands/settitle');
const territoryCmd = require('./commands/territory');
const setrankCmd = require('./commands/setrank');
const economyCmd = require('./commands/economyCommands');
const shopCommands = require('./commands/shopCommands');
const craftingCommands = require('./commands/craftingCommands');
const storyManager = require('./commands/storyManager');
const cardCharacter = require('./commands/cardCharacter');

// Handlers
const identityCard = require('./handlers/identityCard');
const botIdentityCard = require('./handlers/botIdentityCard');
const playCard = require('./handlers/playCard');
const botPlayCard = require('./handlers/botPlayCard');
const skillCard = require('./handlers/skillCard');
const botSkillCard = require('./handlers/botSkillCard');
const weaponCard = require('./handlers/weaponCard');
const botWeaponCard = require('./handlers/botWeaponCard');
const cardLookup = require('./handlers/cardLookup');
const botFight = require('./handlers/botFight');
const { readQR } = require('./utils/qrHelper');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

function extractCardId(text) {
  const match = String(text || '').match(/\b(?:IDC|PLC|SKL|WPN)-\d{5}\b/i);
  return match ? match[0].toUpperCase() : null;
}

async function extractCardIdFromPhoto(botInstance, msg) {
  const fileUrl = await botInstance.getFileLink(msg.photo[msg.photo.length - 1].file_id);
  const https = require('https');
  const imageBuffer = await new Promise((resolve, reject) => {
    https.get(fileUrl, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
  });

  const decoded = await readQR(imageBuffer);
  if (!decoded) return null;
  return extractCardId(decoded);
}

(async () => {
  try {
    await db.initDatabase();
    console.log('Bot running...');
  } catch (err) {
    console.error('DB init failed:', err.message);
    process.exit(1);
  }
})();

loginCmd.register(bot);
panelCmd.register(bot);
panelBotCmd.register(bot);
botLevelFightCmd.register(bot);
fightCmd.register(bot);
botCardManager.register(bot);
botCardWizard.register(bot);
adminManager.register(bot);
fastCards.register(bot);
cancelCmd.register(bot);
removeMessages.register(bot);
setImgCmd.register(bot);
statusCmd.register(bot);
settitleCmd.register(bot);
territoryCmd.register(bot);
aboutCmd.register(bot);
setrankCmd.register(bot);
economyCmd.register(bot);
shopCommands.register(bot);
craftingCommands.register(bot);
storyManager.register(bot);
cardCharacter.register(bot);

bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid = from.id;

  await bot.answerCallbackQuery(query.id);
  if (data.startsWith('about_')) return aboutCmd.handleCallback(bot, query);
  if (data.startsWith('shop_') || data.startsWith('spin_')) return shopCommands.handleCallback(bot, query);
  if (data.startsWith('forge_')) return craftingCommands.handleForgeCallback(bot, query);
  if (data.startsWith('loot_')) return lootPvpCmd.handleLootCallback(bot, query); 
  if (data.startsWith('fight_')) return fightCmd.handleFightCallback(bot, query);
  if (data.startsWith('pvp_')) return pvpCmd.handlePvpCallback(bot, query);
  if (data.startsWith('bcm_')) return botCardManager.handleCallback(bot, query);
  if (data.startsWith('story_choice_')) return storyManager.handleChoiceCallback(bot, query);
  if (data.startsWith('story_battle_')) return storyManager.handleBattleCallback(bot, query);
  if (data.startsWith('mc_type_')) return await storyManager.handleMonsterCardTypeCallback(bot, query);
  if (data.startsWith('mc_plctype_')) return await storyManager.handleMonsterCardPlcTypeCallback(bot, query);
  // أزرار صناعة شخصيات الأنمي
  if (data.startsWith('cc_type_')) return await cardCharacter.handleCardTypeCallback(bot, query);
  if (data.startsWith('cc_plctype_')) return await cardCharacter.handlePlcTypeCallback(bot, query);
  if (data.startsWith('cc_skltype_')) return await cardCharacter.handleSklTypeCallback(bot, query);
  if (data.startsWith('cc_skldur_')) return await cardCharacter.handleSklDurCallback(bot, query);
  if (data === 'panel_identity') return identityCard.startIdentityCardCreation(bot, chatId, tid);
  if (data === 'panel_play') return playCard.startPlayCardCreation(bot, chatId, tid);
  if (data === 'panel_skill') return skillCard.startSkillCardCreation(bot, chatId, tid);
  if (data === 'panel_weapon') return weaponCard.startWeaponCardCreation(bot, chatId, tid);
  if (data === 'panelbot_identity') return botIdentityCard.startBotIdentityCardCreation(bot, chatId, tid);
  if (data === 'panelbot_play') return botPlayCard.startBotPlayCardCreation(bot, chatId, tid);
  if (data === 'panelbot_skill') return botSkillCard.startBotSkillCardCreation(bot, chatId, tid);
  if (data === 'panelbot_weapon') return botWeaponCard.startBotWeaponCardCreation(bot, chatId, tid);

  if (data.startsWith('playtype_')) return playCard.handlePlayCardTypeSelection(bot, chatId, tid, data.replace('playtype_', ''));
  if (data.startsWith('skilltype_')) return skillCard.handleSkillTypeSelection(bot, chatId, tid, data.replace('skilltype_', ''));
  if (data.startsWith('skilldur_')) return skillCard.handleSkillDurationSelection(bot, chatId, tid, data.replace('skilldur_', ''));
  if (data.startsWith('weapontype_')) return weaponCard.handleWeaponTypeSelection(bot, chatId, tid, data.replace('weapontype_', ''));
  if (data.startsWith('weaponsub_')) return weaponCard.handleWeaponSubTypeSelection(bot, chatId, tid, data.replace('weaponsub_', ''));
  if (data.startsWith('weaponboost_')) return weaponCard.handleWeaponBoostTargetSelection(bot, chatId, tid, data.replace('weaponboost_', ''));
  if (data.startsWith('weapondur_')) return weaponCard.handleWeaponDurationSelection(bot, chatId, tid, data.replace('weapondur_', ''));
  if (data.startsWith('panelbot_playtype_')) return botPlayCard.handleBotPlayCardTypeSelection(bot, chatId, tid, data.replace('panelbot_playtype_', ''));
  if (data.startsWith('panelbot_skilltype_')) return botSkillCard.handleBotSkillTypeSelection(bot, chatId, tid, data.replace('panelbot_skilltype_', ''));
  if (data.startsWith('panelbot_skilldur_')) return botSkillCard.handleBotSkillDurationSelection(bot, chatId, tid, data.replace('panelbot_skilldur_', ''));
  if (data.startsWith('panelbot_weapontype_')) return botWeaponCard.handleBotWeaponTypeSelection(bot, chatId, tid, data.replace('panelbot_weapontype_', ''));
  if (data.startsWith('panelbot_weaponsub_')) return botWeaponCard.handleBotWeaponSubTypeSelection(bot, chatId, tid, data.replace('panelbot_weaponsub_', ''));
  if (data.startsWith('panelbot_weaponboost_')) return botWeaponCard.handleBotWeaponBoostTargetSelection(bot, chatId, tid, data.replace('panelbot_weaponboost_', ''));
  if (data.startsWith('panelbot_weapondur_')) return botWeaponCard.handleBotWeaponDurationSelection(bot, chatId, tid, data.replace('panelbot_weapondur_', ''));
  
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const tid = msg.from.id;
  // FIX 4: changed const → let so we can update text if a QR is decoded mid-session
  let text = (msg.text || msg.caption || '').trim();

  const hasLink = /(https?:\/\/|www\.|t\.me\/)/i.test(text);
  if (hasLink && !(await permissions.isAdmin(tid))) {
    try {
      await bot.deleteMessage(chatId, msg.message_id);
      return;
    } catch (err) {
      console.error('Delete error:', err.message);
    }
  }

  if (msg.photo) {
    const activeSession = session.hasActiveSession(tid)
      ? session.getSession(tid)
      : null;

    if (activeSession?.action === 'setimg') {
      return setImgCmd.handleStep(bot, msg);
    }

    try {
      const decodedCardId = await extractCardIdFromPhoto(bot, msg);

      // 1. التوجيه للمضاربات (Fights)
      if (activeSession?.action === 'bot_fight') {
        if (!decodedCardId) return bot.sendMessage(chatId, '⚠️ لم أتمكن من قراءة البطاقة من الصورة.');
        return botFight.handleFightMessage(bot, msg, decodedCardId);
      }
      if (activeSession?.action === 'pvp_fight') {
        if (!decodedCardId) return bot.sendMessage(chatId, '⚠️ لم أتمكن من قراءة البطاقة من الصورة.');
        return pvpCmd.handleFightMessage(bot, msg, decodedCardId);
      }
      if (activeSession?.action === 'loot_fight') {
        if (!decodedCardId) return bot.sendMessage(chatId, '⚠️ لم أتمكن من قراءة البطاقة من الصورة.');
        return lootPvpCmd.handleFightMessage(bot, msg, decodedCardId);
      }

      // 2. التوجيه للـ Wizards (صناعة الكوارط)
      if (activeSession?.action === 'monster_card') {
        if (!decodedCardId) return; // صور عادية بلا QR نتجاهلوها هنا
        msg.text = decodedCardId;
        return await storyManager.handleMonsterCardStep(bot, msg);
      }

      // 3. السيسشنز العادية (باقي الأنواع)
      if (activeSession) {
        if (!decodedCardId) return;
        msg.text = decodedCardId;
        text = decodedCardId;
      } else {
        // البحث العادي خارج أي سيسشن
        if (!decodedCardId) return bot.sendMessage(chatId, '⚠️ لم أتمكن من قراءة QR Code.');
        return cardLookup.lookupCard(bot, chatId, decodedCardId);
      }
    } catch (err) {
      console.error('QR scan error:', err.message);
      return bot.sendMessage(chatId, '⚠️ خطأ أثناء قراءة الصورة.');
    }
  }

  if (!text || text.startsWith('$')) return;

  if (chatId === fightCmd.FIGHT_GROUP_ID && botFight.hasFight(chatId)) {
    const fight = botFight.getFight(chatId);
    if (fight && tid !== fight.playerTelegramId && !(await permissions.isAdmin(tid))) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch {}
      return;
    }
  }

  // --- معالجة الجلسات النشطة (Sessions) ---
  if (session.hasActiveSession(tid)) {
    const { action } = session.getSession(tid);
    const sessionCardId = extractCardId(text); 

    try {
      if (action === 'login') return await loginCmd.handleLoginStep(bot, msg);
      if (action === 'identity_card') return await identityCard.handleIdentityCardStep(bot, msg);
      if (action === 'bot_identity_card') return await botIdentityCard.handleBotIdentityCardStep(bot, msg);
      if (action === 'play_card') return await playCard.handlePlayCardStep(bot, msg);
      if (action === 'bot_play_card') return await botPlayCard.handleBotPlayCardStep(bot, msg);
      if (action === 'skill_card') return await skillCard.handleSkillCardStep(bot, msg);
      if (action === 'bot_skill_card') return await botSkillCard.handleBotSkillCardStep(bot, msg);
      if (action === 'weapon_card') return await weaponCard.handleWeaponCardStep(bot, msg);
      if (action === 'bot_weapon_card') return await botWeaponCard.handleBotWeaponCardStep(bot, msg);
      if (action === 'newbotcard') return await botCardWizard.handleStep(bot, msg);
      if (action === 'add_admin') return await adminManager.handleStep(bot, msg);
      if (action === 'fast_player_cards' || action === 'fast_bot_cards') return await fastCards.handleStep(bot, msg);
      if (action === 'bot_fight') return await botFight.handleFightMessage(bot, msg, sessionCardId);
      if (action === 'pvp_fight') return await pvpCmd.handleFightMessage(bot, msg, sessionCardId);
      if (action === 'setcardbot') return await botCardManager.handleStep(bot, msg, sessionCardId);
      // نزال النهب (Loot PvP)
      if (action === 'awaiting_stakes') return await lootPvpCmd.handleStakesInput(bot, msg);
      if (action === 'loot_fight') return await lootPvpCmd.handleFightMessage(bot, msg, sessionCardId);
      if (action === 'monster_card') return await storyManager.handleMonsterCardStep(bot, msg);
      if (action === 'setimg') return await setImgCmd.handleStep(bot, msg);
      if (action === 'use_enhancer') return await shopCommands.handleUseStep(bot, msg);
      if (action === 'char_card_wizard') return await cardCharacter.handleCharCardStep(bot, msg);
      
      // حماية: إذا كان هناك سيسشن، نخرج دائماً هنا لكي لا نصل للـ Lookup
      return; 
    } catch (err) {
      console.error(`Error in session (${action}):`, err.message);
      return;
    }
  }

  // --- البحث العام عن البطاقات (فقط إذا لم يكن هناك سيسشن) ---
  const globalCardId = extractCardId(text);
  if (globalCardId) return cardLookup.lookupCard(bot, chatId, globalCardId);
});
// 🔍 TEMP: log chat ID for every group message
bot.on('message', (msg) => {
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    console.log(`📌 Group: ${msg.chat.title} | ID: ${msg.chat.id}`);
  }
});
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));