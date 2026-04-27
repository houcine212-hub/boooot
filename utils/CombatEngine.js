const SKILL_PRIORITIES = {
  reflect:    40,
  negate:     45,
  almighty:   50,
  stun:       30,
  poison:     20,
  weapon_buff: 10,
};

const COUNTER_SKILLS    = new Set(['reflect', 'negate', 'almighty']);
const HARMFUL_SKILLS    = new Set(['stun', 'poison']);
const BLOCKABLE_EFFECTS = new Set(['stun', 'poison']);
const SKILL_TYPES       = new Set([...COUNTER_SKILLS, ...HARMFUL_SKILLS]);

class CombatEngine {
  ensurePlayerState(playerState) {
    if (!playerState || typeof playerState !== 'object') {
      throw new Error('CombatEngine expected a valid player state.');
    }

    if (!Array.isArray(playerState.effects)) {
      const legacyEffects = playerState.effects && typeof playerState.effects === 'object'
        ? playerState.effects
        : {};

      playerState.effects = [];

      if (legacyEffects.stun > 0) {
        playerState.effects.push(this.createEffect({
          type:      'stun',
          duration:  Number(legacyEffects.stun),
          strength:  Number(legacyEffects.stun),
          sourceId:  'legacy-stun',
          stackable: false,
          blockable: true,
        }));
      }

      if (legacyEffects.poison > 0) {
        playerState.effects.push(this.createEffect({
          type:      'poison',
          duration:  999,
          strength:  Number(legacyEffects.poison),
          sourceId:  'legacy-poison',
          stackable: false,
          blockable: true,
        }));
      }
    }

    if (!(playerState.usedCards instanceof Set)) {
      playerState.usedCards = new Set(playerState.usedCards || []);
    }

    return playerState;
  }

  createEffect({
    type,
    duration  = 1,
    strength  = 0,
    sourceId  = '',
    stackable = false,
    blockable = true,
  }) {
    return {
      type,
      duration:  Math.max(0, Number(duration) || 0),
      strength:  Number(strength) || 0,
      sourceId:  String(sourceId || ''),
      stackable: Boolean(stackable),
      blockable: Boolean(blockable),
    };
  }

  getCardKind(card) {
    if (!card) return 'none';

    if (card.card_id?.startsWith('SKL-') || SKILL_TYPES.has(card.type)) {
      return 'skill';
    }

    if (card.card_id?.startsWith('WPN-')) {
      if (card.weapon_type === 'enhanced') return 'support';
      if (card.sub_type === 'defense')     return 'defense';
      if (['attack', 'magic'].includes(card.sub_type)) return 'attack';
    }

    if (card.type === 'defense') return 'defense';
    if (['attack', 'magic'].includes(card.type)) return 'attack';
    return 'none';
  }

  getCardProfile(card) {
    const kind = this.getCardKind(card);
    const attackValue = kind === 'attack'
      ? (Number(card.atk) || 0) + (Number(card.magic) || 0)
      : 0;

    return {
      raw:          card || null,
      kind,
      attackValue,
      defenseValue: kind === 'defense' ? (Number(card.def) || 0) : 0,
      speed:        kind === 'defense' ? (Number(card.spd) || 0) : 0,
      accuracy:     kind === 'attack'  ? (Number(card.accuracy) || 0) : 0,
      skill:        kind === 'skill'   ? this.getSkillProfile(card) : null,
    };
  }

  getSkillProfile(card) {
    if (!card) return null;

    const type = card.weapon_type === 'enhanced' ? 'weapon_buff' : card.type;
    return {
      card,
      type,
      effectPoints:  this.getSkillEffectPoints(card),
      priority:      this.getSkillPriority(card),
      duration:      this.getDurationTurns(card.duration),
      poisonPercent: Number(card.poison_percent) || 0,
      boostPercent:  Number(card.boost_percent)  || 0,
      boostTarget:   card.boost_target || null,
    };
  }

  getSkillEffectPoints(card) {
    if (!card) return 0;

    const explicitPoints = Number(card.effect_points) || 0;
    if (explicitPoints > 0) return explicitPoints;

    if (card.type === 'poison') {
      return Math.round((Number(card.poison_percent) || 0) * 100);
    }

    if (card.weapon_type === 'enhanced') {
      return Math.round((Number(card.boost_percent) || 0) * 100);
    }

    return 0;
  }

  getSkillPriority(card) {
    if (!card) return 0;
    const type = card.weapon_type === 'enhanced' ? 'weapon_buff' : card.type;
    return Number(card.priority) || SKILL_PRIORITIES[type] || 0;
  }

  getDurationTurns(duration) {
    if (duration === 'all') return 999;
    return Math.max(1, parseInt(duration, 10) || 1);
  }

  compareSkillPower(skillA, skillB) {
    const pointsA = skillA?.effectPoints || 0;
    const pointsB = skillB?.effectPoints || 0;

    if (pointsA !== pointsB) return Math.sign(pointsA - pointsB);

    const priorityA = skillA?.priority || 0;
    const priorityB = skillB?.priority || 0;

    if (priorityA !== priorityB) return Math.sign(priorityA - priorityB);
    return 0;
  }

  getEffect(playerState, effectType) {
    this.ensurePlayerState(playerState);
    return playerState.effects.find(effect => effect.type === effectType) || null;
  }

  hasEffect(playerState, effectType) {
    return Boolean(this.getEffect(playerState, effectType));
  }

  removeExpiredEffects(playerState) {
    this.ensurePlayerState(playerState);
    playerState.effects = playerState.effects.filter(effect => effect.duration > 0);
  }

  removeBlockableEffects(playerState) {
    this.ensurePlayerState(playerState);

    const removed   = [];
    const remaining = [];

    for (const effect of playerState.effects) {
      if (effect.blockable && BLOCKABLE_EFFECTS.has(effect.type)) {
        removed.push(effect);
      } else {
        remaining.push(effect);
      }
    }

    playerState.effects = remaining;
    return removed;
  }

  addOrRefreshEffect(playerState, effect) {
    this.ensurePlayerState(playerState);

    if (effect.stackable) {
      playerState.effects.push(effect);
      return { action: 'applied', effect };
    }

    const existing = this.getEffect(playerState, effect.type);
    if (!existing) {
      playerState.effects.push(effect);
      return { action: 'applied', effect };
    }

    if (effect.strength > existing.strength) {
      existing.duration  = effect.duration;
      existing.strength  = effect.strength;
      existing.sourceId  = effect.sourceId;
      existing.stackable = effect.stackable;
      existing.blockable = effect.blockable;
      return { action: 'overwritten', effect: existing };
    }

    if (effect.strength === existing.strength) {
      existing.duration = Math.max(existing.duration, effect.duration);
      existing.sourceId = effect.sourceId || existing.sourceId;
      return { action: 'refreshed', effect: existing };
    }

    return { action: 'ignored', effect: existing };
  }

  processTurnStart(playerState, context = {}) {
    this.ensurePlayerState(playerState);

    const result = {
      skipTurn:     false,
      events:       [],
      summaryLines: [],
    };

    const poisonEffects = playerState.effects.filter(effect => effect.type === 'poison');
    for (const effect of poisonEffects) {
      if (playerState.currentHp <= 0) break;
      const damage = Math.max(1, Math.floor(playerState.currentHp * (effect.strength / 100)));
      playerState.currentHp = Math.max(0, playerState.currentHp - damage);
      effect.duration -= 1;

      result.events.push({
        type:   'poison_tick',
        target: 'self',
        amount: damage,
        effect,
      });
    }

    const stunEffect = this.getEffect(playerState, 'stun');
    if (stunEffect && stunEffect.duration > 0 && playerState.currentHp > 0) {
      stunEffect.duration -= 1;
      result.skipTurn = true;
      result.events.push({
        type:   'stun_skip',
        target: 'self',
        effect: stunEffect,
      });
    }

    this.removeExpiredEffects(playerState);
    result.summaryLines = this.describeEvents(result.events, {
      activeName:   context.playerName,
      reactiveName: context.playerName,
      selfName:     context.playerName,
    });

    return result;
  }

  resolveTurn(activeCard, reactiveCard, activePlayerState, reactivePlayerState, context = {}) {
    this.ensurePlayerState(activePlayerState);
    this.ensurePlayerState(reactivePlayerState);

    const active   = this.getCardProfile(activeCard);
    const reactive = this.getCardProfile(reactiveCard);

    const result = {
      activeCard,
      reactiveCard,
      activeProfile:   active,
      reactiveProfile: reactive,
      damage: {
        toActive:   0,
        toReactive: 0,
      },
      events:       [],
      summaryLines: [],
    };

    this.resolveSkillPhase(active, reactive, activePlayerState, reactivePlayerState, result);
    this.resolveDamagePhase(active, reactive, activePlayerState, reactivePlayerState, result);

    activePlayerState.currentHp   = Math.max(0, activePlayerState.currentHp   - result.damage.toActive);
    reactivePlayerState.currentHp = Math.max(0, reactivePlayerState.currentHp - result.damage.toReactive);

    this.removeExpiredEffects(activePlayerState);
    this.removeExpiredEffects(reactivePlayerState);

    result.summaryLines = this.describeEvents(result.events, {
      activeName:   context.activeName,
      reactiveName: context.reactiveName,
    });

    return result;
  }

  resolveChain(chainEntries, activePlayerState, reactivePlayerState, context = {}) {
    this.ensurePlayerState(activePlayerState);
    this.ensurePlayerState(reactivePlayerState);

    const chain = Array.isArray(chainEntries)
      ? chainEntries.map(entry => ({
          ...entry,
          card:          entry?.card || null,
          role:          entry?.role || 'active',
          profile:       this.getCardProfile(entry?.card || null),
          resolution:    'pending',
          counteredBy:   null,
          usedAsCounter: false,
        }))
      : [];

    const result = {
      chain: chainEntries || [],
      damage: {
        toActive:   0,
        toReactive: 0,
      },
      events:       [],
      summaryLines: [],
    };

    if (chain.length === 0) {
      return result;
    }

    this.evaluateChainCounters(chain);
    this.resolveChainDamage(chain, activePlayerState, reactivePlayerState, result);
    this.resolveChainSkills(chain, activePlayerState, reactivePlayerState, result);

    this.removeExpiredEffects(activePlayerState);
    this.removeExpiredEffects(reactivePlayerState);

    result.summaryLines = this.describeEvents(result.events, {
      activeName:   context.activeName,
      reactiveName: context.reactiveName,
    });

    return result;
  }

  evaluateChainCounters(chain) {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const entry = chain[index];
      const skill = entry.profile.skill;

      if (entry.profile.kind !== 'skill' || !this.isCounterSkill(skill) || entry.resolution !== 'pending') {
        continue;
      }

      const targetIndex = this.findPreviousCounterableEntry(chain, index);
      if (targetIndex < 0) continue;

      const targetEntry = chain[targetIndex];
      if (!this.canCounterChainEntry(skill, targetEntry.profile)) {
        continue;
      }

      entry.usedAsCounter = true;
      targetEntry.counteredBy = {
        type: skill.type,
        role: entry.role,
        index,
      };

      if (skill.type === 'reflect' && (targetEntry.profile.kind === 'attack' || this.isHarmfulSkill(targetEntry.profile.skill))) {
        targetEntry.resolution = 'reflected';
      } else {
        targetEntry.resolution = 'blocked';
      }
    }
  }

  findPreviousCounterableEntry(chain, fromIndex) {
    for (let index = fromIndex - 1; index >= 0; index -= 1) {
      const entry = chain[index];
      if (entry.resolution !== 'pending') continue;
      if (entry.profile.kind === 'attack' || entry.profile.kind === 'skill') {
        return index;
      }
    }

    return -1;
  }

  canCounterChainEntry(counterSkill, targetProfile) {
    if (!counterSkill || !targetProfile) return false;

    if (targetProfile.kind === 'attack') {
      return (counterSkill.effectPoints || 0) > (targetProfile.attackValue || 0);
    }

    if (targetProfile.kind === 'skill') {
      return this.compareSkillPower(counterSkill, targetProfile.skill) > 0;
    }

    return false;
  }

  resolveChainDamage(chain, activePlayerState, reactivePlayerState, result) {
    const attackEntry = chain.find(entry => entry.profile.kind === 'attack');
    if (!attackEntry || attackEntry.profile.attackValue <= 0) return;

    const attackValue      = attackEntry.profile.attackValue;
    const attackTargetRole = this.getOpposingRole(attackEntry.role);

    if (attackEntry.resolution === 'blocked') {
      result.events.push({
        type:  'damage_blocked',
        actor: attackEntry.counteredBy?.role || attackTargetRole,
      });
      return;
    }

    if (attackEntry.resolution === 'reflected') {
      this.applyChainDamageToRole(attackEntry.role, attackValue, activePlayerState, reactivePlayerState, result);
      result.events.push({
        type:         'damage_reflected',
        actor:        attackEntry.counteredBy?.role || attackTargetRole,
        target:       attackEntry.role,
        amount:       attackValue,
        effectPoints: 0,
      });
      return;
    }

    this.applyChainDamageToRole(attackTargetRole, attackValue, activePlayerState, reactivePlayerState, result);
    result.events.push({
      type:   'damage',
      actor:  attackEntry.role,
      target: attackTargetRole,
      amount: attackValue,
    });
  }

  resolveChainSkills(chain, activePlayerState, reactivePlayerState, result) {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const entry = chain[index];
      const skill = entry.profile.skill;

      if (entry.profile.kind !== 'skill' || !skill) continue;

      if (entry.resolution === 'blocked') {
        result.events.push({
          type:      'skill_blocked',
          actor:     entry.role,
          skillType: skill.type,
          by:        entry.counteredBy?.type || 'unknown',
        });
        continue;
      }

      if (entry.resolution === 'reflected') {
        if (this.isHarmfulSkill(skill)) {
          const sourceState = this.getPlayerStateByRole(entry.role, activePlayerState, reactivePlayerState);
          this.applyHarmfulSkill(
            skill,
            sourceState,
            sourceState,
            result,
            entry.role,
            entry.role,
            entry.counteredBy?.type || 'reflect'
          );
        } else {
          result.events.push({
            type:      'skill_blocked',
            actor:     entry.role,
            skillType: skill.type,
            by:        entry.counteredBy?.type || 'reflect',
          });
        }
        continue;
      }

      const sourceState = this.getPlayerStateByRole(entry.role, activePlayerState, reactivePlayerState);
      const targetRole  = this.getOpposingRole(entry.role);
      const targetState = this.getPlayerStateByRole(targetRole, activePlayerState, reactivePlayerState);

      if (this.isHarmfulSkill(skill)) {
        this.applyHarmfulSkill(skill, sourceState, targetState, result, entry.role, targetRole);
        continue;
      }

      if (skill.type === 'almighty' || skill.type === 'negate') {
        const removed = this.removeBlockableEffects(sourceState);
        result.events.push({
          type:           'cleanse',
          actor:          entry.role,
          removedEffects: removed.map(effect => effect.type),
          skillType:      skill.type,
          countered:      entry.usedAsCounter,
        });
        continue;
      }

      result.events.push({
        type:      entry.usedAsCounter ? 'counter_guard' : 'skill_ready',
        actor:     entry.role,
        skillType: skill.type,
      });
    }
  }

  applyChainDamageToRole(role, amount, activePlayerState, reactivePlayerState, result) {
    if (amount <= 0) return;

    if (role === 'active') {
      result.damage.toActive += amount;
      activePlayerState.currentHp = Math.max(0, activePlayerState.currentHp - amount);
      return;
    }

    result.damage.toReactive += amount;
    reactivePlayerState.currentHp = Math.max(0, reactivePlayerState.currentHp - amount);
  }

  getPlayerStateByRole(role, activePlayerState, reactivePlayerState) {
    return role === 'active' ? activePlayerState : reactivePlayerState;
  }

  getOpposingRole(role) {
    return role === 'active' ? 'reactive' : 'active';
  }

  resolveSkillPhase(active, reactive, activePlayerState, reactivePlayerState, result) {
    const activeSkill   = active.skill;
    const reactiveSkill = reactive.skill;

    if (!activeSkill && !reactiveSkill) return;

    const activeOutcome = {
      skill:         activeSkill,
      status:        activeSkill ? 'resolved' : 'none',
      usedAsCounter: false,
    };
    const reactiveOutcome = {
      skill:         reactiveSkill,
      status:        reactiveSkill ? 'resolved' : 'none',
      usedAsCounter: false,
    };

    if (this.isCounterSkill(activeSkill) && this.isCounterSkill(reactiveSkill)) {
      const comparison = this.compareSkillPower(activeSkill, reactiveSkill);

      if (comparison > 0) {
        reactiveOutcome.status     = 'blocked';
        activeOutcome.usedAsCounter = true;
      } else if (comparison < 0) {
        activeOutcome.status        = 'blocked';
        reactiveOutcome.usedAsCounter = true;
      }
    } else {
      if (this.isHarmfulSkill(activeSkill) && this.isCounterSkill(reactiveSkill) && this.compareSkillPower(reactiveSkill, activeSkill) > 0) {
        activeOutcome.status          = reactiveSkill.type === 'reflect' ? 'reflected' : 'blocked';
        reactiveOutcome.usedAsCounter = true;
      }

      if (this.isHarmfulSkill(reactiveSkill) && this.isCounterSkill(activeSkill) && this.compareSkillPower(activeSkill, reactiveSkill) > 0) {
        reactiveOutcome.status       = activeSkill.type === 'reflect' ? 'reflected' : 'blocked';
        activeOutcome.usedAsCounter  = true;
      }
    }

    this.executeSkillOutcome(activeOutcome,   reactiveOutcome, activePlayerState,   reactivePlayerState, result, 'active');
    this.executeSkillOutcome(reactiveOutcome, activeOutcome,   reactivePlayerState, activePlayerState,   result, 'reactive');
  }

  executeSkillOutcome(outcome, opposingOutcome, sourceState, targetState, result, sourceRole) {
    const skill = outcome.skill;
    if (!skill || outcome.status === 'none') return;

    const targetRole = sourceRole === 'active' ? 'reactive' : 'active';

    if (outcome.status === 'blocked') {
      result.events.push({
        type:      'skill_blocked',
        actor:     sourceRole,
        skillType: skill.type,
        by:        opposingOutcome.skill?.type || 'unknown',
      });
      return;
    }

    if (outcome.status === 'reflected') {
      this.applyHarmfulSkill(skill, sourceState, sourceState, result, sourceRole, sourceRole, opposingOutcome.skill?.type || 'reflect');
      return;
    }

    if (this.isHarmfulSkill(skill)) {
      this.applyHarmfulSkill(skill, sourceState, targetState, result, sourceRole, targetRole);
      return;
    }

    if (skill.type === 'almighty' || skill.type === 'negate') {
      const removed = this.removeBlockableEffects(sourceState);
      result.events.push({
        type:           'cleanse',
        actor:          sourceRole,
        removedEffects: removed.map(effect => effect.type),
        skillType:      skill.type,
        countered:      outcome.usedAsCounter,
      });
      return;
    }

    if (skill.type === 'reflect') {
      result.events.push({
        type:      outcome.usedAsCounter ? 'counter_guard' : 'skill_ready',
        actor:     sourceRole,
        skillType: skill.type,
      });
    }
  }

  applyHarmfulSkill(skill, sourceState, targetState, result, sourceRole, targetRole, reflectedBy = null) {
    if (skill.type === 'stun') {
      const effect = this.createEffect({
        type:      'stun',
        duration:  skill.duration,
        strength:  skill.effectPoints,
        sourceId:  skill.card.card_id,
        stackable: false,
        blockable: true,
      });

      const applied = this.addOrRefreshEffect(targetState, effect);
      result.events.push({
        type:       applied.action === 'ignored' ? 'effect_ignored' : 'effect_applied',
        actor:      sourceRole,
        target:     targetRole,
        effectType: 'stun',
        duration:   effect.duration,
        strength:   effect.strength,
        reflectedBy,
        action:     applied.action,
      });
      return;
    }

    if (skill.type === 'poison') {
      const effect = this.createEffect({
        type:      'poison',
        duration:  skill.duration,
        strength:  skill.poisonPercent,
        sourceId:  skill.card.card_id,
        stackable: false,
        blockable: true,
      });

      const applied = this.addOrRefreshEffect(targetState, effect);
      result.events.push({
        type:       applied.action === 'ignored' ? 'effect_ignored' : 'effect_applied',
        actor:      sourceRole,
        target:     targetRole,
        effectType: 'poison',
        duration:   effect.duration,
        strength:   effect.strength,
        reflectedBy,
        action:     applied.action,
      });
    }
  }

  resolveDamagePhase(active, reactive, activePlayerState, reactivePlayerState, result) {
    if (active.attackValue <= 0) return;

    // Reflect skill takes priority over the SPD/ACC check
    if (reactive.skill?.type === 'reflect' && this.canReflectDamage(reactive.skill, active)) {
      result.damage.toActive += active.attackValue;
      result.events.push({
        type:         'damage_reflected',
        actor:        'reactive',
        target:       'active',
        amount:       active.attackValue,
        effectPoints: reactive.skill.effectPoints,
      });
      return;
    }

    const reactiveDefenseCard = reactive.kind === 'defense' ? reactive.raw : null;
    const damage = this.calculateDamage(active.raw, reactiveDefenseCard);

    switch (damage.status) {
      case 'dodged':
        // Defender's speed outran attacker's accuracy — complete miss
        result.events.push({
          type:   'damage_dodged',
          actor:  'reactive',  // the one who dodged
          target: 'active',    // the attacker who missed
        });
        break;

      case 'countered':
        // DEF > ATK at equal SPD/ACC — difference rebounds to attacker
        result.damage.toActive += damage.toActive;
        result.events.push({
          type:      'damage',
          actor:     'reactive',
          target:    'active',
          amount:    damage.toActive,
          reflected: true,
        });
        break;

      case 'hit':
        // Attack connected and dealt net positive damage
        result.damage.toReactive += damage.toReactive;
        result.events.push({
          type:   'damage',
          actor:  'active',
          target: 'reactive',
          amount: damage.toReactive,
        });
        break;

      case 'blocked':
      default:
        // DEF absorbed the full attack (or no defense card was used and ATK was 0)
        result.events.push({
          type:  'damage_blocked',
          actor: 'reactive',
        });
        break;
    }
  }

  calculateDamage(activeCard, reactiveDefenseCard) {
    if (!activeCard) {
      return { toActive: 0, toReactive: 0, status: 'blocked' };
    }

    const attackValue = (Number(activeCard.atk) || 0) + (Number(activeCard.magic) || 0);
    const accuracy    = Number(activeCard.accuracy) || 0;

    // No defense card played — uncontested hit
    if (!reactiveDefenseCard) {
      return { toActive: 0, toReactive: attackValue, status: 'hit' };
    }

    const defenseValue = Number(reactiveDefenseCard.def) || 0;
    const speed        = Number(reactiveDefenseCard.spd) || 0;

    // ── Priority 1: Evade (Dodge) ────────────────────────────────────────────
    // Defender's SPD strictly beats attacker's ACC → complete miss
    if (speed > accuracy) {
      return { toActive: 0, toReactive: 0, status: 'dodged' };
    }

    // ── Priority 2: Counter-Attack ───────────────────────────────────────────
    // Speeds are tied AND defender's DEF exceeds the attack value → reflect diff
    if (speed === accuracy && defenseValue > attackValue) {
      return {
        toActive:   defenseValue - attackValue,
        toReactive: 0,
        status:     'countered',
      };
    }

    // ── Priority 3: Successful Hit ───────────────────────────────────────────
    // ACC >= SPD → attack connects; DEF may absorb some or all of it
    const netDamage = Math.max(0, attackValue - defenseValue);
    return {
      toActive:   0,
      toReactive: netDamage,
      status:     netDamage > 0 ? 'hit' : 'blocked',
    };
  }

  // FIX 2: was unconditionally returning true after the type guard.
  // Now reflects only when the skill's effect points strictly exceed incoming damage.
  // reflectSkill is a skill *profile* (from getSkillProfile), so its raw card is at .card.
  canReflectDamage(reflectSkill, activeProfile) {
    if (!reflectSkill || reflectSkill.type !== 'reflect') return false;
    const incomingDamage = activeProfile.attackValue || 0;
    return this.getSkillEffectPoints(reflectSkill.card) > incomingDamage;
  }

  isCounterSkill(skill) {
    return Boolean(skill && COUNTER_SKILLS.has(skill.type));
  }

  isHarmfulSkill(skill) {
    return Boolean(skill && HARMFUL_SKILLS.has(skill.type));
  }

  describeEvents(events, names = {}) {
    const activeName   = names.activeName   || names.selfName || 'Active';
    const reactiveName = names.reactiveName || names.selfName || 'Reactive';

    return events.map(event => {
      const actorName  = event.actor === 'active' ? activeName : reactiveName;
      const targetName = event.target === 'active'
        ? activeName
        : event.target === 'reactive'
          ? reactiveName
          : names.selfName || activeName;

      switch (event.type) {
        case 'poison_tick':
          return `☠️ *${targetName}* يتلقى *${event.amount}* ضرر سم.`;

        case 'stun_skip':
          return `🔒 *${targetName}* مثبَّت ويفقد هذا الدور.`;

        case 'skill_blocked':
          return `🛑 *${actorName}* فشل في تفعيل *${this.getSkillLabel(event.skillType)}* لأن *${this.getSkillLabel(event.by)}* كان أقوى.`;

        case 'effect_applied': {
          if (event.effectType === 'stun') {
            const prefix = event.reflectedBy ? '↩️ ' : '';
            return `${prefix}🔒 *${targetName}* أصبح تحت تأثير *Stun* لمدة *${event.duration}* دور.`;
          }

          if (event.effectType === 'poison') {
            const prefix     = event.reflectedBy ? '↩️ ' : '';
            const actionText = event.action === 'overwritten'
              ? 'تم استبدال السم السابق'
              : event.action === 'refreshed'
                ? 'تم تجديد السم'
                : 'أصيب بالسم';
            return `${prefix}☠️ *${targetName}* ${actionText} بقوة *${event.strength}%* لمدة *${event.duration}* دور.`;
          }
          break;
        }

        case 'effect_ignored':
          return `🧪 تأثير *${this.getSkillLabel(event.effectType)}* على *${targetName}* لم يتغير لأن الموجود أقوى.`;

        case 'cleanse': {
          if (!event.removedEffects.length) {
            return `💪 *${actorName}* استخدم *${this.getSkillLabel(event.skillType)}* لكن لم يكن عليه أي تأثيرات قابلة للمسح.`;
          }
          const removed = event.removedEffects.map(type => this.getSkillLabel(type)).join(' + ');
          return `💪 *${actorName}* استخدم *${this.getSkillLabel(event.skillType)}* ومسح: ${removed}.`;
        }

        case 'counter_guard':
          return `🔁 *${actorName}* ثبت دفاعه بمهارة *${this.getSkillLabel(event.skillType)}*.`;

        case 'skill_ready':
          return `🔁 *${actorName}* فعّل *${this.getSkillLabel(event.skillType)}*.`;

        case 'damage':
          return event.reflected
            ? `💥 *${targetName}* خسر *${event.amount} HP* كارتداد.`
            : `💥 *${targetName}* خسر *${event.amount} HP*.`;

        case 'damage_reflected':
          return `🔄 *${actorName}* عكس الهجوم بالكامل وتلقى *${targetName}* *${event.amount} HP* ضرر مرتد.`;

        case 'damage_dodged':
          // actor = defender who dodged, target = attacker who missed
          return `💨 *${actorName}* كان سريعاً جداً وتفادى هجوم *${targetName}* ببراعة!`;

        case 'damage_blocked':
          return `🛡️ *${actorName}* امتص الهجوم بالكامل — لم يخترق أي ضرر!`;

        default:
          return null;
      }

      return null;
    }).filter(Boolean);
  }

  getSkillLabel(type) {
    const labels = {
      reflect:    'Reflect',
      negate:     'Negate',
      almighty:   'Almighty',
      stun:       'Stun',
      poison:     'Poison',
      weapon_buff: 'Weapon Buff',
    };

    return labels[type] || type;
  }
}

module.exports = new CombatEngine();
module.exports.CombatEngine = CombatEngine;