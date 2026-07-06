#!/usr/bin/env node
'use strict';

/**
 * P3-3 点球模型测试
 * - 历史命中率读取 + 缺数据回退 0.5
 * - 点球大战胜率方向正确（强队 > 0.5）
 * - reprice() 在淘汰赛平局时按双方历史命中率分配 penaltyHomeWin/AwayWin
 * - 缺数据优雅回退到对称 0.5
 * - 显式 penaltySkill* 覆盖仍生效
 */

const assert = require('assert');
const { reprice, getPenaltyConversionRate, penaltyShootoutWinProb } = require('../lib/live-reprice');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('=== P3-3 penalty-model ===');

// ── 1. 历史命中率读取 + 缺数据回退 ─────────────────────────────────────────
ok('GER 命中率≈0.865', Math.abs(getPenaltyConversionRate('GER') - 0.865) < 1e-9);
ok('小写 arg 命中率≈0.776', Math.abs(getPenaltyConversionRate('arg') - 0.776) < 1e-9);
ok('未知球队回退 0.5', getPenaltyConversionRate('ZZZ') === 0.5);
ok('空输入回退 0.5', getPenaltyConversionRate(null) === 0.5);
ok('非法值回退 0.5', getPenaltyConversionRate('NOPE') === 0.5);

// ── 2. 点球大战胜率 ───────────────────────────────────────────────────────
ok('对称 0.5 → 0.5', Math.abs(penaltyShootoutWinProb(0.5, 0.5) - 0.5) < 1e-9);
const pGerArg = penaltyShootoutWinProb(0.865, 0.776);
ok('强队(主)胜率 > 0.5', pGerArg > 0.5);
ok('强队(主)胜率 < 1', pGerArg < 1);
const pArgGer = penaltyShootoutWinProb(0.776, 0.865);
ok('方向对称 (p + q ≈ 1)', Math.abs(pGerArg + pArgGer - 1) < 1e-9);
ok('弱队(主)胜率 < 0.5', pArgGer < 0.5);

// ── 3. reprice 淘汰赛平局：按历史命中率分配点球概率 ────────────────────────
const baseKnockout = {
  preLambdaHome: 1.2,
  preLambdaAway: 1.0,
  homeScore: 0,
  awayScore: 0,
  minuteElapsed: 90,
  isKnockout: true,
};

const withCodes = reprice({ ...baseKnockout, homeTeamCode: 'GER', awayTeamCode: 'ARG' });
ok('GER vs ARG：penaltyHomeWin > penaltyAwayWin（方向正确）',
  withCodes.penaltyHomeWin > withCodes.penaltyAwayWin);
ok('penalty 概率为正', withCodes.penaltyHomeWin > 0 && withCodes.penaltyAwayWin > 0);

// ── 4. 缺数据回退对称 0.5 ────────────────────────────────────────────────
const noCodes = reprice({ ...baseKnockout, homeTeamCode: 'ZZZ', awayTeamCode: 'NOPE' });
ok('缺数据：penaltyHomeWin === penaltyAwayWin（对称）',
  Math.abs(noCodes.penaltyHomeWin - noCodes.penaltyAwayWin) < 1e-9);
ok('缺数据：点球概率非零', noCodes.penaltyHomeWin > 0);

// 完全不传代码也应回退对称
const noCodesAtAll = reprice(baseKnockout);
ok('不传代码：对称回退',
  Math.abs(noCodesAtAll.penaltyHomeWin - noCodesAtAll.penaltyAwayWin) < 1e-9);

// ── 5. 显式 override 仍生效 ─────────────────────────────────────────────
const overridden = reprice({ ...baseKnockout, penaltySkillHome: 0.8, penaltySkillAway: 0.2 });
ok('显式 override：penaltyHomeWin > penaltyAwayWin',
  overridden.penaltyHomeWin > overridden.penaltyAwayWin);
// 显式值直接乘，0.8/0.2 比例（用占比检查，避开双重舍入）
const oSum = overridden.penaltyHomeWin + overridden.penaltyAwayWin;
ok('显式 override 主队占比≈0.8', Math.abs(overridden.penaltyHomeWin / oSum - 0.8) < 1e-2);

// ── 6. 常规时间不受影响（非淘汰赛无点球字段含义）─────────────────────────
const normal = reprice({ ...baseKnockout, isKnockout: false, homeTeamCode: 'GER', awayTeamCode: 'ARG' });
ok('常规时间 draw 不为 0', normal.draw > 0);
ok('常规时间 penaltyHomeWin = 0', normal.penaltyHomeWin === 0);

console.log(`\n${passed} passed`);
