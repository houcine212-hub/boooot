/**
 * commands/admin/setTutorialBoss.js
 *
 * Registers the $setTutorialBoss admin command.
 *
 * ─── SYNTAX ──────────────────────────────────────────────────────────────────
 *
 *   $setTutorialBoss[BossType] | [IDC] | [PLC1,PLC2,...] | [SKL1,SKL2,...] | [WPN1,WPN2,...]
 *
 *   • BossType   — 'nitron' or 'monster_x'  (case-insensitive)
 *   • IDC        — exactly one identity-card ID (IDC-XXXXX)
 *   • PLCn       — comma-separated play-card IDs (PLC-XXXXX)
 *   • SKLn       — comma-separated skill-card IDs (SKL-XXXXX)  [optional segment]
 *   • WPNn       — comma-separated weapon-card IDs (WPN-XXXXX) [optional segment]
 *
 *   Segments 4 and 5 are optional; omit them or leave them blank.
 *
 * ─── EXAMPLES ────────────────────────────────────────────────────────────────
 *
 *   $setTutorialBoss nitron | IDC-00099 | PLC-00011,PLC-00012 | SKL-00005
 *   $setTutorialBoss monster_x | IDC-00100 | PLC-00020 | SKL-00010 | WPN-00003
 *   $setTutorialBoss nitron | IDC-00099 | PLC-00011 |            (no SKL/WPN)
 *
 * ─── PERMISSIONS ─────────────────────────────────────────────────────────────
 *   Only Telegram user IDs listed in ADMIN_IDS (env var or config) may use this.
 */

'use strict';

const db      = require('../../db/connection');
const permissions = require('../../utils/permissions');          // { adminIds: [123, 456, ...] }

// ── Allowed boss types ────────────────────────────────────────────────────────
const VALID_BOSS_TYPES = new Set(['nitron', 'monster_x']);

// ── Card-ID prefix → expected type name (for validation feedback) ────────────
const PREFIX_MAP = {
  'IDC-': 'IDC',
  'PLC-': 'PLC',
  'SKL-': 'SKL',
  'WPN-': 'WPN',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Return true if a card ID matches the expected prefix. */
function matchesPrefix(cardId, prefix) {
  return typeof cardId === 'string' && cardId.toUpperCase().startsWith(prefix);
}

/**
 * Parse a comma-separated segment into a trimmed array of non-empty strings.
 * Returns [] if the segment is blank or absent.
 */
function parseIds(segment = '') {
  return segment
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Verify that every ID in `ids` starts with `expectedPrefix`.
 * Returns an array of offending IDs (empty = all OK).
 */
function findWrongPrefix(ids, expectedPrefix) {
  return ids.filter(id => !matchesPrefix(id, expectedPrefix));
}

/**
 * Look up each card ID in its respective table and return the ones that are
 * missing from the DB.  This catches typos before we write anything.
 *
 * tableMap: { 'IDC-': 'identity_cards', 'PLC-': 'play_cards', ... }
 */
async function findMissingCards(cardIds, tableName) {
  if (cardIds.length === 0) return [];
  const placeholders = cardIds.map(() => '?').join(', ');
  const found = await db.query(
    `SELECT card_id FROM ${tableName} WHERE card_id IN (${placeholders})`,
    cardIds
  );
  const foundSet = new Set(found.map(r => r.card_id));
  return cardIds.filter(id => !foundSet.has(id));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Command registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the $setTutorialBoss command on the bot instance.
 * Call this once during bot startup (e.g. in your commands/index.js loader).
 *
 * @param {TelegramBot} bot  — node-telegram-bot-api instance
 */
function register(bot) {
  // Match: $setTutorialBoss  <anything>
  // The full argument parsing happens inside the handler.
  bot.onText(/^\$setTutorialBoss(.*)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    // ── 1. Permission check ───────────────────────────────────────────────────
   // التحقق باستعمال سيستيم permissions اللي عندك
    if (!(await permissions.isAdmin(telegramId))) {
      return bot.sendMessage(chatId,
        '🚫 هذا الأمر متاح للمشرفين فقط.',
        { parse_mode: 'Markdown' }
      );
    }

    // ── 2. Raw argument extraction ────────────────────────────────────────────
    //  match[1] is everything after "$setTutorialBoss"
    //  e.g. " nitron | IDC-00099 | PLC-00011,PLC-00012 | SKL-00005"
    const rawArgs = (match[1] || '').trim();

    if (!rawArgs) {
      return bot.sendMessage(chatId, buildUsageMessage(), { parse_mode: 'Markdown' });
    }

    // Split on '|' — we expect 3 to 5 segments
    const segments = rawArgs.split('|').map(s => s.trim());

    if (segments.length < 3) {
      return bot.sendMessage(chatId,
        `❌ *صيغة غير صحيحة.* يجب تقديم على الأقل: BossType | IDC | PLC\n\n${buildUsageMessage()}`,
        { parse_mode: 'Markdown' }
      );
    }

    const [bossTypeRaw, idcRaw, plcRaw, sklRaw = '', wpnRaw = ''] = segments;

    // ── 3. Validate boss type ─────────────────────────────────────────────────
    const bossType = bossTypeRaw.toLowerCase().replace(/\s+/g, '_');
    if (!VALID_BOSS_TYPES.has(bossType)) {
      return bot.sendMessage(chatId,
        `❌ نوع البوس غير صالح: \`${bossTypeRaw}\`\n` +
        `الأنواع المسموح بها: \`nitron\` أو \`monster_x\``,
        { parse_mode: 'Markdown' }
      );
    }

    // ── 4. Parse card lists ───────────────────────────────────────────────────
    const idcList = parseIds(idcRaw);
    const plcList = parseIds(plcRaw);
    const sklList = parseIds(sklRaw);
    const wpnList = parseIds(wpnRaw);

    // ── 5. Structural validation ──────────────────────────────────────────────
    const errors = [];

    // IDC: must be exactly one
    if (idcList.length !== 1) {
      errors.push(`• يجب تقديم بطاقة تعريفية واحدة بالضبط (IDC). وجدت: ${idcList.length}`);
    } else if (!matchesPrefix(idcList[0], 'IDC-')) {
      errors.push(`• البطاقة التعريفية يجب أن تبدأ بـ IDC- : \`${idcList[0]}\``);
    }

    // PLC: at least one required
    if (plcList.length === 0) {
      errors.push('• يجب تقديم بطاقة تشغيل واحدة على الأقل (PLC).');
    } else {
      const bad = findWrongPrefix(plcList, 'PLC-');
      if (bad.length > 0) {
        errors.push(`• بطاقات PLC خاطئة البادئة: ${bad.map(id => `\`${id}\``).join(', ')}`);
      }
    }

    // SKL: if provided, prefix must match
    if (sklList.length > 0) {
      const bad = findWrongPrefix(sklList, 'SKL-');
      if (bad.length > 0) {
        errors.push(`• بطاقات SKL خاطئة البادئة: ${bad.map(id => `\`${id}\``).join(', ')}`);
      }
    }

    // WPN: if provided, prefix must match
    if (wpnList.length > 0) {
      const bad = findWrongPrefix(wpnList, 'WPN-');
      if (bad.length > 0) {
        errors.push(`• بطاقات WPN خاطئة البادئة: ${bad.map(id => `\`${id}\``).join(', ')}`);
      }
    }

    if (errors.length > 0) {
      return bot.sendMessage(chatId,
        `❌ *أخطاء في الإدخال:*\n\n${errors.join('\n')}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── 6. DB existence checks ────────────────────────────────────────────────
    await bot.sendMessage(chatId, '🔍 جارٍ التحقق من وجود البطاقات في قاعدة البيانات...', { parse_mode: 'Markdown' });

    const dbErrors = [];

    const missingIdc = await findMissingCards(idcList, 'identity_cards');
    if (missingIdc.length > 0) {
      dbErrors.push(`• بطاقات IDC غير موجودة: ${missingIdc.map(id => `\`${id}\``).join(', ')}`);
    }

    const missingPlc = await findMissingCards(plcList, 'play_cards');
    if (missingPlc.length > 0) {
      dbErrors.push(`• بطاقات PLC غير موجودة: ${missingPlc.map(id => `\`${id}\``).join(', ')}`);
    }

    if (sklList.length > 0) {
      const missingSkl = await findMissingCards(sklList, 'skill_cards');
      if (missingSkl.length > 0) {
        dbErrors.push(`• بطاقات SKL غير موجودة: ${missingSkl.map(id => `\`${id}\``).join(', ')}`);
      }
    }

    if (wpnList.length > 0) {
      const missingWpn = await findMissingCards(wpnList, 'weapon_cards');
      if (missingWpn.length > 0) {
        dbErrors.push(`• بطاقات WPN غير موجودة: ${missingWpn.map(id => `\`${id}\``).join(', ')}`);
      }
    }

    if (dbErrors.length > 0) {
      return bot.sendMessage(chatId,
        `❌ *بطاقات غير موجودة في قاعدة البيانات:*\n\n${dbErrors.join('\n')}\n\n` +
        `تأكد من أن جميع IDs صحيحة وموجودة قبل المتابعة.`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── 7. Upsert into tutorial_boss_cards ───────────────────────────────────
    try {
      await db.query(
        `INSERT INTO tutorial_boss_cards
           (boss_type, idc_card_id, plc_ids, skl_ids, wpn_ids, set_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           idc_card_id = VALUES(idc_card_id),
           plc_ids     = VALUES(plc_ids),
           skl_ids     = VALUES(skl_ids),
           wpn_ids     = VALUES(wpn_ids),
           set_by      = VALUES(set_by),
           set_at      = CURRENT_TIMESTAMP`,
        [
          bossType,
          idcList[0],
          JSON.stringify(plcList),
          JSON.stringify(sklList),
          JSON.stringify(wpnList),
          telegramId,
        ]
      );
    } catch (err) {
      console.error('[setTutorialBoss] DB error:', err);
      return bot.sendMessage(chatId,
        '❌ حدث خطأ أثناء الحفظ في قاعدة البيانات. تحقق من السجلات.',
        { parse_mode: 'Markdown' }
      );
    }

    // ── 8. Success confirmation ───────────────────────────────────────────────
    const bossLabel     = bossType === 'nitron' ? '⚡ Nitron' : '👾 Monster X';
    const plcSummary    = plcList.map(id => `\`${id}\``).join(', ');
    const sklSummary    = sklList.length > 0
      ? sklList.map(id => `\`${id}\``).join(', ')
      : '_لا يوجد_';
    const wpnSummary    = wpnList.length > 0
      ? wpnList.map(id => `\`${id}\``).join(', ')
      : '_لا يوجد_';

    return bot.sendMessage(chatId,
      `✅ *تم حفظ إعدادات البوس بنجاح!*\n\n` +
      `🗡️ البوس: *${bossLabel}*\n` +
      `🆔 IDC: \`${idcList[0]}\`\n` +
      `🃏 PLC: ${plcSummary}\n` +
      `✨ SKL: ${sklSummary}\n` +
      `🔫 WPN: ${wpnSummary}`,
      { parse_mode: 'Markdown' }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public DB accessor — used by Phase 3 / Phase 4 fight launchers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the configured card loadout for a tutorial boss.
 *
 * @param  {'nitron'|'monster_x'} bossType
 * @returns {Promise<{
 *   idc_card_id : string,
 *   plc_ids     : string[],
 *   skl_ids     : string[],
 *   wpn_ids     : string[]
 * }|null>}  null if not yet configured by an admin
 */
async function getTutorialBossConfig(bossType) {
  const row = await db.queryOne(
    'SELECT * FROM tutorial_boss_cards WHERE boss_type = ?',
    [bossType]
  );
  if (!row) return null;

  return {
    idc_card_id : row.idc_card_id,
    plc_ids     : safeParseJson(row.plc_ids, []),
    skl_ids     : safeParseJson(row.skl_ids, []),
    wpn_ids     : safeParseJson(row.wpn_ids, []),
  };
}

/**
 * Load the full card objects for a tutorial boss from their respective tables.
 * Returns a shape compatible with the existing fight state expected by botFight.js.
 *
 * @param  {'nitron'|'monster_x'} bossType
 * @returns {Promise<{
 *   identity    : object,
 *   playCards   : object[],
 *   weaponCards : object[],
 *   skillCards  : object[]
 * }|null>}
 */
async function loadTutorialBossCards(bossType) {
  const cfg = await getTutorialBossConfig(bossType);
  if (!cfg) return null;

  const identity = await db.queryOne(
    'SELECT * FROM identity_cards WHERE card_id = ?',
    [cfg.idc_card_id]
  );
  if (!identity) return null;

  const playCards = cfg.plc_ids.length > 0
    ? await db.query(
        `SELECT * FROM play_cards WHERE card_id IN (${cfg.plc_ids.map(() => '?').join(', ')})`,
        cfg.plc_ids
      )
    : [];

  const skillCards = cfg.skl_ids.length > 0
    ? await db.query(
        `SELECT * FROM skill_cards WHERE card_id IN (${cfg.skl_ids.map(() => '?').join(', ')})`,
        cfg.skl_ids
      )
    : [];

  const weaponCards = cfg.wpn_ids.length > 0
    ? await db.query(
        `SELECT * FROM weapon_cards WHERE card_id IN (${cfg.wpn_ids.map(() => '?').join(', ')})`,
        cfg.wpn_ids
      )
    : [];

  return { identity, playCards, skillCards, weaponCards };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utility
// ─────────────────────────────────────────────────────────────────────────────

function safeParseJson(value, fallback) {
  if (Array.isArray(value)) return value;          // MySQL driver already parsed it
  try   { return JSON.parse(value); }
  catch { return fallback; }
}

function buildUsageMessage() {
  return (
    `📋 *الاستخدام الصحيح:*\n` +
    `\`$setTutorialBoss <BossType> | <IDC> | <PLC1,PLC2,...> | <SKL1,...> | <WPN1,...>\`\n\n` +
    `*BossType*: \`nitron\` أو \`monster_x\`\n` +
    `*IDC*: بطاقة تعريفية واحدة (IDC-XXXXX)\n` +
    `*PLC*: بطاقة تشغيل واحدة أو أكثر، مفصولة بفاصلة\n` +
    `*SKL*: اختياري — بطاقات مهارات\n` +
    `*WPN*: اختياري — بطاقات أسلحة\n\n` +
    `*مثال:*\n` +
    `\`$setTutorialBoss nitron | IDC-00099 | PLC-00011,PLC-00012 | SKL-00005\``
  );
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  register,
  getTutorialBossConfig,
  loadTutorialBossCards,
};