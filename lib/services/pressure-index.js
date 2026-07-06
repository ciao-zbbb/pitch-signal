'use strict';

/**
 * Pressure Index — Track B 威胁动量指数
 *
 * 只展示，不进概率。等验证后才允许升级成 calibrated mover。
 *
 * 计算方式：两个时间点之间的累积统计差值（delta），
 * 映射到 0-100 的压力指数。
 *
 * 信号及权重（均来自 ESPN boxscore/statistics，无需第三方）：
 *   shots_on_target  35%  — 最强进攻信号
 *   total_shots      20%  — 进攻数量
 *   corners          20%  — 积极推进
 *   possession       15%  — 场上控制（非 delta，直接用比例）
 *   crosses          10%  — 危险传中
 *
 * Surge 检测（Jordan/Algeria 模式）：
 *   当一支球队在最近 5 个快照中至少 3 个 PI ≥ 65（滑动窗口，容忍单分钟抖动）
 *   且期间未进球，触发 "sustained_pressure_alert"。
 */

const { db } = require('../db');

// ─── 权重定义 ─────────────────────────────────────────────────────────────────
const WEIGHTS = {
  shotsOnTarget: 0.35,
  totalShots:    0.20,
  corners:       0.20,
  possession:    0.15,
  crosses:       0.10,
};

// ─── 每 15 分钟的"满压"参考值（用于归一化）──────────────────────────────────
const MAX_15MIN = {
  shotsOnTarget: 4,   // 15min 内 4 次射正 = 极高压力
  totalShots:    7,
  corners:       5,
  possession:    70,  // % 绝对值（不是 delta）
  crosses:       5,
};

/**
 * 从两个累积统计快照计算 Pressure Index
 *
 * @param {StatSnapshot} prev   - 早前快照（或 null 表示比赛开始）
 * @param {StatSnapshot} curr   - 当前快照
 * @param {number} windowMin    - 两个快照相差的分钟数（用于归一化）
 * @returns {{ home: number, away: number, dominantTeam: 'home'|'away'|'even', components: object }}
 */
function computePressureIndex(prev, curr, windowMin = 15) {
  const scale = 15 / Math.max(windowMin, 1); // 换算到 per-15-min

  const homePi = calcTeamPI(prev?.home, curr.home, scale);
  const awayPi = calcTeamPI(prev?.away, curr.away, scale);

  const diff = homePi - awayPi;
  const dominantTeam = Math.abs(diff) < 8 ? 'even'
    : diff > 0 ? 'home' : 'away';

  return {
    home: round1(homePi),
    away: round1(awayPi),
    dominantTeam,
    diff: round1(diff),
    components: {
      home: calcComponents(prev?.home, curr.home, scale),
      away: calcComponents(prev?.away, curr.away, scale),
    },
  };
}

function calcTeamPI(prev, curr, scale) {
  const delta = statDelta(prev, curr);

  const sot  = clamp01(delta.shotsOnTarget * scale / MAX_15MIN.shotsOnTarget);
  const shot = clamp01(delta.totalShots    * scale / MAX_15MIN.totalShots);
  const corn = clamp01(delta.corners       * scale / MAX_15MIN.corners);
  const poss = clamp01(curr.possessionPct / MAX_15MIN.possession);
  const cros = clamp01(delta.crosses       * scale / MAX_15MIN.crosses);

  return (
    sot  * WEIGHTS.shotsOnTarget +
    shot * WEIGHTS.totalShots    +
    corn * WEIGHTS.corners       +
    poss * WEIGHTS.possession    +
    cros * WEIGHTS.crosses
  ) * 100;
}

function calcComponents(prev, curr, scale) {
  const d = statDelta(prev, curr);
  return {
    shotsOnTargetDelta: d.shotsOnTarget,
    totalShotsDelta:    d.totalShots,
    cornersDelta:       d.corners,
    possessionPct:      curr.possessionPct,
    crossesDelta:       d.crosses,
  };
}

function statDelta(prev, curr) {
  return {
    shotsOnTarget: delta(prev?.shotsOnTarget, curr.shotsOnTarget),
    totalShots:    delta(prev?.totalShots,    curr.totalShots),
    corners:       delta(prev?.corners,       curr.corners),
    crosses:       delta(prev?.crosses,       curr.crosses),
  };
}

function delta(prev, curr) {
  const p = Number(prev ?? 0);
  const c = Number(curr ?? 0);
  return Math.max(0, c - p); // 防止计时器重置产生负数
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function round1(v)  { return Math.round(v * 10) / 10; }

// ─── ESPN stats 解析 ──────────────────────────────────────────────────────────

/**
 * 把 ESPN boxscore.teams 格式解析成标准 StatSnapshot
 * @param {Array} teams  - ESPN boxscore.teams
 * @returns {{ home: RawStats, away: RawStats } | null}
 */
function parseEspnStats(teams) {
  if (!Array.isArray(teams) || teams.length < 2) return null;

  const parse = (team) => {
    const get = (name) => {
      const s = team.statistics?.find(s => s.name === name);
      return parseFloat(s?.displayValue ?? '0') || 0;
    };
    return {
      shotsOnTarget: get('shotsOnTarget'),
      totalShots:    get('totalShots'),
      corners:       get('wonCorners'),
      possessionPct: get('possessionPct'),
      crosses:       get('accurateCrosses'),
      saves:         get('saves'),
    };
  };

  // ESPN: competitors[0]=home, [1]=away  or via homeAway field
  const homeTeam = teams.find(t => t.homeAway === 'home') ?? teams[0];
  const awayTeam = teams.find(t => t.homeAway === 'away') ?? teams[1];

  return { home: parse(homeTeam), away: parse(awayTeam) };
}

// ─── Surge 检测 ───────────────────────────────────────────────────────────────

/**
 * 检测"持续高压但未进球"的 Jordan/Algeria 模式
 *
 * @param {string} matchId
 * @param {'home'|'away'} team
 * @param {number} currentMinute
 * @returns {{ surge: boolean, sustainedMinutes: number, consecutiveHighPI: number }}
 */
function detectSurge(matchId, team, currentMinute, opts = {}) {
  const windowSize = opts.windowSize ?? 5;
  const threshold = opts.threshold ?? 65;
  const minHigh = opts.minHigh ?? 3;

  // 取最近 windowSize 条压力快照
  const rows = db.prepare(`
    SELECT minute, pressure_home, pressure_away
    FROM match_live_stats
    WHERE match_id = ?
    ORDER BY minute DESC LIMIT ?
  `).all(String(matchId), windowSize);

  if (rows.length < minHigh) {
    return { surge: false, sustainedMinutes: 0, consecutiveHighPI: 0, highCount: 0, suppressedByGoal: false };
  }

  const piField = team === 'home' ? 'pressure_home' : 'pressure_away';
  // 滑动窗口：最近 windowSize 个快照中至少 minHigh 个 ≥ 阈值即视为持续高压。
  // 修复：原逻辑用"从最新往回数、遇第一个 < 阈值就 break"的严格连续计数，而压力指数
  // 本身是逐分钟 delta，单个低谷即打断连续计数，导致真实存在的 3 分钟猛攻只要中间
  // 夹一次抖动就永远不报警（系统性漏报）。
  const highCount = rows.filter(r => (r[piField] ?? 0) >= threshold).length;
  if (highCount < minHigh) {
    return { surge: false, sustainedMinutes: 0, consecutiveHighPI: highCount, highCount, suppressedByGoal: false };
  }

  // 期间未进球：窗口内该队已取得进球则压力已释放，不报警（规格要求）
  const windowStart = rows[rows.length - 1].minute;
  const windowEnd = rows[0].minute;
  if (goalScoredInWindow(matchId, team, windowStart, windowEnd, opts.matchState)) {
    return { surge: false, sustainedMinutes: 0, consecutiveHighPI: highCount, highCount, suppressedByGoal: true };
  }

  const sustainedMinutes = Math.max(0, windowEnd - windowStart);
  return { surge: true, sustainedMinutes, consecutiveHighPI: highCount, highCount, suppressedByGoal: false };
}

/**
 * 窗口内某队是否取得进球（"持续高压但未进球"的否决条件）。
 * 若能拿到该队的 ESPN id 则仅查该队；否则退化为"窗口内任意进球"保守否决。
 */
function goalScoredInWindow(matchId, team, startMinute, endMinute, matchState) {
  let teamId = null;
  if (matchState) teamId = team === 'home' ? matchState.homeTeamId : matchState.awayTeamId;

  const sql = `
    SELECT 1 FROM match_moments
    WHERE match_id = ? AND type = 'goal'
      AND minute BETWEEN ? AND ?
      ${teamId ? 'AND team_id = ?' : ''}
    LIMIT 1
  `;
  const params = teamId
    ? [String(matchId), startMinute, endMinute, teamId]
    : [String(matchId), startMinute, endMinute];
  return !!db.prepare(sql).get(...params);
}

// ─── DB 读写 ──────────────────────────────────────────────────────────────────

/**
 * 保存统计快照 + 当时的压力指数
 */
function saveStatSnapshot(matchId, minute, rawStats, pressureResult) {
  db.prepare(`
    INSERT OR REPLACE INTO match_live_stats
      (match_id, minute, home_shots, away_shots, home_sot, away_sot,
       home_corners, away_corners, home_poss, away_poss, home_crosses, away_crosses,
       pressure_home, pressure_away, pressure_dominant, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(matchId), minute,
    rawStats.home.totalShots,    rawStats.away.totalShots,
    rawStats.home.shotsOnTarget, rawStats.away.shotsOnTarget,
    rawStats.home.corners,       rawStats.away.corners,
    rawStats.home.possessionPct, rawStats.away.possessionPct,
    rawStats.home.crosses,       rawStats.away.crosses,
    pressureResult.home, pressureResult.away, pressureResult.dominantTeam,
    new Date().toISOString(),
  );
}

/**
 * 取最近一条快照（用于 delta 计算）
 */
function getPrevSnapshot(matchId) {
  const row = db.prepare(`
    SELECT * FROM match_live_stats WHERE match_id = ? ORDER BY minute DESC LIMIT 1
  `).get(String(matchId));
  if (!row) return null;
  return {
    home: { shotsOnTarget: row.home_sot, totalShots: row.home_shots, corners: row.home_corners, possessionPct: row.home_poss, crosses: row.home_crosses },
    away: { shotsOnTarget: row.away_sot, totalShots: row.away_shots, corners: row.away_corners, possessionPct: row.away_poss, crosses: row.away_crosses },
    minute: row.minute,
  };
}

/**
 * 取一场比赛的完整压力曲线
 */
function getPressureCurve(matchId) {
  return db.prepare(`
    SELECT minute, pressure_home, pressure_away, pressure_dominant, captured_at
    FROM match_live_stats WHERE match_id = ?
    ORDER BY minute ASC
  `).all(String(matchId));
}

module.exports = {
  computePressureIndex,
  parseEspnStats,
  detectSurge,
  saveStatSnapshot,
  getPrevSnapshot,
  getPressureCurve,
};
