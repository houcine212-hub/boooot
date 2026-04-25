/**
 * ID Generator Utility
 * Generates unique IDs for players and different card types
 */

/**
 * Generate a random numeric string of given length
 */
function randomDigits(length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 10).toString();
  }
  return result;
}

/**
 * Generate a player ID: PLR-XXXXX
 */
function generatePlayerId() {
  return `PLR-${randomDigits(5)}`;
}

/**
 * Generate an identity card ID: IDC-XXXXX
 */
function generateIdentityCardId() {
  return `IDC-${randomDigits(5)}`;
}

/**
 * Generate a play card ID: PLC-XXXXX
 */
function generatePlayCardId() {
  return `PLC-${randomDigits(5)}`;
}

/**
 * Generate a skill card ID: SKL-XXXXX
 */
function generateSkillCardId() {
  return `SKL-${randomDigits(5)}`;
}

/**
 * Generate a weapon card ID: WPN-XXXXX
 */
function generateWeaponCardId() {
  return `WPN-${randomDigits(5)}`;
}

module.exports = {
  generatePlayerId,
  generateIdentityCardId,
  generatePlayCardId,
  generateSkillCardId,
  generateWeaponCardId
};
