'use strict';

// Rank thresholds in ascending order
const RANK_TIERS = [
  { min: 10000, name: 'بطل المدينة' },
  { min: 7000,  name: 'فارس' },
  { min: 4000,  name: 'فارس متدرب' },
  { min: 2000,  name: 'جندي' },
  { min: 1000,  name: 'مواطن' },
  { min: 0,     name: 'لاجئ' }
];

/**
 * Returns the display rank/title for a player.
 *
 * @param {number} points      - The player's current rank_points.
 * @param {string|null} manualTitle - The player's manually appointed title (or null).
 * @returns {string} The rank or title name.
 */
function getEmpireRank(points, manualTitle) {
  if (manualTitle) return manualTitle;

  const pts = Number(points) || 0;
  const tier = RANK_TIERS.find(t => pts >= t.min);
  return tier ? tier.name : 'لاجئ';
}

module.exports = { getEmpireRank };