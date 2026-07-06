'use strict';

/**
 * Score Writeback Service
 *
 * 负责终场比分回写到 SQLite matches 表 (home_score, away_score, played = 1)。
 *
 * 核心设计原则：
 * 1. 权威来源优先级：优先使用 FIFA API 终场比分与事件，降级或无匹配时使用 ESPN fallback 比分。
 * 2. 严格幂等：如果 matches 表中对应记录已经 played = 1 且有合法终场比分，重复执行时绝不覆盖已正确保存的比分。
 * 3. 边界规范：不修改实时状态机，不修改预测公式，不介入点球大战决胜比分语义（仅记录常规与加时进球终场比分）。
 */

const { db } = require('../db');
const teamResolver = require('../team_resolver');

const FINISHED_STATUSES = new Set([
  'STATUS_FINAL',
  'STATUS_FULL_TIME',
  'post',
  'finished',
  '0', // FIFA MatchStatus 0 = finished
]);

/**
 * 将球队输入（ESPN Team ID / FIFA Code / 球队名称）解析为 matches 表中使用的 ratings_id
 * @param {string|number} teamInput
 * @returns {string|null}
 */
function resolveTeamToRatingsId(teamInput) {
  if (teamInput === null || teamInput === undefined || teamInput === '') return null;
  const str = String(teamInput).trim();
  
  // 1. 优先尝试按 ESPN ID 反查
  const byEspnId = teamResolver.getRatingsIdByEspnId(str);
  if (byEspnId) return byEspnId;

  // 2. 使用全功能名称与简写解析
  const resolved = teamResolver.resolve(str);
  return resolved ? resolved.ratings_id : null;
}

/**
 * 执行终场比分回写
 * @param {object} opts
 * @param {string|number} [opts.espnId] - ESPN 比赛 ID
 * @param {string|number} opts.homeTeam - 主队名称/ID/缩写
 * @param {string|number} opts.awayTeam - 客队名称/ID/缩写
 * @param {number|string} opts.homeScore - 终场主队比分
 * @param {number|string} opts.awayScore - 终场客队比分
 * @param {string|number} [opts.statusName] - 比赛状态描述 (e.g. 'STATUS_FINAL', 'post', 0)
 * @param {string} [opts.matchDate] - 比赛日期前缀 'YYYY-MM-DD'
 * @param {string} [opts.source] - 比分数据源 ('fifa' | 'espn')
 * @param {string} [opts.stage] - 阶段标签（如 'R32'/'QF'/'SF'/'Final'）；淘汰赛 upsert 插入时
 *   写入 matches.stage。拿不到则落 'Knockout' 兜底，不留空。
 * @param {string} [opts.venue] - 比赛场馆名（可选）
 * @param {object} [opts.logger] - 日志记录器
 * @returns {object} 结果 `{ success: boolean, updated: boolean, inserted?: boolean, reason?: string, matchId?: number, stage?: string }`
 */
function writebackMatchScore(opts) {
  const {
    espnId = null,
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    statusName = 'STATUS_FINAL',
    matchDate = null,
    stage = null,
    venue = null,
    source = 'unknown',
    logger = console,
  } = opts || {};

  // 1. 校验比赛终场状态
  if (statusName === null || statusName === undefined || statusName === '' || !FINISHED_STATUSES.has(String(statusName).trim())) {
    return { success: false, updated: false, reason: 'not_finished' };
  }

  // 2. 校验比分数值有效性
  const numHomeScore = Number.parseInt(homeScore, 10);
  const numAwayScore = Number.parseInt(awayScore, 10);
  if (!Number.isFinite(numHomeScore) || !Number.isFinite(numAwayScore)) {
    if (logger && logger.warn) {
      logger.warn(`[score-writeback] Invalid scores received: home=${homeScore}, away=${awayScore}`);
    }
    return { success: false, updated: false, reason: 'invalid_score' };
  }

  // 3. 解析球队到 DB matches 表的 ratings_id
  const homeId = resolveTeamToRatingsId(homeTeam);
  const awayId = resolveTeamToRatingsId(awayTeam);
  if (!homeId || !awayId) {
    if (logger && logger.warn) {
      logger.warn(`[score-writeback] Failed to resolve teams: homeInput="${homeTeam}" -> ${homeId}, awayInput="${awayTeam}" -> ${awayId}`);
    }
    return { success: false, updated: false, reason: 'team_resolve_failed' };
  }

  if (homeId === awayId) {
    return { success: false, updated: false, reason: 'identical_teams' };
  }

  // 4. 在 matches 表中查询比赛行
  const rows = db.prepare(`
    SELECT id, home_team_id, away_team_id, home_score, away_score, played, match_date
    FROM matches
    WHERE (home_team_id = ? AND away_team_id = ?)
       OR (home_team_id = ? AND away_team_id = ?)
  `).all(homeId, awayId, awayId, homeId);

  if (!rows || rows.length === 0) {
    // 淘汰赛 / 未播种赛程自愈式 upsert：
    // 原逻辑在这里直接返回 match_not_found，导致小组赛之外的所有终场比分（整个淘汰赛阶段）
    // 都静默回写失败、matches 表永远缺失这部分数据。改为直接插入一行：
    // - group_id = NULL：SQL matches 表并非赛程权威来源（bracket JSON 才是），无需为其维护赛程
    // - stage：由调用方透传（ESPN season.slug 映射），拿不到则落 'Knockout' 兜底，不留空
    // - 幂等：本分支仅在“查无此行”时触发；插入后该行已存在，后续重复回写会走下方第 6 步
    //   幂等保护（played=1 且比分一致→already_written；不一致→idempotent_protected），不重复插入。
    const writebackStage = (stage && String(stage).trim()) || 'Knockout';
    const insertStmt = db.prepare(`
      INSERT INTO matches (group_id, home_team_id, away_team_id, home_score, away_score, played, match_date, venue, stage)
      VALUES (NULL, ?, ?, ?, ?, 1, ?, ?, ?)
    `);
    const info = insertStmt.run(homeId, awayId, numHomeScore, numAwayScore, matchDate || null, venue || null, writebackStage);
    const newId = Number(info.lastInsertRowid);
    if (logger && logger.info) {
      logger.info(`[score-writeback] Upserted previously-missing match row id=${newId} (${homeId} ${numHomeScore}-${numAwayScore} ${awayId}), stage=${writebackStage}, source=${source}, espnId=${espnId || 'N/A'}`);
    }
    return {
      success: true,
      updated: true,
      inserted: true,
      reason: 'upserted_new_match',
      matchId: newId,
      homeScore: numHomeScore,
      awayScore: numAwayScore,
      stage: writebackStage,
    };
  }

  // 如果有多条匹配记录，按日期排序，优选未完成(played=0)且日期较接近的
  let targetRow = null;
  if (rows.length === 1) {
    targetRow = rows[0];
  } else {
    // 如果传了 matchDate，优选同日期记录
    if (matchDate && typeof matchDate === 'string') {
      const datePrefix = matchDate.slice(0, 10);
      targetRow = rows.find(r => r.match_date && r.match_date.startsWith(datePrefix));
    }
    // 其次优选 played === 0 的第一条
    if (!targetRow) {
      targetRow = rows.find(r => r.played === 0) || rows[0];
    }
  }

  // 5. 检查数据库记录方向与当前数据的映射关系（防止主客队颠倒）
  const isFlipped = (targetRow.home_team_id === awayId && targetRow.away_team_id === homeId);
  const dbHomeScore = isFlipped ? numAwayScore : numHomeScore;
  const dbAwayScore = isFlipped ? numHomeScore : numAwayScore;

  // 6. 幂等性与防覆盖检查 (Idempotency Guard)
  if (targetRow.played === 1 && targetRow.home_score !== null && targetRow.away_score !== null) {
    if (targetRow.home_score === dbHomeScore && targetRow.away_score === dbAwayScore) {
      // 比分完全一致，直接幂等返回
      return {
        success: true,
        updated: false,
        reason: 'already_written',
        matchId: targetRow.id,
        homeScore: targetRow.home_score,
        awayScore: targetRow.away_score,
      };
    } else {
      // 绝不覆盖原有正确记录
      if (logger && logger.warn) {
        logger.warn(`[score-writeback] Idempotency guard: Match id=${targetRow.id} (${targetRow.home_team_id} vs ${targetRow.away_team_id}) is already completed with score ${targetRow.home_score}-${targetRow.away_score}. Refusing to overwrite with new score ${dbHomeScore}-${dbAwayScore} (source=${source}).`);
      }
      return {
        success: true,
        updated: false,
        reason: 'idempotent_protected',
        matchId: targetRow.id,
        homeScore: targetRow.home_score,
        awayScore: targetRow.away_score,
      };
    }
  }

  // 7. 执行事务回写
  const updateStmt = db.prepare(`
    UPDATE matches
    SET home_score = ?, away_score = ?, played = 1
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    updateStmt.run(dbHomeScore, dbAwayScore, targetRow.id);
  });
  tx();

  if (logger && logger.info) {
    logger.info(`[score-writeback] Successfully wrote back final score for match id=${targetRow.id} (${targetRow.home_team_id} ${dbHomeScore}-${dbAwayScore} ${targetRow.away_team_id}), source=${source}, espnId=${espnId || 'N/A'}`);
  }

  return {
    success: true,
    updated: true,
    matchId: targetRow.id,
    homeScore: dbHomeScore,
    awayScore: dbAwayScore,
  };
}

module.exports = {
  writebackMatchScore,
  resolveTeamToRatingsId,
  FINISHED_STATUSES,
};
