'use strict';

/**
 * Track A 盘中重定价引擎
 *
 * 纯数学：只接受已知硬事实（比分、时间、红牌、阵容强度）。
 * 不接受未经验证的软信号（动量、压力指数等）。
 *
 * 核心公式：
 *   剩余比赛时间里，双方进球数仍服从 Poisson 分布，
 *   但 λ 按剩余时间比例缩放，并乘以红牌惩罚系数。
 *   最终：
 *     P(home wins) = sum_{i,j: homeScore+i > awayScore+j} P(home scores i more) * P(away scores j more)
 *
 * 加时赛支持：
 *   isKnockout=true 时，平局后进入 30 分钟加时（额外 λ），
 *   加时后仍平则点球大战（50/50 by default，可传 penaltySkill）。
 */

const fs = require('fs');
const path = require('path');

const PoissonModel = require('./poisson');
const { safeExecSync, loggers } = require('./logger');

const poisson = new PoissonModel();

// 红牌对进攻 λ 的惩罚系数（基于历史数据：10人队进球率约降至 72%）
const RED_CARD_LAMBDA_FACTOR = 0.72;

// 加时赛时长（分钟）
const EXTRA_TIME_MINUTES = 30;

// 点球大战缺数据时的默认命中率（对称 50/50）
const PENALTY_DEFAULT_RATE = 0.5;

// ── 历史点球命中率（按 FIFA 3 字母代码）──────────────────────────────────────
// 来源：RSSSF 主要赛事点球大战统计。缺数据回退 PENALTY_DEFAULT_RATE。
let _penaltyStats = null;
let _penaltyStatsPath = null;

function loadPenaltyStats() {
  if (_penaltyStats) return _penaltyStats;
  try {
    const p = _penaltyStatsPath
      || path.join(__dirname, '..', 'data', 'penalty-shootout-stats.json');
    _penaltyStats = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    _penaltyStats = { teams: {} };
  }
  return _penaltyStats;
}

/**
 * 取某队历史点球命中率（0-1）。缺数据/非法输入优雅回退到 0.5。
 * @param {string} [teamCode]  FIFA 3 字母代码（大小写均可）
 * @returns {number}
 */
function getPenaltyConversionRate(teamCode) {
  if (!teamCode) return PENALTY_DEFAULT_RATE;
  const code = String(teamCode).toUpperCase();
  const data = loadPenaltyStats();
  const entry = data && data.teams && data.teams[code];
  if (!entry || typeof entry.conversionRate !== 'number' || !isFinite(entry.conversionRate)) {
    return PENALTY_DEFAULT_RATE;
  }
  return Math.min(1, Math.max(0, entry.conversionRate));
}

function _binomPmf(n, k, pr) {
  if (k < 0 || k > n) return 0;
  let comb = 1;
  for (let i = 0; i < k; i++) comb = (comb * (n - i)) / (i + 1);
  return comb * Math.pow(pr, k) * Math.pow(1 - pr, n - k);
}

function _clamp01(x) {
  if (!isFinite(x)) return PENALTY_DEFAULT_RATE;
  return Math.min(1, Math.max(0, x));
}

/**
 * 点球大战胜率：标准 5 轮 + 突然死亡，双方每轮独立 Bernoulli(命中率)。
 * 返回主队获胜概率。p === q 时返回 0.5。
 * @param {number} p 主队历史命中率（0-1）
 * @param {number} q 客队历史命中率（0-1）
 * @returns {number}
 */
function penaltyShootoutWinProb(p, q) {
  p = _clamp01(p);
  q = _clamp01(q);

  // 5 轮二项分布：枚举双方进球数
  let homeWins = 0, tie = 0;
  for (let h = 0; h <= 5; h++) {
    const ph = _binomPmf(5, h, p);
    for (let a = 0; a <= 5; a++) {
      const joint = ph * _binomPmf(5, a, q);
      if (h > a) homeWins += joint;
      else if (h === a) tie += joint;
      // h < a → 客胜，无需累加（最终用 1 - home - tie 隐含）
    }
  }

  // 突然死亡：单轮主队胜率 vs 客队胜率
  const pHomeRound = p * (1 - q);
  const pAwayRound = (1 - p) * q;
  const denom = pHomeRound + pAwayRound;
  const pSudden = denom > 0 ? pHomeRound / denom : 0.5;

  return homeWins + tie * pSudden;
}

/**
 * 主函数：给定当前比赛状态，返回更新后的概率
 *
 * @param {object} params
 * @param {number} params.preLambdaHome     赛前主队 λ（90分钟）
 * @param {number} params.preLambdaAway     赛前客队 λ（90分钟）
 * @param {number} params.homeScore         当前主队比分
 * @param {number} params.awayScore         当前客队比分
 * @param {number} params.minuteElapsed     已过时间（0-90+）
 * @param {number} [params.addedTime=0]     补时分钟数（已知时传入）
 * @param {number} [params.homeRedCards=0]  主队红牌数
 * @param {number} [params.awayRedCards=0]  客队红牌数
 * @param {boolean}[params.isKnockout=false] 是否淘汰赛（平局→加时→点球）
 * @param {number} [params.penaltySkillHome] 主队点球大战胜率（显式覆盖；不传则按历史命中率算）
 * @param {number} [params.penaltySkillAway] 客队点球大战胜率（显式覆盖；不传则按历史命中率算）
 * @param {string} [params.homeTeamCode] 主队 FIFA 3 字母代码（用于查历史点球命中率）
 * @param {string} [params.awayTeamCode] 客队 FIFA 3 字母代码（用于查历史点球命中率）
 * @param {number} [params.maxGoals=6]
 *
 * @returns {{
 *   homeWin: number, draw: number, awayWin: number,
 *   homeWinAfterET: number, awayWinAfterET: number,
 *   penaltyHomeWin: number, penaltyAwayWin: number,
 *   lambdaHomeRemaining: number, lambdaAwayRemaining: number,
 *   minuteElapsed: number, minutesRemaining: number,
 *   source: 'live_reprice'
 * }}
 */
function reprice(params = {}) {
  return safeExecSync(() => _repriceCalc(params), {
    jobName: 'live-reprice',
    matchId: params?.matchId || null,
    source: 'live_reprice',
    stage: 'reprice_calc',
    reason: 'reprice_calculation_error',
    fallback: {
      homeWin: 0.333,
      draw: params?.isKnockout ? 0 : 0.334,
      awayWin: 0.333,
      homeWinAfterET: 0,
      awayWinAfterET: 0,
      penaltyHomeWin: 0,
      penaltyAwayWin: 0,
      lambdaHomeRemaining: params?.preLambdaHome || 1.2,
      lambdaAwayRemaining: params?.preLambdaAway || 1.0,
      minuteElapsed: params?.minuteElapsed || 0,
      minutesRemaining: Math.max(0, 90 - (params?.minuteElapsed || 0)),
      source: 'live_reprice',
    }
  }, loggers.liveReprice);
}

function _repriceCalc(params) {
  const {
    preLambdaHome,
    preLambdaAway,
    homeScore = 0,
    awayScore = 0,
    minuteElapsed = 0,
    addedTime = 0,
    homeRedCards = 0,
    awayRedCards = 0,
    isKnockout = false,
    penaltySkillHome,
    penaltySkillAway,
    homeTeamCode,
    awayTeamCode,
    maxGoals = 6,
  } = params;

  // ── 点球大战胜率 ────────────────────────────────────────────────────────
  // 显式传入 penaltySkill* 时优先（保留旧调用/测试兼容）；否则按双方历史命中率算。
  // 任一一队缺数据时回退 0.5（对称），整体仍保证 penHome + penAway = 1。
  let resolvedPenaltyHome, resolvedPenaltyAway;
  if (penaltySkillHome != null && penaltySkillAway != null) {
    resolvedPenaltyHome = penaltySkillHome;
    resolvedPenaltyAway = penaltySkillAway;
  } else {
    const homeRate = getPenaltyConversionRate(homeTeamCode);
    const awayRate = getPenaltyConversionRate(awayTeamCode);
    resolvedPenaltyHome = penaltyShootoutWinProb(homeRate, awayRate);
    resolvedPenaltyAway = 1 - resolvedPenaltyHome;
  }

  // ── 剩余时间 ──────────────────────────────────────────────────────────────
  const totalMinutes = 90 + addedTime;
  const elapsed = Math.min(minuteElapsed, totalMinutes);
  const minutesRemaining = Math.max(0, totalMinutes - elapsed);
  const timeRatio = minutesRemaining / 90; // 相对于完整 90 分钟

  // ── 红牌惩罚 ─────────────────────────────────────────────────────────────
  // 多张红牌时指数惩罚，实际上很少见
  const homeFactor = Math.pow(RED_CARD_LAMBDA_FACTOR, homeRedCards);
  const awayFactor = Math.pow(RED_CARD_LAMBDA_FACTOR, awayRedCards);

  // ── 剩余 λ ───────────────────────────────────────────────────────────────
  const lambdaHomeRemaining = preLambdaHome * timeRatio * homeFactor;
  const lambdaAwayRemaining = preLambdaAway * timeRatio * awayFactor;

  // ── 额外进球的概率矩阵（未来） ────────────────────────────────────────────
  const matrix = poisson.goalProbabilityMatrix(
    lambdaHomeRemaining,
    lambdaAwayRemaining,
    maxGoals
  );

  // ── 90 分钟后三种结果概率 ─────────────────────────────────────────────────
  let homeWin = 0, draw = 0, awayWin = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = matrix[i][j];
      const finalHome = homeScore + i;
      const finalAway = awayScore + j;

      if (finalHome > finalAway) homeWin += p;
      else if (finalHome === finalAway) draw += p;
      else awayWin += p;
    }
  }

  // 归一化防浮点误差
  const total90 = homeWin + draw + awayWin;
  homeWin /= total90;
  draw    /= total90;
  awayWin /= total90;

  // ── 加时赛（淘汰赛平局时）────────────────────────────────────────────────
  let homeWinAfterET  = 0;
  let awayWinAfterET  = 0;
  let penaltyHomeWin  = 0;
  let penaltyAwayWin  = 0;

  if (isKnockout && draw > 0) {
    const etResult = repriceExtraTime(
      preLambdaHome * homeFactor,
      preLambdaAway * awayFactor,
      resolvedPenaltyHome,
      resolvedPenaltyAway,
      maxGoals
    );

    // draw 的概率按 ET 结果分配
    homeWinAfterET = draw * etResult.homeWinInET;
    awayWinAfterET = draw * etResult.awayWinInET;
    penaltyHomeWin = draw * etResult.penaltyHomeWin;
    penaltyAwayWin = draw * etResult.penaltyAwayWin;

    // 最终胜率（含加时和点球）
    homeWin += homeWinAfterET + penaltyHomeWin;
    awayWin += awayWinAfterET + penaltyAwayWin;
    draw     = 0; // 淘汰赛不存在平局最终结果
  }

  return {
    homeWin:   round3(homeWin),
    draw:      round3(isKnockout ? 0 : draw),
    awayWin:   round3(awayWin),
    homeWinAfterET:  round3(homeWinAfterET),
    awayWinAfterET:  round3(awayWinAfterET),
    penaltyHomeWin:  round3(penaltyHomeWin),
    penaltyAwayWin:  round3(penaltyAwayWin),
    lambdaHomeRemaining: round3(lambdaHomeRemaining),
    lambdaAwayRemaining: round3(lambdaAwayRemaining),
    minuteElapsed: elapsed,
    minutesRemaining,
    source: 'live_reprice',
  };
}

/**
 * 加时赛（30 分钟）后的概率拆解
 */
function repriceExtraTime(lambdaHome90, lambdaAway90, penHome, penAway, maxGoals) {
  return safeExecSync(() => _repriceExtraTimeCalc(lambdaHome90, lambdaAway90, penHome, penAway, maxGoals), {
    jobName: 'live-reprice',
    source: 'live_reprice',
    stage: 'reprice_extra_time',
    reason: 'extra_time_reprice_error',
    fallback: { homeWinInET: 0, awayWinInET: 0, penaltyHomeWin: 0, penaltyAwayWin: 0 }
  }, loggers.liveReprice);
}

function _repriceExtraTimeCalc(lambdaHome90, lambdaAway90, penHome, penAway, maxGoals) {
  const etRatio = EXTRA_TIME_MINUTES / 90;
  const etLambdaHome = lambdaHome90 * etRatio;
  const etLambdaAway = lambdaAway90 * etRatio;

  const matrix = poisson.goalProbabilityMatrix(etLambdaHome, etLambdaAway, maxGoals);

  let homeWinInET = 0, awayWinInET = 0, drawAfterET = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = matrix[i][j];
      if (i > j) homeWinInET += p;
      else if (i < j) awayWinInET += p;
      else drawAfterET += p;
    }
  }

  // 点球大战
  const penaltyHomeWin = drawAfterET * penHome;
  const penaltyAwayWin = drawAfterET * penAway;

  return { homeWinInET, awayWinInET, penaltyHomeWin, penaltyAwayWin };
}

/**
 * 比较赛前快照和盘中概率，返回概率漂移摘要
 * 用于 moment 记录里存"这个触发点改变了多少"
 */
function probDelta(prePred, liveProb) {
  return safeExecSync(() => ({
    deltaHomeWin: round3((liveProb.homeWin ?? 0) - (prePred.homeWin ?? prePred.homeWinProb ?? 0)),
    deltaDraw:    round3((liveProb.draw    ?? 0) - (prePred.draw    ?? prePred.drawProb    ?? 0)),
    deltaAwayWin: round3((liveProb.awayWin ?? 0) - (prePred.awayWin ?? prePred.awayWinProb ?? 0)),
  }), {
    jobName: 'live-reprice',
    source: 'live_reprice',
    stage: 'prob_delta_calc',
    reason: 'prob_delta_calculation_error',
    fallback: { deltaHomeWin: 0, deltaDraw: 0, deltaAwayWin: 0 }
  }, loggers.liveReprice);
}

function round3(n) {
  return Math.round((n ?? 0) * 1000) / 1000;
}

module.exports = {
  reprice,
  repriceExtraTime,
  probDelta,
  getPenaltyConversionRate,
  penaltyShootoutWinProb,
  loadPenaltyStats,
};
