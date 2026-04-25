const assert = require('node:assert/strict');

const combatEngine = require('../utils/CombatEngine');

function createState(overrides = {}) {
  return combatEngine.ensurePlayerState({
    name: overrides.name || 'Player',
    currentHp: overrides.currentHp ?? 10000,
    identityCard: overrides.identityCard || { hp: overrides.currentHp ?? 10000 },
    effects: overrides.effects || [],
    usedCards: overrides.usedCards || new Set(),
    ...overrides
  });
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('Reflect defeats weaker Almighty in a skill clash', () => {
  const active = createState({ name: 'Active' });
  const reactive = createState({
    name: 'Reactive',
    effects: [
      combatEngine.createEffect({
        type: 'poison',
        duration: 2,
        strength: 10,
        sourceId: 'existing-poison',
        stackable: false,
        blockable: true
      })
    ]
  });

  const result = combatEngine.resolveTurn(
    { card_id: 'SKL-REFLECT', type: 'reflect', effect_points: 800, duration: '1' },
    { card_id: 'SKL-ALMIGHTY', type: 'almighty', effect_points: 500, duration: '1' },
    active,
    reactive,
    { activeName: 'Active', reactiveName: 'Reactive' }
  );

  assert.equal(combatEngine.getEffect(reactive, 'poison')?.strength, 10);
  assert.ok(result.events.some(event => event.type === 'skill_blocked' && event.actor === 'reactive'));
});

runTest('Poison overwrites only when the new poison is stronger', () => {
  const active = createState({
    name: 'Active',
    effects: [
      combatEngine.createEffect({
        type: 'poison',
        duration: 1,
        strength: 10,
        sourceId: 'old-poison',
        stackable: false,
        blockable: true
      })
    ]
  });
  const reactive = createState({ name: 'Reactive' });

  combatEngine.resolveTurn(
    null,
    { card_id: 'SKL-POISON', type: 'poison', effect_points: 1500, poison_percent: 15, duration: '2' },
    active,
    reactive,
    { activeName: 'Active', reactiveName: 'Reactive' }
  );

  const poison = combatEngine.getEffect(active, 'poison');
  assert.ok(poison);
  assert.equal(poison.strength, 15);
  assert.equal(poison.duration, 2);
});

runTest('Attack versus skill follows the no-dodge rule', () => {
  const active = createState({ name: 'Active' });
  const reactive = createState({ name: 'Reactive' });

  combatEngine.resolveTurn(
    { card_id: 'PLC-ATK', type: 'attack', atk: 3000, accuracy: 100 },
    { card_id: 'SKL-STUN', type: 'stun', effect_points: 500, duration: '1' },
    active,
    reactive,
    { activeName: 'Active', reactiveName: 'Reactive' }
  );

  assert.equal(reactive.currentHp, 7000);
  assert.ok(combatEngine.hasEffect(active, 'stun'));
});

runTest('Stun is consumed on the next turn start, not immediately on apply', () => {
  const active = createState({
    name: 'Active',
    effects: [
      combatEngine.createEffect({
        type: 'stun',
        duration: 1,
        strength: 500,
        sourceId: 'SKL-STUN',
        stackable: false,
        blockable: true
      })
    ]
  });

  const turnStart = combatEngine.processTurnStart(active, { playerName: 'Active' });

  assert.equal(turnStart.skipTurn, true);
  assert.equal(combatEngine.hasEffect(active, 'stun'), false);
});

runTest('Chain reflect can send attack damage back to the attacker', () => {
  const active = createState({ name: 'Active' });
  const reactive = createState({ name: 'Reactive' });

  const result = combatEngine.resolveChain(
    [
      {
        role: 'active',
        card: { card_id: 'PLC-ATK', type: 'attack', atk: 3000, accuracy: 100 }
      },
      {
        role: 'reactive',
        card: { card_id: 'SKL-REFLECT', type: 'reflect', effect_points: 5000, duration: '1' }
      }
    ],
    active,
    reactive,
    { activeName: 'Active', reactiveName: 'Reactive' }
  );

  assert.equal(active.currentHp, 7000);
  assert.equal(reactive.currentHp, 10000);
  assert.ok(result.events.some(event => event.type === 'damage_reflected' && event.actor === 'reactive'));
});

runTest('Chain LIFO lets a later almighty stop reflect so the attack still lands', () => {
  const active = createState({ name: 'Active' });
  const reactive = createState({ name: 'Reactive' });

  const result = combatEngine.resolveChain(
    [
      {
        role: 'active',
        card: { card_id: 'PLC-ATK', type: 'attack', atk: 3000, accuracy: 100 }
      },
      {
        role: 'reactive',
        card: { card_id: 'SKL-REFLECT', type: 'reflect', effect_points: 5000, duration: '1' }
      },
      {
        role: 'active',
        card: { card_id: 'SKL-ALMIGHTY', type: 'almighty', effect_points: 6000, duration: '1' }
      }
    ],
    active,
    reactive,
    { activeName: 'Active', reactiveName: 'Reactive' }
  );

  assert.equal(active.currentHp, 10000);
  assert.equal(reactive.currentHp, 7000);
  assert.ok(result.events.some(event => event.type === 'skill_blocked' && event.actor === 'reactive' && event.by === 'almighty'));
});

console.log('All CombatEngine tests passed.');
