'use strict';

const db      = require('../db/connection');
const session = require('../middleware/sessionManager');

// ─── Constants ────────────────────────────────────────────────────────────────

const BOT_SYSTEM_PLAYER_ID = 9;

const OFFICIAL_GROUP_ID   = -1003976992809;
const OFFICIAL_GROUP_LINK = 'https://t.me/+m8Y8tSVrpeswYWU0';

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function generatePlayerId() {
  const num = Math.floor(10000 + Math.random() * 90000);
  return `PLR-${num}`;
}

function sys(body) {
  return `\`\`\`\n[ ＳＹＳＴＥＭ ]\n\n${body}\n\`\`\``;
}

// ─── $login command ───────────────────────────────────────────────────────────

function register(bot) {

  // ── $login ──────────────────────────────────────────────────────────────────
  bot.onText(/^\$login$/i, async (msg) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(
        chatId,
        sys(
          '⚠️ هذا الأمر يعمل في المحادثات الخاصة (DM) فقط.\n' +
          'افتح محادثة خاصة مع البوت وأعد المحاولة.'
        ),
        { parse_mode: 'Markdown' }
      );
    }

    const existing = await db.queryOne(
      'SELECT player_code, real_name, character_name, system_rank FROM players WHERE telegram_id = ?',
      [tid]
    );

    if (existing) {
      return bot.sendMessage(
        chatId,
        sys(
          `✅ أنت مسجّل بالفعل في نظام RAAZN.\n\n` +
          `👤  الاسم الحقيقي  :  ${existing.real_name}\n` +
          `🎭  الشخصية         :  ${existing.character_name}\n` +
          `🪪   كود اللاعب     :  ${existing.player_code}\n` +
          `⭐  الرتبة            :  ${existing.system_rank}`
        ),
        { parse_mode: 'Markdown' }
      );
    }

    session.setSession(tid, 'login', 'awaiting_real_name', {});

    return bot.sendMessage(
      chatId,
      sys(
        `🌑 مرحباً بك في نظام RAAZN.\n\n` +
        `تم رصد هويتك. قبل منحك صلاحية الدخول،\n` +
        `نحتاج إلى التحقق من بياناتك.\n\n` +
        `📝 أدخل اسمك الحقيقي للمتابعة.`
      ),
      { parse_mode: 'Markdown' }
    );
  });

  // ── $loginMonster [nitron | monster_x] ──────────────────────────────────────
  bot.onText(/^\$loginMonster\s+(nitron|monster_x)$/i, async (msg, match) => {
    const chatId  = msg.chat.id;
    const tid     = msg.from.id;
    const monsterKey = match[1].toLowerCase();

    const admin = await db.queryOne(
      'SELECT is_admin FROM players WHERE telegram_id = ?',
      [tid]
    );

    if (!admin || !admin.is_admin) {
      return bot.sendMessage(
        chatId,
        sys('⛔ هذا الأمر مخصص للإدارة فقط.'),
        { parse_mode: 'Markdown' }
      );
    }

    session.setSession(tid, 'loginMonster', 'awaiting_monster_idc', { monster: monsterKey });

    return bot.sendMessage(
      chatId,
      sys(
        `🛠️ وضع المدير — تهيئة بطاقة الوحش: ${monsterKey}\n\n` +
        `الخطوة 1/2\n` +
        `📋 أرسل card_id الخاص بـ IDC للوحش.`
      ),
      { parse_mode: 'Markdown' }
    );
  });
}

// ─── Step handler ─────────────────────────────────────────────────────────────

async function handleLoginStep(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const text   = (msg.text || '').trim();

  const sess = session.getSession(tid);
  if (!sess || !sess.action) return;

  // ════════════════════════════════════════
  //  LOGIN FLOW
  // ════════════════════════════════════════

  if (sess.action === 'login') {

    // Step 1: Receive real name
    if (sess.step === 'awaiting_real_name') {
      if (!text || text.length < 2) {
        return bot.sendMessage(
          chatId,
          sys('⚠️ الاسم قصير جداً أو غير صالح.\nحاول مجدداً.'),
          { parse_mode: 'Markdown' }
        );
      }

      session.setSession(tid, 'login', 'awaiting_char', { real_name: text });

      const chars = await db.query(
        `SELECT id, char_name, anime_source
         FROM available_characters
         WHERE is_taken = 0
         ORDER BY anime_source, char_name`
      );

      if (chars.length === 0) {
        session.clearSession(tid);
        return bot.sendMessage(
          chatId,
          sys(
            `❌ لا توجد شخصيات متاحة في الوقت الحالي.\n` +
            `تواصل مع الإدارة لإضافة شخصيات جديدة.`
          ),
          { parse_mode: 'Markdown' }
        );
      }

      const buttons = chars.map((c) => ({
        text          : `${c.char_name}  ·  ${c.anime_source}`,
        callback_data : `login_char_${c.id}`,
      }));

      const keyboard = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }

      return bot.sendMessage(
        chatId,
        sys(
          `🎭 اختر شخصيتك يا ${text}.\n\n` +
          `كل شخصية تحمل إرثاً خاصاً وبطاقاتها الخاصة،\n` +
          `التي ستُنقل إليك فور الاختيار.\n\n` +
          `⚠️ الاختيار نهائي ولا يمكن التراجع عنه.`
        ),
        {
          parse_mode   : 'Markdown',
          reply_markup : { inline_keyboard: keyboard },
        }
      );
    }

    // Step 2: Ignore stray text while waiting for character button
    if (sess.step === 'awaiting_char') {
      return bot.sendMessage(
        chatId,
        sys('⏳ الرجاء اختيار شخصيتك من القائمة أعلاه.'),
        { parse_mode: 'Markdown' }
      );
    }
  }

  // ════════════════════════════════════════
  //  LOGIN MONSTER FLOW
  // ════════════════════════════════════════

  if (sess.action === 'loginMonster') {

    // Step 1: Receive IDC card_id
    if (sess.step === 'awaiting_monster_idc') {
      if (!text) {
        return bot.sendMessage(
          chatId,
          sys('⚠️ أدخل card_id صحيح للـ IDC.'),
          { parse_mode: 'Markdown' }
        );
      }

      const idcExists = await db.queryOne(
        'SELECT card_id FROM identity_cards WHERE card_id = ?',
        [text]
      );

      if (!idcExists) {
        return bot.sendMessage(
          chatId,
          sys(`❌ لا توجد بطاقة IDC بالكود: ${text}\nتحقق وأعد المحاولة.`),
          { parse_mode: 'Markdown' }
        );
      }

      session.setSession(tid, 'loginMonster', 'awaiting_monster_plc', {
        ...sess.data,
        idc_card_id: text,
      });

      return bot.sendMessage(
        chatId,
        sys(
          `✅ IDC مسجّل: ${text}\n\n` +
          `الخطوة 2/2\n` +
          `📋 أرسل card_id الخاص بـ PLC للوحش.`
        ),
        { parse_mode: 'Markdown' }
      );
    }

    // Step 2: Receive PLC card_id → commit to tutorial_boss_cards
    if (sess.step === 'awaiting_monster_plc') {
      if (!text) {
        return bot.sendMessage(
          chatId,
          sys('⚠️ أدخل card_id صحيح للـ PLC.'),
          { parse_mode: 'Markdown' }
        );
      }

      const plcExists = await db.queryOne(
        'SELECT card_id FROM play_cards WHERE card_id = ?',
        [text]
      );

      if (!plcExists) {
        return bot.sendMessage(
          chatId,
          sys(`❌ لا توجد بطاقة PLC بالكود: ${text}\nتحقق وأعد المحاولة.`),
          { parse_mode: 'Markdown' }
        );
      }

      const { monster, idc_card_id } = sess.data;
      const plcCardId = text;

      session.clearSession(tid);

      try {
        await db.withTransaction(async (conn) => {
          await conn.execute(
            `INSERT INTO tutorial_boss_cards (monster_key, idc_card_id, plc_card_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
               idc_card_id = VALUES(idc_card_id),
               plc_card_id = VALUES(plc_card_id)`,
            [monster, idc_card_id, plcCardId]
          );
        });

        return bot.sendMessage(
          chatId,
          sys(
            `✅ تم تحديث بطاقات الوحش بنجاح!\n\n` +
            `🐉  الوحش   :  ${monster}\n` +
            `🃏  IDC      :  ${idc_card_id}\n` +
            `🃏  PLC      :  ${plcCardId}`
          ),
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('[loginMonster] transaction error:', err.message, err.stack);
        return bot.sendMessage(
          chatId,
          sys('❌ حدث خطأ أثناء حفظ بيانات الوحش.\nتواصل مع المطور.'),
          { parse_mode: 'Markdown' }
        );
      }
    }
  }
}

// ─── Callback handler: login_char_[id] ───────────────────────────────────────

async function handleCharCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const charId = parseInt(data.replace('login_char_', ''), 10);
  if (!charId || isNaN(charId)) return;

  const sess = session.getSession(tid);
  if (!sess || sess.action !== 'login' || sess.step !== 'awaiting_char') {
    return bot.sendMessage(
      chatId,
      sys('⚠️ انتهت صلاحية الجلسة.\nاستخدم $login من جديد.'),
      { parse_mode: 'Markdown' }
    );
  }

  const realName = sess.data.real_name;

  // Clear immediately to prevent double-tap race
  session.clearSession(tid);

  try {
    const result = await db.withTransaction(async (conn) => {

      // 1. Lock character row and verify availability
      const [charRows] = await conn.execute(
        'SELECT * FROM available_characters WHERE id = ? FOR UPDATE',
        [charId]
      );

      if (!charRows.length || charRows[0].is_taken !== 0) {
        const err = new Error('CHARACTER_TAKEN');
        err.charName = charRows[0]?.char_name ?? 'Unknown';
        throw err;
      }

      const char = charRows[0];

      // 2. Reserve the character
      await conn.execute(
        'UPDATE available_characters SET is_taken = 1 WHERE id = ?',
        [charId]
      );

      // 3. Generate unique player_code (up to 10 attempts)
      let playerCode = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generatePlayerId();
        const [existing] = await conn.execute(
          'SELECT id FROM players WHERE player_code = ?',
          [candidate]
        );
        if (!existing.length) { playerCode = candidate; break; }
      }
      if (!playerCode) throw new Error('CODEGEN_FAILED');

      // 4. Insert new player — system_rank = 'none' so rankSystem.js handles dynamic rank
      const [ins] = await conn.execute(
        `INSERT INTO players
           (telegram_id, real_name, character_name, player_code, system_rank)
         VALUES (?, ?, ?, ?, 'none')`,
        [tid, realName, char.char_name, playerCode]
      );
      const newPlayerId = ins.insertId;

      // 5. Fetch starter templates for this character
      const [templates] = await conn.execute(
        `SELECT card_id, card_type
         FROM character_starter_templates
         WHERE char_name = ?`,
        [char.char_name]
      );

      // 6. Handover: transfer IDC and PLC from BOT_SYSTEM to new player
      for (const tpl of templates) {
        if (tpl.card_type === 'IDC') {
          await conn.execute(
            `UPDATE identity_cards
             SET player_id = ?
             WHERE card_id = ? AND player_id = ?`,
            [newPlayerId, tpl.card_id, BOT_SYSTEM_PLAYER_ID]
          );
        } else if (tpl.card_type === 'PLC') {
          await conn.execute(
            `UPDATE play_cards
             SET player_id = ?
             WHERE card_id = ? AND player_id = ?`,
            [newPlayerId, tpl.card_id, BOT_SYSTEM_PLAYER_ID]
          );
        }
        // SKL deferred until Phase 3 / $start_exam
      }

      // 7. Tutorial state
      await conn.execute(
        `INSERT INTO player_tutorial_state (player_id, stage)
         VALUES (?, 'character_selected')
         ON DUPLICATE KEY UPDATE stage = 'character_selected'`,
        [newPlayerId]
      );

      return { newPlayerId, char, playerCode };
    });

    // ── Cinematic loading sequence ─────────────────────────────────────────
    const loadMsg = await bot.sendMessage(
      chatId,
      sys('🔄 جاري نقل الإرث إلى حاملة الجديد...\n\n[ ░░░░░░░░░░ ]  0%'),
      { parse_mode: 'Markdown' }
    );

    await sleep(1000);
    await bot.editMessageText(
      sys('🔄 جاري نقل الإرث إلى حاملة الجديد...\n\n[ ████░░░░░░ ]  40%'),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(900);
    await bot.editMessageText(
      sys('🔄 جاري نقل الإرث إلى حاملة الجديد...\n\n[ ████████░░ ]  90%'),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(800);
    await bot.editMessageText(
      sys('🔄 جاري نقل الإرث إلى حاملة الجديد...\n\n[ █████████░ ]  95%'),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(700);
    await bot.editMessageText(
      sys('✅ [ ██████████ ]  100%\n\nInheritance Transfer Complete.'),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(1000);

    // ── Character image (if available) ────────────────────────────────────
    if (result.char.image_id) {
      await bot.sendPhoto(chatId, result.char.image_id, {
        caption    : `*${result.char.char_name}*  ·  ${result.char.anime_source}`,
        parse_mode : 'Markdown',
      });
      await sleep(800);
    }

    // ── Fetch and display inherited IDC stats ─────────────────────────────
    const idc = await db.queryOne(
      `SELECT ic.*
       FROM identity_cards ic
       INNER JOIN character_starter_templates cst
         ON cst.card_id = ic.card_id
       WHERE cst.char_name = ?
         AND cst.card_type = 'IDC'
         AND ic.player_id  = ?
       LIMIT 1`,
      [result.char.char_name, result.newPlayerId]
    );

    if (idc) {
      const caption =
        `🃏 *بطاقة الهوية — ${idc.name}*\n` +
        `\`${idc.card_id}\`\n\n` +
        `❤️  HP          :  \`${idc.hp}\`\n` +
        `⚔️  ATK         :  \`${idc.atk}\`\n` +
        `🔮  MAGIC       :  \`${idc.magic}\`\n` +
        `🛡️  DEF         :  \`${idc.def}\`\n` +
        `💨  SPD         :  \`${idc.spd}\`\n` +
        `🎯  ACCURACY    :  \`${idc.accuracy}\`\n\n` +
        `📊  النقاط الإجمالية  :  \`${idc.total_points}\``;

      if (idc.image_id) {
        await bot.sendPhoto(chatId, idc.image_id, { caption, parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
      }
    }

    await sleep(500);

    // ── Final welcome message ──────────────────────────────────────────────
    return bot.sendMessage(
      chatId,
      sys(
        `🌑 لقد ورثت إرادة ${result.char.char_name}.\n\n` +
        `مرحباً بك في نظام RAAZN، ${realName}.\n\n` +
        `🎭  شخصيتك   :  ${result.char.char_name}\n` +
        `🪪   كودك      :  ${result.playerCode}\n` +
        `⭐  الرتبة      :  لاجئ\n\n` +
        `─────────────────────────────\n\n` +
        `انضم إلى المجموعة الرسمية واكتب:\n` +
        `  $start_exam\n\n` +
        `لإثبات جدارتك وكسب لقبك الأول.`
      ),
      {
        parse_mode   : 'Markdown',
        reply_markup : {
          inline_keyboard: [[
            { text: '🚪 انضم إلى المجموعة الرسمية', url: OFFICIAL_GROUP_LINK },
          ]],
        },
      }
    );

  } catch (err) {

    if (err.message === 'CHARACTER_TAKEN') {
      session.setSession(tid, 'login', 'awaiting_char', { real_name: realName });
      return bot.sendMessage(
        chatId,
        sys(
          `❌ هذه الشخصية اختارها شخص آخر للتو!\n\n` +
          `الرجاء اختيار شخصية أخرى من القائمة السابقة،\n` +
          `أو أرسل $login من جديد لتحديث القائمة.`
        ),
        { parse_mode: 'Markdown' }
      );
    }

    if (err.message === 'CODEGEN_FAILED') {
      console.error('[login] player code generation failed after 10 attempts, tid:', tid);
      return bot.sendMessage(
        chatId,
        sys('❌ فشل توليد كود اللاعب. تواصل مع الإدارة.'),
        { parse_mode: 'Markdown' }
      );
    }

    console.error('[login] handleCharCallback error:', err.message, err.stack);
    return bot.sendMessage(
      chatId,
      sys('❌ حدث خطأ غير متوقع أثناء التسجيل.\nتواصل مع الإدارة.'),
      { parse_mode: 'Markdown' }
    );
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { register, handleLoginStep, handleCharCallback }