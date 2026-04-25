const assert = require('node:assert/strict');

const session = require('../middleware/sessionManager');
const {
  BOT_STORAGE_TELEGRAM_ID,
  BOT_STORAGE_PLAYER_CODE,
  ensureBotStoragePlayer,
  upsertBotIdentityLevel,
  bindBotPlayCard,
  bindBotSkillCard,
  bindBotWeaponCard,
  loadBotIdentityForLevel
} = require('../utils/botCardStorage');
const botPlayCard = require('../handlers/botPlayCard');

function createFakeDb() {
  const state = {
    players: [],
    botCardSets: new Map(),
    botPlayCards: new Set(),
    botSkillCards: new Set(),
    botWeaponCards: new Set(),
    identityCards: new Map(),
    nextPlayerId: 1
  };

  return {
    state,
    async queryOne(sql, params = []) {
      if (sql.includes('FROM players WHERE telegram_id = ?')) {
        return state.players.find(player => player.telegram_id === params[0]) || null;
      }

      if (sql.includes('FROM bot_card_sets WHERE level = ?')) {
        return state.botCardSets.get(params[0]) || null;
      }

      if (sql.includes('FROM bot_card_sets bcs')) {
        const binding = state.botCardSets.get(params[0]);
        if (!binding) return null;
        return state.identityCards.get(binding.identity_card_id) || null;
      }

      return null;
    },
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO players')) {
        const player = {
          id: state.nextPlayerId++,
          telegram_id: params[0],
          real_name: params[1],
          character_name: params[2],
          player_code: params[3]
        };
        state.players.push(player);
        return { insertId: player.id };
      }

      if (sql.includes('INSERT INTO bot_card_sets')) {
        state.botCardSets.set(params[0], { level: params[0], identity_card_id: params[1] });
        return {};
      }

      if (sql.includes('UPDATE bot_card_sets SET identity_card_id')) {
        state.botCardSets.set(params[1], { level: params[1], identity_card_id: params[0] });
        return {};
      }

      if (sql.includes('INSERT IGNORE INTO bot_play_cards')) {
        state.botPlayCards.add(`${params[0]}:${params[1]}`);
        return {};
      }

      if (sql.includes('INSERT IGNORE INTO bot_skill_cards')) {
        state.botSkillCards.add(`${params[0]}:${params[1]}`);
        return {};
      }

      if (sql.includes('INSERT IGNORE INTO bot_weapon_cards')) {
        state.botWeaponCards.add(`${params[0]}:${params[1]}`);
        return {};
      }

      return {};
    }
  };
}

async function runAll() {
  await runSingleTest('ensureBotStoragePlayer creates and reuses the hidden bot owner', async () => {
    const fakeDb = createFakeDb();

    const created = await ensureBotStoragePlayer(fakeDb);
    const reused = await ensureBotStoragePlayer(fakeDb);

    assert.equal(fakeDb.state.players.length, 1);
    assert.equal(created.id, reused.id);
    assert.equal(created.telegram_id, BOT_STORAGE_TELEGRAM_ID);
    assert.equal(created.player_code, BOT_STORAGE_PLAYER_CODE);
  });

  await runSingleTest('upsertBotIdentityLevel replaces the mapped identity for an existing level', async () => {
    const fakeDb = createFakeDb();
    fakeDb.state.identityCards.set('IDC-11111', { id: 11, card_id: 'IDC-11111', atk: 100, magic: 200, def: 300, spd: 400, accuracy: 500 });
    fakeDb.state.identityCards.set('IDC-22222', { id: 22, card_id: 'IDC-22222', atk: 150, magic: 250, def: 350, spd: 450, accuracy: 550 });

    await upsertBotIdentityLevel(7, 'IDC-11111', fakeDb);
    await upsertBotIdentityLevel(7, 'IDC-22222', fakeDb);

    assert.equal(fakeDb.state.botCardSets.size, 1);
    assert.equal(fakeDb.state.botCardSets.get(7).identity_card_id, 'IDC-22222');

    const identity = await loadBotIdentityForLevel(7, fakeDb);
    assert.ok(identity);
    assert.equal(identity.card_id, 'IDC-22222');
    assert.equal(identity.atk, 150);
  });

  await runSingleTest('bind helpers attach play, skill, and weapon cards to their bot level without duplicates', async () => {
    const fakeDb = createFakeDb();

    await bindBotPlayCard(3, 'PLC-11111', fakeDb);
    await bindBotPlayCard(3, 'PLC-11111', fakeDb);
    await bindBotSkillCard(3, 'SKL-11111', fakeDb);
    await bindBotSkillCard(3, 'SKL-11111', fakeDb);
    await bindBotWeaponCard(3, 'WPN-11111', fakeDb);
    await bindBotWeaponCard(3, 'WPN-11111', fakeDb);

    assert.deepEqual([...fakeDb.state.botPlayCards], ['3:PLC-11111']);
    assert.deepEqual([...fakeDb.state.botSkillCards], ['3:SKL-11111']);
    assert.deepEqual([...fakeDb.state.botWeaponCards], ['3:WPN-11111']);
  });

  await runSingleTest('bot play card flow stops when the level has no mapped identity card', async () => {
    const telegramId = 998877;
    const chatId = 445566;
    const messages = [];
    const bot = {
      async sendMessage(targetChatId, text, options = {}) {
        messages.push({ chatId: targetChatId, text, options });
        return { message_id: messages.length };
      }
    };

    session.clearSession(telegramId);
    session.setSession(telegramId, 'bot_play_card', 'awaiting_level', { type: 'attack' });

    const handled = await botPlayCard.handleBotPlayCardStep(
      bot,
      {
        chat: { id: chatId },
        from: { id: telegramId },
        text: '5'
      },
      {
        loadBotIdentityForLevel: async () => null
      }
    );

    assert.equal(handled, true);
    assert.ok(!session.hasActiveSession(telegramId));
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /لا توجد بطاقة تعريفية مرتبطة بالمستوى/);
  });
}

async function runSingleTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runAll()
  .then(() => {
    console.log('All botCardStorage tests passed.');
  })
  .catch((error) => {
    process.exitCode = 1;
    throw error;
  });
