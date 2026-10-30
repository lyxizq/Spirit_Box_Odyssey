/**
 * BattleSim · 回合制战斗模拟（game.js simulateBattle 的 TS 同源移植）
 *
 * 公式保持一致：伤害 = max(1, 攻 - 防×(1-破甲)) × 0.9~1.1 随机 ×(暴击? 暴伤:1)；
 * 敌方反打 = max(1, 敌攻 - 我防) ×(1-减伤)；吸血按伤害比例回血（不溢出上限）；
 * 120 回合未分胜负判超时。改数值以 game.js 为唯一上游，同步改这里。
 */

export interface CombatStats {
    atk: number; hp: number; def: number;
    crit: number; critMult: number;
    lifesteal: number; dr: number; pierce: number;
}

export interface EnemyStats { hp: number; atk: number; def: number; }

export interface BattleEvent {
    side: 'player' | 'enemy';
    round: number;
    damage: number;
    crit?: boolean;
    heal?: number;
    playerHp: number;
    enemyHp: number;
}

export interface BattleResult {
    win: boolean; timeout: boolean; rounds: number;
    dealt: number; taken: number; crits: number;
    hpLeft: number; enemyLeft: number;
    events: BattleEvent[];
}

export function simulateBattle(player: CombatStats, enemy: EnemyStats): BattleResult {
    let php = player.hp;
    let ehp = enemy.hp;
    let rounds = 0, dealt = 0, taken = 0, crits = 0;
    const events: BattleEvent[] = [];

    while (php > 0 && ehp > 0 && rounds < 120) {
        rounds++;
        const crit = Math.random() < player.crit;
        let dmg = Math.max(1, player.atk - enemy.def * (1 - player.pierce));
        dmg *= 0.9 + Math.random() * 0.2;
        if (crit) dmg *= player.critMult;
        dmg = Math.max(1, Math.floor(dmg));
        ehp -= dmg; dealt += dmg;
        if (crit) crits++;
        let heal = 0;
        if (player.lifesteal > 0) {
            heal = Math.floor(dmg * player.lifesteal);
            php = Math.min(player.hp, php + heal);
        }
        events.push({ side: 'player', round: rounds, damage: dmg, crit, heal,
            playerHp: Math.max(0, php), enemyHp: Math.max(0, ehp) });
        if (ehp <= 0) break;

        let edmg = Math.max(1, enemy.atk - player.def);
        edmg = Math.max(1, Math.floor(edmg * (1 - player.dr)));
        php -= edmg; taken += edmg;
        events.push({ side: 'enemy', round: rounds, damage: edmg,
            playerHp: Math.max(0, php), enemyHp: Math.max(0, ehp) });
    }

    return {
        win: ehp <= 0 && php > 0,
        timeout: rounds >= 120 && ehp > 0 && php > 0,
        rounds, dealt, taken, crits,
        hpLeft: Math.max(0, Math.floor(php)),
        enemyLeft: Math.max(0, Math.floor(ehp)),
        events,
    };
}
