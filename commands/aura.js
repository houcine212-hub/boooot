'use strict';

const db = require('../db/connection');
const rankSystem = require('../utils/rankSystem');

// Map to store active auras: chatId -> { telegramId, rank, name, msgCount }
const activeAuras = new Map();

// ─── Visuals & Aesthetics ─────────────────────────────────────────────────────

const EFFECTS = {
  overlord: {
    entry: ' *السماء تظلم... الجاذبية تزداد ثقلاً...*\n\nالـ **OVERLORD** قد وطئ أرض هذه المدينة.\nالصمت الآن إجباري.',
    exit: ' *الضغط يتلاشى ببطء...*\n\nالـ **OVERLORD** غادر المكان. يمكنكم التنفس الآن.',
    wrapper: (text) => `\`\`\`text\n[ 𝕿ＨＥ  ＯＶＥＲＬＯＲＤ ]\n\n❝ ${text} ❞\n\`\`\``
  },
  emperor: {
    entry: ' *الأبواق تدق... ترتجف الأرض إجلالاً...*\n\n**الإمبراطور** شرف هذه الأراضي.\nيُمنع النطق في حضرة جلالته.',
    exit: ' *الموكب الإمبراطوري يغادر...*\n\n**الإمبراطور** غادر المكان. رُفع حظر الكلام.',
    wrapper: (text) => `\`\`\`text\n[ ＩＭＰＥＲＩＡＬ  ＤＥＣＲＥＥ ]\n\n ${text} \n\`\`\``
  }
};

function register(bot) {

  // ─── Command: $aura ────────────────────────────────────────────────────────
  bot.onText(/^\$aura$/i, async (msg) => {
    const chatId = msg.chat.id;
    const tid = msg.from.id;

    // 1. التحقق من الرتبة (Overlord أو Emperor فقط)
    const rank = await rankSystem.getEffectiveRank(tid);
    if (rank !== 'overlord' && rank !== 'emperor') {
      // تجاهل بصمت، أو احذف الرسالة لكي لا يعرف العوام بوجود هذا الأمر
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }

    // احذف رسالة الأمر ليبقى الأمر سرياً وأنيقاً
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

    const currentAura = activeAuras.get(chatId);

    // إذا كانت الهالة مفعلة مسبقاً من طرف هذا الشخص
    if (currentAura && currentAura.telegramId === tid) {
      return bot.sendMessage(chatId, ' *هالتك الملكية تملأ المكان بالفعل.* هل تريد سحبها؟', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'سحب الهالة', callback_data: `aura_off_${tid}` },
            { text: 'إلغاء', callback_data: `aura_cancel_${tid}` }
          ]]
        }
      });
    }

    // إذا كان هناك إمبراطور آخر أو أوفرلورد مفعل الهالة هنا
    if (currentAura && currentAura.telegramId !== tid) {
      return bot.sendMessage(chatId, ` المجال مغلق بهالة *${currentAura.name}*. لا يمكنك إطلاق هالتك هنا الآن.`);
    }

    // إطلاق الهالة
    return bot.sendMessage(chatId, ' *تستعد لإطلاق هالتك التي ستسكت الجميع.* تأكيد؟', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: ' AURA MODE ', callback_data: `aura_on_${tid}` },
          { text: ' NORMAL MODE', callback_data: `aura_cancel_${tid}` }
        ]]
      }
    });
  });
}

// ─── Callback Handler ─────────────────────────────────────────────────────────
async function handleCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid = from.id;

  const match = data.match(/^aura_(on|off|cancel)_(\d+)$/);
  if (!match) return false;

  const action = match[1];
  const ownerTid = parseInt(match[2], 10);

  if (tid !== ownerTid) {
    return bot.answerCallbackQuery(query.id, { text: 'هذا الخيار ليس لك.', show_alert: true });
  }

  // إخفاء رسالة الأزرار
  try { await bot.deleteMessage(chatId, message.message_id); } catch {}

  if (action === 'cancel') return true;

  const player = await db.queryOne('SELECT character_name FROM players WHERE telegram_id = ?', [tid]);
  const rank = await rankSystem.getEffectiveRank(tid);
  const visuals = EFFECTS[rank];

  if (action === 'on') {
    activeAuras.set(chatId, {
      telegramId: tid,
      rank: rank,
      name: player ? player.character_name : 'الكيان الأعلى'
    });

    await bot.sendMessage(chatId, visuals.entry, { parse_mode: 'Markdown' });
    return true;
  }

  if (action === 'off') {
    activeAuras.delete(chatId);
    await bot.sendMessage(chatId, visuals.exit, { parse_mode: 'Markdown' });
    return true;
  }

  return true;
}

// ─── Middleware: Message Interceptor ──────────────────────────────────────────
async function handleAuraMessage(bot, msg) {
  const chatId = msg.chat.id;
  const tid = msg.from.id;

  if (!activeAuras.has(chatId)) return false; // لا توجد هالة مفعلة هنا

  const aura = activeAuras.get(chatId);

  // 1. إذا كان المرسل شخصاً عادياً (ليس صاحب الهالة)
  if (tid !== aura.telegramId) {
    // اسكت العوام (حذف رسالتهم)
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    return true; // أوقف معالجة الرسالة في النظام
  }

  // 2. إذا كان المرسل هو صاحب الهالة العظيمة
  const text = msg.text || msg.caption;
  
  // تجاهل الأوامر التي تبدأ بـ $ (لكي تعمل أوامر النظام العادية)
  if (!text || text.startsWith('$')) return false; 

  const visuals = EFFECTS[aura.rank];

  // احذف رسالته العادية
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  // أرسلها بالشكل الملكي/المرعب
  await bot.sendMessage(chatId, visuals.wrapper(text), { parse_mode: 'Markdown' });
  return true; // أوقف المعالجة العادية لكي لا يقرأ البوت الرسالة مرتين
}

module.exports = { register, handleCallback, handleAuraMessage };