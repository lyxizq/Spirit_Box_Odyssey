// 服务端战斗复算（2026-10-31）：与 game.js 的 simulateBattle / bossEnemyOf 逐行同源移植。
// 上游以 game.js 为唯一数值口径——客户端战斗公式若改动，本文件必须同步，否则
// PvP 胜负与妖王伤害的「客户端表现」和「服务端结算」会出现口径漂移。
// 用途：/api/pvp/fight 的胜负、/api/boss/hit 与 /api/guild/boss/hit 的伤害一律由
// 服务端用双方快照复算，客户端上报的 win / damage 不再采信。
// 随机数用服务端 Math.random：客户端无法预测单场结果，也无法复现对账（设计取舍）。

// 竞技场快照结构：{atk, hp, def, crit, critMult, lifesteal, dr, pierce}
export function simulateBattle(player, enemy) {
  let php = player.hp;
  let ehp = enemy.hp;
  let rounds = 0;
  let dealt = 0;
  let taken = 0;
  let crits = 0;

  while (php > 0 && ehp > 0 && rounds < 120) {
    rounds++;

    const crit = Math.random() < player.crit;
    let dmg = Math.max(1, player.atk - enemy.def * (1 - player.pierce));
    dmg *= 0.9 + Math.random() * 0.2;
    if (crit) dmg *= player.critMult;
    dmg = Math.max(1, Math.floor(dmg));

    ehp -= dmg;
    dealt += dmg;
    if (crit) crits++;
    if (player.lifesteal > 0) {
      const heal = Math.floor(dmg * player.lifesteal);
      php = Math.min(player.hp, php + heal);
    }
    if (ehp <= 0) break;

    const edmg = Math.max(1, Math.floor(Math.max(1, enemy.atk - player.def) * (1 - player.dr)));
    php -= edmg;
    taken += edmg;
  }

  return {
    win: ehp <= 0 && php > 0,
    rounds,
    dealt,
    taken,
    crits,
    hpLeft: Math.max(0, Math.floor(php)),
    enemyLeft: Math.max(0, Math.floor(ehp)),
  };
}

// 世界/盟主妖王战力随血池伸缩（game.js:12238 bossEnemyOf / 12627 guildBossEnemyOf，两处同款）
export function bossEnemyOf(maxHp) {
  const s = Math.sqrt(maxHp || 1);
  return { hp: 1e15, atk: s * 0.5, def: s * 0.04, crit: 0.05, critMult: 2, lifesteal: 0, dr: 0, pierce: 0 };
}
