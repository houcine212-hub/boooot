// commands/about.js
// $about — شرح نظام إمبراطورية Card Master

const SECTIONS = {
  main: {
    text: `🏰 *نظام إمبراطورية Card Master*

مرحباً بك في إمبراطورية Card Master — لعبة بطاقات تفاعلية كاملة داخل تيليجرام\\.

اختار القسم اللي تبغي تعرفو:`,
    keyboard: [
      [
        { text: '⚔️ نظام القتال والرتب', callback_data: 'about_ranks' },
        { text: '📊 نقاط المجد (RP)', callback_data: 'about_rp' }
      ],
      [
        { text: '🎴 أنواع البطاقات', callback_data: 'about_cards' },
        { text: '📖 طور القصة', callback_data: 'about_story' }
      ],
      [
        { text: '🏙️ نظام الأراضي والمدن', callback_data: 'about_territory' },
        { text: '👑 الألقاب اليدوية', callback_data: 'about_titles' }
      ]
    ]
  },

  ranks: {
    text: `⚔️ *نظام الرتب التلقائية*

الرتبة تُحسب تلقائياً من نقاط المجد \\(RP\\):

🔴 *لاجئ* — 0 إلى 999 RP
└ البداية لكل لاعب جديد

🟠 *مواطن* — 1,000 إلى 1,999 RP
└ حق المشاركة في الأحداث

🟡 *جندي* — 2,000 إلى 3,999 RP
└ الانضمام لفرق القتال

🟢 *فارس متدرب* — 4,000 إلى 6,999 RP
└ أولوية في التحديات

🔵 *فارس* — 7,000 إلى 9,999 RP
└ الوصول لساحة الفرسان

🏆 *بطل المدينة* — 10,000 RP فأكثر
└ لقب خاص \\+ مكافآت المدينة

> النقاط لا تنزل أبداً تحت 0`,
    back: 'about_main'
  },

  rp: {
    text: `📊 *نظام نقاط المجد \\(RP\\)*

*قتال ضد البوت:*
┌ فوز ضد Bot المستوى 1 ← \\+10 RP
├ فوز ضد Bot المستوى 5 ← \\+50 RP
├ فوز ضد Bot المستوى 10 ← \\+100 RP
└ خسارة في أي مستوى ← \\-15 RP

*قتال PvP \\(بين لاعبين\\):*
┌ فوز ← \\+30 RP
├ فوز بـ Forfeit Timeout ← \\+30 RP
└ خسارة ← \\-20 RP

> 💡 كلما ارتفع مستوى البوت زادت المكافأة
> ⚠️ النقاط لا تنزل تحت 0 أبداً`,
    back: 'about_main'
  },

  cards: {
    text: `🎴 *أنواع البطاقات*

*🪪 بطاقة الهوية \\(IDC\\)*
└ الشخصية الرئيسية — فيها HP وكل الإحصائيات

*⚔️ بطاقة اللعب \\(PLC\\)*
└ 3 أنواع: هجوم / دفاع / سحر
└ تستهلك من إحصائيات بطاقة الهوية

*✨ بطاقة المهارة \\(SKL\\)*
└ أنواع: reflect / negate / stun / almighty / poison
└ لها مدة تأثير: جولة 1 أو 2 أو طوال القتال

*🗡️ بطاقة السلاح \\(WPN\\)*
└ نوعان: Enhanced أو Normal
└ تعزز نسبة معينة من الإحصائيات

> 💡 كل بطاقة لها ID فريد بالشكل:
> \`IDC\\-12345\` / \`PLC\\-12345\` / \`SKL\\-12345\` / \`WPN\\-12345\``,
    back: 'about_main'
  },

  story: {
    text: `📖 *طور القصة — Story Mode*

طور تفاعلي سردي تتحول فيه من مقاتل بطاقات إلى بطل يعيش ملحمة حقيقية\\.

*🔄 نظام المواسم*
└ كل موسم قصة جديدة بعالم وأعداء مختلفين
└ من أمثلة المواسم: اجتياح الزومبي، تنين ثائر، حرب الحصون

*🎨 السرد البصري*
└ مشاهد بأسلوب المانجا اليابانية
└ نص سردي بالعربية \\+ أزرار تفاعلية

*🎯 نظام الاختيارات*
└ قرارات مصيرية — مسار آمن أو مسار انتحاري
└ بعض الخيارات تتطلب قوة بطاقة معينة

*💾 نقاط الحفظ*
└ حفظ تلقائي عند كل مرحلة رئيسية
└ عند الموت ترجع لآخر نقطة حفظ

*🏆 المكافآت الحصرية*
└ بطاقات مهارة نادرة لا توجد في المتجر
└ ألقاب مجد خاصة تظهر في \`$status\``,
    back: 'about_main'
  },

  territory: {
    text: `🏙️ *نظام الأراضي والمدن*

كل مجموعة تيليجرام مسجلة كمدينة داخل الإمبراطورية\\.

*المدن المسجلة حالياً:*
🔸 Novaris — مملكة Valendor
🔸 Darkthra — مملكة Valendor
🔸 Eldoria — مملكة Valendor
🔸 Kaelvor — مملكة Valendor
🔸 Zeraphin — مملكة Valendor
🔸 القصر الإمبراطوري — مقر العرش

*عرض الموقع في \`$status\`:*
┌ داخل مدينة → \`مدينة [الاسم] | [المملكة]\`
├ داخل القصر → \`القصر الملكي (مقر العرش)\`
└ خارج المدن → \`خارج نطاق الإمبراطورية\``,
    back: 'about_main'
  },

  titles: {
    text: `👑 *الألقاب اليدوية — التعيينات الإمبراطورية*

الألقاب اليدوية تتجاوز الرتبة التلقائية تماماً — تُمنح من المشرف الرئيسي فقط عبر \`$settitle\`\\.

*الألقاب المتاحة:*
👑 *الإمبراطور* — يُعطى للمشرف الرئيسي فقط
🛡️ *الوصي الملكي* — نائب الإمبراطور
🏙️ *حاكم المدينة* — مسؤول مدينة محددة
⚔️ *قائد الحرس* — قائد الجيش الإمبراطوري
🤝 *سفير المملكة* — ممثل مملكة أخرى

*إدارة الألقاب:*
└ تعيين: \`$settitle [كود اللاعب] [اللقب]\`
└ إزالة: \`$settitle [كود اللاعب] \\-\`

> ⚠️ هذه الأوامر للمشرف الرئيسي فقط`,
    back: 'about_main'
  }
};

function buildKeyboard(section) {
  if (section.keyboard) {
    return { inline_keyboard: section.keyboard };
  }
  if (section.back) {
    return {
      inline_keyboard: [[{ text: '🔙 رجوع', callback_data: section.back }]]
    };
  }
  return undefined;
}

function register(bot) {
  bot.onText(/^\$about$/i, async (msg) => {
    const chatId = msg.chat.id;
    const section = SECTIONS.main;

    await bot.sendMessage(chatId, section.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: buildKeyboard(section)
    });
  });
}

async function handleCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  const key = data.replace('about_', '');
  const section = SECTIONS[key];
  if (!section) return;

  await bot.editMessageText(section.text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'MarkdownV2',
    reply_markup: buildKeyboard(section)
  });
}

module.exports = { register, handleCallback };