/**
 * Session Manager
 * Manages conversation state for multi-step interactions per user
 */

const SESSION_TTL = 15 * 60 * 1000; // 15 minutes

// In-memory session store: telegramId -> session data
const sessions = new Map();
// Timer store: telegramId -> timeoutId
const timers = new Map();

// ─── Internal: reset the TTL timer for a user ─────────────────────────────────
function _resetTimer(telegramId) {
  if (timers.has(telegramId)) clearTimeout(timers.get(telegramId));
  const id = setTimeout(() => {
    sessions.delete(telegramId);
    timers.delete(telegramId);
  }, SESSION_TTL);
  timers.set(telegramId, id);
}

/**
 * Get or create a session for a user
 */
function getSession(telegramId) {
  if (!sessions.has(telegramId)) {
    sessions.set(telegramId, {
      step: null,
      action: null,
      data: {}
    });
  }
  return sessions.get(telegramId);
}

/**
 * Set the current step and action for a user
 */
function setSession(telegramId, action, step, data = {}) {
  sessions.set(telegramId, {
    step,
    action,
    data
  });
  _resetTimer(telegramId);
}

/**
 * Update session data without changing step/action
 */
function updateSessionData(telegramId, newData) {
  const session = getSession(telegramId);
  session.data = { ...session.data, ...newData };
  _resetTimer(telegramId);
}

/**
 * Clear a user's session
 */
function clearSession(telegramId) {
  sessions.delete(telegramId);
  if (timers.has(telegramId)) {
    clearTimeout(timers.get(telegramId));
    timers.delete(telegramId);
  }
}

/**
 * Check if a user has an active session
 */
function hasActiveSession(telegramId) {
  const session = sessions.get(telegramId);
  return session && session.step !== null;
}

module.exports = {
  getSession,
  setSession,
  updateSessionData,
  clearSession,
  hasActiveSession
};