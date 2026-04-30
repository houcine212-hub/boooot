// commands/cardCharacter.js
// =============================================================================
// نظام الشخصيات الجاهزة - المرحلة الأولى (Phase 1)
// =============================================================================
// الأوامر المتاحة:
//   $C_card [CharacterName]      : يبدأ معالج إنشاء بطاقة لشخصية معينة
//   $setCharImg [CharacterName]  : يضبط الصورة الرسمية للشخصية
//   $charList                    : يعرض قائمة الشخصيات الثلاثين مع حالة كل واحدة
//
// الجلسة المستخدمة: action = 'char_card_wizard'
// =============================================================================

'use strict';

const db         = require('../db/connection');
const session    = require('../middleware/sessionManager');
const rankSystem = require('../utils/rankSystem');
const { generateIdentityCardId } = require('../utils/idGenerator');
const { TOTAL_IDENTITY_POINTS }  = require('../utils/constants');
const { PLAY_TYPE_LABELS }       = require('../utils/constants');
const { sendQR }                 = require('../utils/qrHelper');

// =============================================================================
// ثوابت الإحصائيات - مطابقة لـ identityCard.js و playCard.js
// =============================================================================

// إحصائيات بطاقة الهوية (IDC) بالترتيب
const IDC_STATS = ['hp', 'atk', 'def', 'spd', 'accuracy'];

// تسميات إحصائيات بطاقة الهوية بالعربية
const IDC_STAT_LABELS = {
  hp:       'نقاط الحياة (HP)',
  atk:      'الهجوم (ATK)',
  def:      'الدفاع (DEF)',
  spd:      'السرعة (SPD)',
  accuracy: 'الدقة (Accuracy)',
};

// إحصائيات بطاقات اللعب حسب النوع: [مفتاح_الإحصاء, التسمية, مفتاح_الحد_في_الجلسة]
const PLC_TYPE_STATS = {
  attack:  [
    ['atk',      'الهجوم (ATK)',      'cap_atk'],
    ['accuracy', 'الدقة (Accuracy)',  'cap_accuracy'],
  ],
  magic:   [
    ['magic',    'السحر (Magic)',     'cap_magic'],
    ['accuracy', 'الدقة (Accuracy)',  'cap_accuracy'],
  ],
  defense: [
    ['def',      'الدفاع (DEF)',      'cap_def'],
    ['spd',      'السرعة (SPD)',      'cap_spd'],
  ],
};

// الحد الأقصى الافتراضي لإحصائيات بطاقات لعب الشخصيات
// (لا يوجد بطاقة هوية تقيّد الشخصية, لذا نضع حدًا عاليًا)
const DEFAULT_PLC_CAP = 999999;

// أنواع بطاقات المهارات المتاحة
const SKL_TYPES        = ['reflect', 'negate', 'stun', 'almighty', 'poison'];
const SKL_TYPE_LABELS  = {
  reflect:  'مرآة الرد (Reflect)',
  negate:   'نفي الأثر (Negate)',
  stun:     'التثبيت (Stun)',
  almighty: 'الجبروت (Almighty)',
  poison:   'السم (Poison)',
};
const SKL_DURATION_LABELS = {
  '1':   'جولة واحدة',
  '2':   'جولتان',
  'all': 'طوال المعركة',
};

// =============================================================================
// دالة مساعدة: تُنشئ لوحة النظام بالأسلوب المظلم
// =============================================================================
function systemPanel(text) {
  return '```\n' +
    '= = = [ SYSTEM ] = = =\n\n' +
    text +
    '\n\n= = = = = = = = = = =\n' +
    '```';
}

// =============================================================================
// دالة مساعدة: التحقق من صلاحيات مشرف القصة
// =============================================================================
async function guardStoryAdmin(bot, chatId, tid) {
  if (await rankSystem.isStoryAdmin(tid)) return true;
  await bot.sendMessage(
    chatId,
    systemPanel('رفض الوصول\nهذا الامر مخصص للراوي والامير والامبراطور فقط.'),
    { parse_mode: 'Markdown' }
  );
  return false;
}

// =============================================================================
// دالة مساعدة: جلب ID لاعب النظام BOT_SYSTEM من قاعدة البيانات
// =============================================================================
async function getBotSystemPlayerId() {
  const row = await db.queryOne(
    'SELECT id FROM players WHERE player_code = ? LIMIT 1',
    ['BOT_SYSTEM']
  );
  if (!row) {
    throw new Error('لاعب BOT_SYSTEM غير موجود في قاعدة البيانات. أضفه يدويا.');
  }
  return row.id;
}

// =============================================================================
// دالة مساعدة: جلب معرف بطاقة هوية الشخصية المحفوظة في القوالب
// تُستخدم لربط بطاقات اللعب ببطاقة الهوية المقابلة
// =============================================================================
async function getCharacterIdcRow(charName) {
  // نبحث عن أول قالب IDC مرتبط بهذه الشخصية
  const template = await db.queryOne(
    'SELECT card_id FROM character_starter_templates WHERE char_name = ? AND card_type = ? LIMIT 1',
    [charName, 'IDC']
  );
  if (!template) return null;

  // نجلب الصف الكامل من جدول identity_cards للحصول على العمود id الداخلي
  const idc = await db.queryOne(
    'SELECT id FROM identity_cards WHERE card_id = ? LIMIT 1',
    [template.card_id]
  );
  return idc || null;
}

// =============================================================================
// دالة مساعدة: توليد معرف فريد مع التحقق من عدم التكرار
// prefix مثل: 'IDC', 'PLC', 'SKL'
// tableName: اسم الجدول للتحقق
// =============================================================================
async function generateUniqueId(prefix, tableName) {
  let cardId;
  let attempts = 0;
  do {
    // نولد رقمًا عشوائيًا من 5 أرقام
    const randomNum = Math.floor(10000 + Math.random() * 90000).toString();
    cardId = prefix + '-' + randomNum;
    attempts++;
    if (attempts > 100) throw new Error('فشل توليد معرف فريد بعد 100 محاولة.');
  } while (await db.queryOne('SELECT id FROM ' + tableName + ' WHERE card_id = ?', [cardId]));
  return cardId;
}


// =============================================================================
// COMMAND: $C_card [CharacterName]
// نقطة دخول المعالج الرئيسي لإنشاء بطاقة شخصية
// =============================================================================
async function handleCCard(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const text   = msg.text || '';

  if (!await guardStoryAdmin(bot, chatId, tid)) return;

  // استخراج اسم الشخصية من الأمر
  const charName = text.replace(/^\$C_card\s*/i, '').trim();
  if (!charName) {
    return bot.sendMessage(
      chatId,
      systemPanel('الاستخدام الصحيح:\n$C_card [اسم الشخصية]\n\nمثال: $C_card Guts'),
      { parse_mode: 'Markdown' }
    );
  }

  // التحقق من وجود الشخصية في قاعدة البيانات
  const character = await db.queryOne(
    'SELECT * FROM available_characters WHERE char_name = ?',
    [charName]
  );
  if (!character) {
    return bot.sendMessage(
      chatId,
      systemPanel(
        'الشخصية غير موجودة: ' + charName + '\n\n' +
        'استخدم امر $charList لرؤية قائمة الشخصيات المتاحة.'
      ),
      { parse_mode: 'Markdown' }
    );
  }

  // نحفظ الجلسة ونعرض قائمة اختيار نوع البطاقة
  session.setSession(tid, 'char_card_wizard', 'awaiting_card_type', {
    charName:    character.char_name,
    animeSource: character.anime_source,
    charId:      character.id,
  });

  const existingTemplates = await db.query(
    'SELECT card_type, card_id FROM character_starter_templates WHERE char_name = ? ORDER BY card_type',
    [charName]
  );

  // نبني نص ملخص البطاقات الموجودة حاليًا
  let existingSummary = 'لا توجد بطاقات مضافة بعد.';
  if (existingTemplates.length > 0) {
    existingSummary = existingTemplates
      .map(t => '[ ' + t.card_type + ' ] ' + t.card_id)
      .join('\n');
  }

  await bot.sendMessage(
    chatId,
    systemPanel(
      'انشاء بطاقة شخصية\n' +
      'الشخصية   : ' + charName + '\n' +
      'المصدر    : ' + character.anime_source + '\n\n' +
      'البطاقات الحالية:\n' + existingSummary + '\n\n' +
      'اختر نوع البطاقة التي تريد اضافتها:'
    ),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'بطاقة الهوية (IDC)',   callback_data: 'cc_type_IDC_' + character.id },
          { text: 'بطاقة اللعب (PLC)',    callback_data: 'cc_type_PLC_' + character.id },
          { text: 'بطاقة المهارة (SKL)', callback_data: 'cc_type_SKL_' + character.id },
        ]]
      }
    }
  );
}


// =============================================================================
// CALLBACK: cc_type_[IDC|PLC|SKL]_[charId]
// يُعالج اختيار نوع البطاقة من القائمة المضمّنة
// =============================================================================
async function handleCardTypeCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  // تحليل بيانات الزر: cc_type_IDC_5 مثلاً
  const match = data.match(/^cc_type_(IDC|PLC|SKL)_(\d+)$/);
  if (!match) return;
  const [, cardType, charIdStr] = match;
  const charId = parseInt(charIdStr, 10);

  // التحقق من الجلسة
  const s = session.getSession(tid);
  if (!s || s.action !== 'char_card_wizard') return;

  await bot.answerCallbackQuery(query.id);

  // جلب بيانات الشخصية للتأكيد
  const character = await db.queryOne(
    'SELECT * FROM available_characters WHERE id = ?',
    [charId]
  );
  if (!character) {
    return bot.sendMessage(chatId,
      systemPanel('خطا: الشخصية غير موجودة.'),
      { parse_mode: 'Markdown' }
    );
  }

  // توجيه المعالج بحسب نوع البطاقة
  if (cardType === 'IDC') {
    return _startIdcWizard(bot, chatId, tid, character);
  }
  if (cardType === 'PLC') {
    return _startPlcWizard(bot, chatId, tid, character);
  }
  if (cardType === 'SKL') {
    return _startSklWizard(bot, chatId, tid, character);
  }
}


// =============================================================================
// CALLBACK: cc_plctype_[attack|defense|magic]_[charId]
// يُعالج اختيار نوع بطاقة اللعب (هجوم / دفاع / سحر)
// =============================================================================
async function handlePlcTypeCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const match = data.match(/^cc_plctype_(attack|defense|magic)_(\d+)$/);
  if (!match) return;
  const [, plcType, charIdStr] = match;
  const charId = parseInt(charIdStr, 10);

  const s = session.getSession(tid);
  if (!s || s.action !== 'char_card_wizard') return;

  await bot.answerCallbackQuery(query.id);

  const character = await db.queryOne(
    'SELECT * FROM available_characters WHERE id = ?',
    [charId]
  );
  if (!character) return;

  // نتحقق من وجود IDC للشخصية قبل إنشاء PLC لأن جدول play_cards يتطلب identity_card_id
  const existingIdc = await getCharacterIdcRow(character.char_name);
  if (!existingIdc) {
    session.clearSession(tid);
    return bot.sendMessage(
      chatId,
      systemPanel(
        'تنبيه: لا توجد بطاقة هوية (IDC) لشخصية ' + character.char_name + ' بعد.\n\n' +
        'يجب انشاء بطاقة الهوية اولا قبل بطاقات اللعب\n' +
        'لان قاعدة البيانات تربط PLC بـ IDC.\n\n' +
        'شغّل: $C_card ' + character.char_name + '\nواختر IDC اولا.'
      ),
      { parse_mode: 'Markdown' }
    );
  }

  // نحدّث الجلسة بنوع PLC والبيانات اللازمة
  session.setSession(tid, 'char_card_wizard', 'cc_plc_awaiting_name', {
    ...s.data,
    plcType,
    idcRowId:    existingIdc.id,
    cap_atk:     DEFAULT_PLC_CAP,
    cap_magic:   DEFAULT_PLC_CAP,
    cap_def:     DEFAULT_PLC_CAP,
    cap_spd:     DEFAULT_PLC_CAP,
    cap_accuracy: DEFAULT_PLC_CAP,
    collected: {},
  });

  const typeLabel = PLAY_TYPE_LABELS[plcType] || plcType;
  return bot.sendMessage(
    chatId,
    systemPanel(
      'انشاء بطاقة لعب للشخصية: ' + character.char_name + '\n' +
      'نوع البطاقة: ' + typeLabel + '\n\n' +
      'ادخل اسم بطاقة اللعب:'
    ),
    { parse_mode: 'Markdown' }
  );
}


// =============================================================================
// CALLBACK: cc_skltype_[type]_[charId]
// يُعالج اختيار نوع مهارة بطاقة SKL
// =============================================================================
async function handleSklTypeCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const typesJoined = SKL_TYPES.join('|');
  const regex       = new RegExp('^cc_skltype_(' + typesJoined + ')_(\\d+)$');
  const match       = data.match(regex);
  if (!match) return;
  const [, sklType, charIdStr] = match;
  const charId = parseInt(charIdStr, 10);

  const s = session.getSession(tid);
  if (!s || s.action !== 'char_card_wizard') return;

  await bot.answerCallbackQuery(query.id);

  session.setSession(tid, 'char_card_wizard', 'cc_skl_awaiting_effect', {
    ...s.data,
    sklType,
  });

  // بطاقة السم لا تحتاج effect_points بل تحتاج poison_percent
  if (sklType === 'poison') {
    return bot.sendMessage(
      chatId,
      systemPanel(
        'نوع المهارة: ' + SKL_TYPE_LABELS[sklType] + '\n\n' +
        'ادخل نسبة السم (poison_percent) كرقم عشري:\n' +
        'مثال: 10 تعني 10% ضرر كل جولة'
      ),
      { parse_mode: 'Markdown' }
    );
  }

  return bot.sendMessage(
    chatId,
    systemPanel(
      'نوع المهارة: ' + SKL_TYPE_LABELS[sklType] + '\n\n' +
      'ادخل قيمة تاثير المهارة (effect_points):\n' +
      'مثال: 900 تعني 900 نقطة مرآة رد او جبروت'
    ),
    { parse_mode: 'Markdown' }
  );
}


// =============================================================================
// CALLBACK: cc_skldur_[1|2|all]_[charId]
// يُعالج اختيار مدة المهارة
// =============================================================================
async function handleSklDurCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const match = data.match(/^cc_skldur_(1|2|all)_(\d+)$/);
  if (!match) return;
  const [, duration, charIdStr] = match;

  const s = session.getSession(tid);
  if (!s || s.action !== 'char_card_wizard') return;

  await bot.answerCallbackQuery(query.id);

  // الآن اكتملت كل البيانات, ننتقل للحفظ
  session.setSession(tid, 'char_card_wizard', 'cc_skl_saving', {
    ...s.data,
    sklDuration: duration,
  });

  await _saveCharacterSkl(bot, chatId, tid, { ...s.data, sklDuration: duration });
}


// =============================================================================
// المعالج الرئيسي للخطوات النصية (يُضاف إلى معالج الرسائل العام في bot.js)
// =============================================================================
async function handleCharCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;

  const s = session.getSession(tid);
  if (!s || s.action !== 'char_card_wizard') return false;

  const step = s.step;

  // -------------------------------------------------------------------------
  // مسار بطاقة الهوية IDC
  // -------------------------------------------------------------------------

  // الخطوة: انتظار اسم بطاقة الهوية
  if (step === 'cc_idc_awaiting_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId,
        systemPanel('اسم غير صالح. يجب ان يكون بين 1 و 100 حرف.'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    session.setSession(tid, 'char_card_wizard', 'cc_idc_stat_0', {
      ...s.data,
      cardName:  name,
      remaining: TOTAL_IDENTITY_POINTS,
      stats:     {},
    });

    await bot.sendMessage(
      chatId,
      systemPanel(
        'توزيع ' + TOTAL_IDENTITY_POINTS + ' نقطة على الشخصية\n\n' +
        'الاحصاء الاول: ' + IDC_STAT_LABELS.hp + '\n' +
        'النقاط المتبقية: ' + TOTAL_IDENTITY_POINTS
      ),
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  // الخطوات: إدخال إحصائيات IDC واحدة تلو الأخرى (0 إلى 4)
  const idcStatMatch = step.match(/^cc_idc_stat_(\d+)$/);
  if (idcStatMatch) {
    const idx  = parseInt(idcStatMatch[1], 10);
    const stat = IDC_STATS[idx];
    const val  = parseInt((msg.text || '').trim(), 10);

    if (isNaN(val) || val < 0 || val > s.data.remaining) {
      await bot.sendMessage(
        chatId,
        systemPanel('ادخل رقما بين 0 و ' + s.data.remaining + ':'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    const remaining = s.data.remaining - val;
    const stats     = Object.assign({}, s.data.stats, { [stat]: val });

    // إذا لم نصل للاحصاء الأخير, ننتقل للتالي
    if (idx < IDC_STATS.length - 1) {
      const nextStat = IDC_STATS[idx + 1];
      session.setSession(tid, 'char_card_wizard', 'cc_idc_stat_' + (idx + 1), {
        ...s.data, remaining, stats,
      });
      await bot.sendMessage(
        chatId,
        systemPanel(
          'تم: ' + IDC_STAT_LABELS[stat] + ' = ' + val + '\n\n' +
          'الاحصاء التالي: ' + IDC_STAT_LABELS[nextStat] + '\n' +
          'النقاط المتبقية: ' + remaining
        ),
        { parse_mode: 'Markdown' }
      );
    } else {
      // آخر إحصاء, ننتقل لحد السحر
      session.setSession(tid, 'char_card_wizard', 'cc_idc_awaiting_magic', {
        ...s.data, remaining, stats,
      });
      await bot.sendMessage(
        chatId,
        systemPanel(
          'تم: ' + IDC_STAT_LABELS[stat] + ' = ' + val + '\n\n' +
          'ادخل الان قيمة حد السحر (Magic Cap):\n' +
          '(هذه القيمة لا تُخصم من نقاط التوزيع)'
        ),
        { parse_mode: 'Markdown' }
      );
    }
    return true;
  }

  // الخطوة: إدخال حد السحر ثم الحفظ
  if (step === 'cc_idc_awaiting_magic') {
    const magicCap = parseInt((msg.text || '').trim(), 10);
    if (isNaN(magicCap) || magicCap < 0) {
      await bot.sendMessage(chatId,
        systemPanel('ادخل رقما صالحا (صفر او اكبر):'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }
    await _saveCharacterIdc(bot, chatId, tid, { ...s.data, magicCap });
    return true;
  }

  // -------------------------------------------------------------------------
  // مسار بطاقة اللعب PLC
  // -------------------------------------------------------------------------

  // الخطوة: انتظار اسم بطاقة اللعب
  if (step === 'cc_plc_awaiting_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId,
        systemPanel('اسم غير صالح. يجب ان يكون بين 1 و 100 حرف.'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    const typeStats       = PLC_TYPE_STATS[s.data.plcType];
    const [, firstLabel, firstCapKey] = typeStats[0];

    session.setSession(tid, 'char_card_wizard', 'cc_plc_stat_0', {
      ...s.data,
      cardName: name,
      collected: {},
    });

    await bot.sendMessage(
      chatId,
      systemPanel(
        'الاحصاء الاول: ' + firstLabel + '\n' +
        'الحد الاقصى: ' + s.data[firstCapKey]
      ),
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  // الخطوات: إدخال إحصائيات PLC
  const plcStatMatch = step.match(/^cc_plc_stat_(\d+)$/);
  if (plcStatMatch) {
    const idx       = parseInt(plcStatMatch[1], 10);
    const typeStats = PLC_TYPE_STATS[s.data.plcType];
    const [key, label, capKey] = typeStats[idx];
    const cap = s.data[capKey];
    const val = parseInt((msg.text || '').trim(), 10);

    if (isNaN(val) || val < 0 || val > cap) {
      await bot.sendMessage(chatId,
        systemPanel('ادخل رقما بين 0 و ' + cap + ':'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    const collected = Object.assign({}, s.data.collected, { [key]: val });

    if (idx < typeStats.length - 1) {
      const [, nextLabel, nextCapKey] = typeStats[idx + 1];
      session.setSession(tid, 'char_card_wizard', 'cc_plc_stat_' + (idx + 1), {
        ...s.data, collected,
      });
      await bot.sendMessage(
        chatId,
        systemPanel(
          'تم: ' + label + ' = ' + val + '\n\n' +
          'الاحصاء التالي: ' + nextLabel + '\n' +
          'الحد الاقصى: ' + s.data[nextCapKey]
        ),
        { parse_mode: 'Markdown' }
      );
    } else {
      // اكتملت الإحصائيات, ننتقل للحفظ
      await _saveCharacterPlc(bot, chatId, tid, { ...s.data, collected });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // مسار بطاقة المهارة SKL
  // -------------------------------------------------------------------------

  // الخطوة: انتظار اسم بطاقة المهارة
  if (step === 'cc_skl_awaiting_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId,
        systemPanel('اسم غير صالح. يجب ان يكون بين 1 و 100 حرف.'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    session.setSession(tid, 'char_card_wizard', 'cc_skl_choosing_type', {
      ...s.data,
      cardName: name,
    });

    // نعرض قائمة أنواع المهارات
    const typeButtons = SKL_TYPES.map(t => ([{
      text:          SKL_TYPE_LABELS[t],
      callback_data: 'cc_skltype_' + t + '_' + s.data.charId,
    }]));

    await bot.sendMessage(
      chatId,
      systemPanel(
        'اختر نوع المهارة لبطاقة: ' + name
      ),
      {
        parse_mode:   'Markdown',
        reply_markup: { inline_keyboard: typeButtons },
      }
    );
    return true;
  }

  // الخطوة: انتظار قيمة تأثير المهارة (effect_points أو poison_percent)
  if (step === 'cc_skl_awaiting_effect') {
    const val = parseFloat((msg.text || '').trim());
    if (isNaN(val) || val < 0) {
      await bot.sendMessage(chatId,
        systemPanel('ادخل رقما صالحا (صفر او اكبر):'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    // نحدد في الجلسة القيمة المُدخلة حسب نوع المهارة
    const updatedData = { ...s.data };
    if (s.data.sklType === 'poison') {
      updatedData.poisonPercent = val;
      updatedData.effectPoints  = 0;
    } else {
      updatedData.effectPoints  = Math.floor(val);
      updatedData.poisonPercent = 0;
    }

    session.setSession(tid, 'char_card_wizard', 'cc_skl_choosing_duration', updatedData);

    // نعرض قائمة مدة المهارة
    await bot.sendMessage(
      chatId,
      systemPanel(
        'تم تسجيل قيمة التاثير: ' + val + '\n\n' +
        'اختر مدة المهارة:'
      ),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: SKL_DURATION_LABELS['1'],   callback_data: 'cc_skldur_1_'   + s.data.charId }],
            [{ text: SKL_DURATION_LABELS['2'],   callback_data: 'cc_skldur_2_'   + s.data.charId }],
            [{ text: SKL_DURATION_LABELS['all'], callback_data: 'cc_skldur_all_' + s.data.charId }],
          ]
        }
      }
    );
    return true;
  }

  return false;
}


// =============================================================================
// دوال داخلية لبدء معالجات الأنواع المختلفة
// =============================================================================

// بدء معالج IDC: تحديث الجلسة والانتقال لخطوة الاسم
async function _startIdcWizard(bot, chatId, tid, character) {
  session.setSession(tid, 'char_card_wizard', 'cc_idc_awaiting_name', {
    charName:    character.char_name,
    animeSource: character.anime_source,
    charId:      character.id,
    cardCategory: 'IDC',
  });

  return bot.sendMessage(
    chatId,
    systemPanel(
      'انشاء بطاقة هوية (IDC)\n' +
      'الشخصية: ' + character.char_name + '\n\n' +
      'ادخل اسم البطاقة:'
    ),
    { parse_mode: 'Markdown' }
  );
}

// بدء معالج PLC: التحقق من IDC ثم عرض قائمة نوع PLC
async function _startPlcWizard(bot, chatId, tid, character) {
  session.setSession(tid, 'char_card_wizard', 'cc_plc_choosing_type', {
    charName:    character.char_name,
    animeSource: character.anime_source,
    charId:      character.id,
    cardCategory: 'PLC',
  });

  return bot.sendMessage(
    chatId,
    systemPanel(
      'انشاء بطاقة لعب (PLC)\n' +
      'الشخصية: ' + character.char_name + '\n\n' +
      'ملاحظة: يجب ان تكون بطاقة الهوية (IDC) موجودة اولا.\n\n' +
      'اختر نوع بطاقة اللعب:'
    ),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'هجومية (Attack)',  callback_data: 'cc_plctype_attack_'  + character.id },
          { text: 'دفاعية (Defense)', callback_data: 'cc_plctype_defense_' + character.id },
          { text: 'سحرية (Magic)',    callback_data: 'cc_plctype_magic_'   + character.id },
        ]]
      }
    }
  );
}

// بدء معالج SKL: الانتقال مباشرة لخطوة الاسم
async function _startSklWizard(bot, chatId, tid, character) {
  session.setSession(tid, 'char_card_wizard', 'cc_skl_awaiting_name', {
    charName:    character.char_name,
    animeSource: character.anime_source,
    charId:      character.id,
    cardCategory: 'SKL',
  });

  return bot.sendMessage(
    chatId,
    systemPanel(
      'انشاء بطاقة مهارة (SKL)\n' +
      'الشخصية: ' + character.char_name + '\n\n' +
      'ادخل اسم بطاقة المهارة:'
    ),
    { parse_mode: 'Markdown' }
  );
}


// =============================================================================
// دوال الحفظ النهائي لكل نوع بطاقة
// =============================================================================

// حفظ بطاقة الهوية (IDC) في قاعدة البيانات
async function _saveCharacterIdc(bot, chatId, tid, data) {
  const { charName, cardName, stats, magicCap } = data;
  const { hp, atk, def, spd, accuracy }         = stats;

  let botPlayerId;
  try {
    botPlayerId = await getBotSystemPlayerId();
  } catch (err) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel('خطا في النظام: ' + err.message),
      { parse_mode: 'Markdown' }
    );
  }

  // توليد معرف فريد للبطاقة
  const cardId = await generateUniqueId('IDC', 'identity_cards');

  // حساب النقاط المستخدمة
  const usedPoints = hp + atk + def + spd + accuracy;

  // إدراج بطاقة الهوية في قاعدة البيانات مع تعيينها للاعب النظام BOT_SYSTEM
  await db.query(
    `INSERT INTO identity_cards
     (card_id, player_id, name, hp, atk, available_atk,
      magic, available_magic, def, available_def,
      spd, available_spd, accuracy, available_accuracy,
      total_points, remaining_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,     botPlayerId,  cardName,
      hp,         atk,          atk,
      magicCap,   magicCap,
      def,        def,
      spd,        spd,
      accuracy,   accuracy,
      TOTAL_IDENTITY_POINTS,
      TOTAL_IDENTITY_POINTS - usedPoints,
    ]
  );

  // ربط البطاقة بالشخصية في جدول القوالب
  await db.query(
    'INSERT INTO character_starter_templates (char_name, card_id, card_type) VALUES (?, ?, ?)',
    [charName, cardId, 'IDC']
  );

  session.clearSession(tid);

  // رسالة النجاح
  await bot.sendMessage(
    chatId,
    systemPanel(
      '[ SYSTEM ] تم انشاء بطاقة الهوية وربطها بالشخصية بنجاح!\n\n' +
      'الشخصية  : ' + charName + '\n' +
      'معرف IDC : ' + cardId + '\n' +
      'الاسم    : ' + cardName + '\n\n' +
      'HP       : ' + hp       + '\n' +
      'ATK      : ' + atk      + '\n' +
      'Magic    : ' + magicCap + '\n' +
      'DEF      : ' + def      + '\n' +
      'SPD      : ' + spd      + '\n' +
      'Accuracy : ' + accuracy + '\n\n' +
      'النقاط المستخدمة: ' + usedPoints + ' / ' + TOTAL_IDENTITY_POINTS
    ),
    { parse_mode: 'Markdown' }
  );

  // إرسال رمز QR للبطاقة
  try {
    await sendQR(bot, chatId, cardId);
  } catch (err) {
    // QR اختياري, لا نوقف العملية
  }
}


// حفظ بطاقة اللعب (PLC) في قاعدة البيانات
async function _saveCharacterPlc(bot, chatId, tid, data) {
  const { charName, cardName, plcType, idcRowId, collected } = data;

  let botPlayerId;
  try {
    botPlayerId = await getBotSystemPlayerId();
  } catch (err) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel('خطا في النظام: ' + err.message),
      { parse_mode: 'Markdown' }
    );
  }

  // التحقق مجدداً من وجود IDC (احتياطي)
  if (!idcRowId) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(
        'خطا: لا يمكن انشاء PLC بدون IDC للشخصية.\n' +
        'انشئ IDC اولا باستخدام $C_card ' + charName
      ),
      { parse_mode: 'Markdown' }
    );
  }

  const cardId = await generateUniqueId('PLC', 'play_cards');

  // بناء حقول الإدراج ديناميكياً من collected
  // play_cards: atk, magic, def, accuracy, spd (حسب النوع)
  const atk      = collected.atk      || 0;
  const magic    = collected.magic    || 0;
  const def      = collected.def      || 0;
  const accuracy = collected.accuracy || 0;
  const spd      = collected.spd      || 0;

  await db.query(
    `INSERT INTO play_cards
     (card_id, player_id, identity_card_id, name, type, atk, magic, def, accuracy, spd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cardId, botPlayerId, idcRowId, cardName, plcType, atk, magic, def, accuracy, spd]
  );

  // ربط البطاقة بالشخصية
  await db.query(
    'INSERT INTO character_starter_templates (char_name, card_id, card_type) VALUES (?, ?, ?)',
    [charName, cardId, 'PLC']
  );

  session.clearSession(tid);

  const statsLines = Object.entries(collected)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => k.toUpperCase() + ' : ' + v)
    .join('\n');

  await bot.sendMessage(
    chatId,
    systemPanel(
      '[ SYSTEM ] تم انشاء بطاقة اللعب وربطها بالشخصية بنجاح!\n\n' +
      'الشخصية  : ' + charName + '\n' +
      'معرف PLC : ' + cardId + '\n' +
      'الاسم    : ' + cardName + '\n' +
      'النوع    : ' + (PLAY_TYPE_LABELS[plcType] || plcType) + '\n\n' +
      statsLines
    ),
    { parse_mode: 'Markdown' }
  );

  try {
    await sendQR(bot, chatId, cardId);
  } catch (err) {
    // QR اختياري
  }
}


// حفظ بطاقة المهارة (SKL) في قاعدة البيانات
async function _saveCharacterSkl(bot, chatId, tid, data) {
  const { charName, cardName, sklType, effectPoints, poisonPercent, sklDuration } = data;

  let botPlayerId;
  try {
    botPlayerId = await getBotSystemPlayerId();
  } catch (err) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel('خطا في النظام: ' + err.message),
      { parse_mode: 'Markdown' }
    );
  }

  const cardId = await generateUniqueId('SKL', 'skill_cards');

  await db.query(
    `INSERT INTO skill_cards
     (card_id, player_id, name, type, effect_points, poison_percent, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,
      botPlayerId,
      cardName,
      sklType,
      effectPoints  || 0,
      poisonPercent || 0,
      sklDuration,
    ]
  );

  // ربط البطاقة بالشخصية
  await db.query(
    'INSERT INTO character_starter_templates (char_name, card_id, card_type) VALUES (?, ?, ?)',
    [charName, cardId, 'SKL']
  );

  session.clearSession(tid);

  await bot.sendMessage(
    chatId,
    systemPanel(
      '[ SYSTEM ] تم انشاء بطاقة المهارة وربطها بالشخصية بنجاح!\n\n' +
      'الشخصية  : ' + charName + '\n' +
      'معرف SKL : ' + cardId + '\n' +
      'الاسم    : ' + cardName + '\n' +
      'نوع المهارة: ' + SKL_TYPE_LABELS[sklType] + '\n' +
      'التاثير  : ' + (sklType === 'poison' ? (poisonPercent + '%') : (effectPoints + ' نقطة')) + '\n' +
      'المدة    : ' + SKL_DURATION_LABELS[sklDuration]
    ),
    { parse_mode: 'Markdown' }
  );

  try {
    await sendQR(bot, chatId, cardId);
  } catch (err) {
    // QR اختياري
  }
}


// =============================================================================
// COMMAND: $setCharImg [CharacterName]
// يضبط الصورة الرسمية للشخصية (يُستخدم كـ reply على صورة)
// =============================================================================
async function handleSetCharImg(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const text   = msg.text || '';
  const reply  = msg.reply_to_message;

  if (!await guardStoryAdmin(bot, chatId, tid)) return;

  const charName = text.replace(/^\$setCharImg\s*/i, '').trim();
  if (!charName) {
    return bot.sendMessage(chatId,
      systemPanel('الاستخدام الصحيح:\n$setCharImg [اسم الشخصية]\n\nيجب ارسال الامر كـ reply على الصورة.'),
      { parse_mode: 'Markdown' }
    );
  }

  // التحقق من أن الأمر reply على صورة
  if (!reply || !reply.photo) {
    return bot.sendMessage(chatId,
      systemPanel('يجب ارسال الامر كـ reply على صورة.'),
      { parse_mode: 'Markdown' }
    );
  }

  // جلب أكبر نسخة من الصورة (آخر عنصر في مصفوفة photo)
  const imageId = reply.photo[reply.photo.length - 1].file_id;

  // التحقق من وجود الشخصية
  const character = await db.queryOne(
    'SELECT id FROM available_characters WHERE char_name = ?',
    [charName]
  );
  if (!character) {
    return bot.sendMessage(chatId,
      systemPanel('الشخصية غير موجودة: ' + charName),
      { parse_mode: 'Markdown' }
    );
  }

  // تحديث الصورة
  await db.query(
    'UPDATE available_characters SET image_id = ? WHERE char_name = ?',
    [imageId, charName]
  );

  await bot.sendMessage(chatId,
    systemPanel(
      'تم ضبط الصورة الرسمية للشخصية بنجاح!\n\n' +
      'الشخصية: ' + charName
    ),
    { parse_mode: 'Markdown' }
  );
}


// =============================================================================
// COMMAND: $charList
// يعرض قائمة الشخصيات الثلاثين مع حالة كل شخصية
// =============================================================================
async function handleCharList(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;

  // هذا الأمر متاح لأي لاعب لمعاينة الشخصيات
  // إذا أردت تقييده للأدمن فقط, أضف: if (!await guardStoryAdmin(bot, chatId, tid)) return;

  const characters = await db.query(
    'SELECT char_name, anime_source, is_taken FROM available_characters ORDER BY id ASC'
  );

  if (!characters || characters.length === 0) {
    return bot.sendMessage(chatId,
      systemPanel('لا توجد شخصيات مسجلة في النظام بعد.'),
      { parse_mode: 'Markdown' }
    );
  }

  // نجمع القوالب المكتملة لكل شخصية لنعرض حالة بطاقاتها
  const templates = await db.query(
    'SELECT char_name, card_type FROM character_starter_templates'
  );

  // نبني خريطة: charName -> Set من أنواع البطاقات الموجودة
  const templateMap = {};
  for (const t of templates) {
    if (!templateMap[t.char_name]) templateMap[t.char_name] = new Set();
    templateMap[t.char_name].add(t.card_type);
  }

  // نبني النص
  const lines = characters.map((c, index) => {
    const num        = String(index + 1).padStart(2, '0');
    const status     = c.is_taken ? '[ TAKEN ]    ' : '[ AVAILABLE ]';
    const types      = templateMap[c.char_name] || new Set();
    const hasIdc     = types.has('IDC') ? 'IDC' : '---';
    const hasPlc     = types.has('PLC') ? 'PLC' : '---';
    const hasSkl     = types.has('SKL') ? 'SKL' : '---';
    const cardStatus = hasIdc + ' ' + hasPlc + ' ' + hasSkl;
    return (
      num + '. ' + status + ' ' + c.char_name + '\n' +
      '    المصدر: ' + c.anime_source + '\n' +
      '    البطاقات: ' + cardStatus
    );
  });

  // نقسم القائمة إلى رسائل متعددة (Telegram تحد 4096 حرف لكل رسالة)
  const CHUNK_SIZE = 10;
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunk     = lines.slice(i, i + CHUNK_SIZE);
    const chunkNum  = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(lines.length / CHUNK_SIZE);
    const header    = 'قائمة الشخصيات الجاهزة (' + chunkNum + '/' + totalChunks + ')\n\n';
    await bot.sendMessage(
      chatId,
      systemPanel(header + chunk.join('\n\n')),
      { parse_mode: 'Markdown' }
    );
  }
}


// =============================================================================
// تسجيل الأوامر والأحداث في الـ bot
// =============================================================================
function register(bot) {
  // أمر إنشاء بطاقة لشخصية
  bot.onText(/^\$C_card\s+\S+/i, msg => handleCCard(bot, msg));

  // أمر ضبط صورة الشخصية (يتطلب reply على صورة)
  bot.onText(/^\$setCharImg\s+\S+/i, msg => handleSetCharImg(bot, msg));

  // أمر عرض القائمة
  bot.onText(/^\$charList$/i, msg => handleCharList(bot, msg));
}


// =============================================================================
// تصدير الدوال
// =============================================================================
module.exports = {
  register,
  handleCharCardStep,
  handleCardTypeCallback,
  handlePlcTypeCallback,
  handleSklTypeCallback,
  handleSklDurCallback,
};