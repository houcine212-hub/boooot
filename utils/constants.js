/**
 * Game Constants
 */

const TOTAL_IDENTITY_POINTS = 10000;
const TOTAL_WEAPON_POINTS = 10000;
const BOT_LEVEL_POINT_STEP = 5000;

function getBotLevelDistributionPoints(level, basePoints = TOTAL_IDENTITY_POINTS) {
  const numericLevel = Number.parseInt(level, 10);
  const safeLevel = Number.isNaN(numericLevel) || numericLevel < 1 ? 1 : numericLevel;
  return basePoints + ((safeLevel - 1) * BOT_LEVEL_POINT_STEP);
}

const PLAY_CARD_TYPES = {
  ATTACK: 'attack',
  DEFENSE: 'defense',
  MAGIC: 'magic'
};

const SKILL_CARD_TYPES = {
  REFLECT: 'reflect',
  NEGATE: 'negate',
  STUN: 'stun',
  ALMIGHTY: 'almighty',
  POISON: 'poison'
};

const SKILL_LABELS = {
  reflect: '🔄 عكس',
  negate: '❌ نفي',
  stun: '🔒 تثبيت',
  almighty: '💪 جبروت',
  poison: '☠️ سم'
};

const WEAPON_TYPES = {
  ENHANCED: 'enhanced',
  NORMAL: 'normal'
};

const BOOST_TARGETS = {
  ATK: 'atk',
  MAGIC: 'magic',
  DEF: 'def',
  SPD: 'spd',
  ACCURACY: 'accuracy',
  EFFECT: 'effect',
  ALL: 'all'
};

const DURATIONS = {
  ONE: '1',
  TWO: '2',
  ALL: 'all'
};

const DURATION_LABELS = {
  '1': 'دور واحد',
  '2': 'دوران',
  all: 'جميع الأدوار'
};

const PLAY_TYPE_LABELS = {
  attack: '⚔️ هجومية',
  defense: '🛡️ دفاعية',
  magic: '✨ سحرية'
};

const WEAPON_TYPE_LABELS = {
  enhanced: '🔮 سلاح معزز',
  normal: '🗡️ سلاح عادي'
};

const BOOST_TARGET_LABELS = {
  atk: '⚔️ هجوم',
  magic: '✨ سحر',
  def: '🛡️ دفاع',
  spd: '💨 سرعة',
  accuracy: '🎯 دقة',
  effect: '💥 تأثير',
  all: '🌟 جميع الإحصائيات'
};

module.exports = {
  TOTAL_IDENTITY_POINTS,
  TOTAL_WEAPON_POINTS,
  BOT_LEVEL_POINT_STEP,
  getBotLevelDistributionPoints,
  PLAY_CARD_TYPES,
  SKILL_CARD_TYPES,
  SKILL_LABELS,
  WEAPON_TYPES,
  BOOST_TARGETS,
  DURATIONS,
  DURATION_LABELS,
  PLAY_TYPE_LABELS,
  WEAPON_TYPE_LABELS,
  BOOST_TARGET_LABELS
};
