'use strict';

/**
 * Match Moment Sync Job
 *
 * 轮询进行中的比赛，检测 match moments 并持久化。
 * 轮询频率：比赛进行中每 60 秒，否则每 5 分钟。
 *
 * 数据源优先级：
 *   1. FIFA live API（有阵型坐标 + 详细换人）
 *   2. ESPN keyEvents（fallback，换人/进球/红牌均有）
 */

const { fetchJSON } = require('../../services/espn');
const fifaApi = require('../services/fifa-api');
const {
  detectFromEspn,
  detectFromFifa,
  detectStructural,
  persistMoments,
} = require('../services/moment-detector');
const { reprice, probDelta } = require('../live-reprice');
const {
  computePressureIndex,
  parseEspnStats,
  detectSurge,
  saveStatSnapshot,
  getPrevSnapshot,
} = require('../services/pressure-index');
const { db } = require('../db');
const { recordStart, recordSuccess, recordError, recordStop } = require('./registry');
const { writebackMatchScore, resolveTeamToRatingsId } = require('../services/score-writeback');
const pushService = require('../services/push-service');
const { updateSubstitutionImpacts } = require('../services/substitution-impact');
const { safeExec, safeExecSync, loggers } = require('../logger');

// matchId → Set<type> 的结构性 moment 去重 map（内存，重启清空无妨）
const _structuralEmitted = new Map();

function createMomentSyncJob(deps) {
  const log = deps.logger || loggers.momentSync || console;
  const push = deps.pushService || pushService;
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    recordStart('moment-sync');

    let liveMatches = [];
    try {
      liveMatches = await safeExec(() => getLiveMatches(log), {
        jobName: 'moment-sync',
        source: 'espn',
        stage: 'fetch_live_matches',
        reason: 'espn_scoreboard_fetch_error',
        fallback: []
      }, log) || [];

      if (!liveMatches.length) {
        recordSuccess('moment-sync');
        return;
      }

      for (const m of liveMatches) {
        await safeExec(() => processMatch(m, log), {
          jobName: 'moment-sync',
          matchId: m.espnId,
          source: 'moment_sync_engine',
          stage: 'process_match',
          reason: 'match_processing_exception'
        }, log);
      }
      recordSuccess('moment-sync');
    } catch (e) {
      if (log && log.error) {
        log.error(`[moment-sync] tick error: ${e.message}`, {
          jobName: 'moment-sync',
          source: 'moment_sync_engine',
          stage: 'tick_loop',
          reason: 'unhandled_tick_exception',
          message: e.message,
          stack: e.stack
        });
      }
      recordError('moment-sync', e);
    } finally {
      running = false;
      scheduleNext(liveMatches && liveMatches.length > 0);
    }
  }

  function scheduleNext(hasLive) {
    if (timer) clearTimeout(timer);
    const delay = hasLive ? 60_000 : 5 * 60_000;
    timer = setTimeout(tick, delay);
    if (timer.unref) timer.unref();
  }

  async function processMatch(m, loggerInstance = null) {
    const log = loggerInstance || loggers.momentSync;
    const matchId  = m.espnId;
  const matchState = {
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    espnStatus: m.statusName,
    homeTeamId: m.homeEspnId || null,
    awayTeamId: m.awayEspnId || null,
  };

    // 结构性去重 Set（每场比赛独立）
    if (!_structuralEmitted.has(matchId)) _structuralEmitted.set(matchId, new Set());
    const emitted = _structuralEmitted.get(matchId);

    const moments = [];
    const minute = m.minute ?? 0;

    // ── 1. FIFA live（优先）────────────────────────────────────────────────
    const fifaMatch = await safeExec(() => tryFifaLive(m, log), {
      jobName: 'moment-sync',
      matchId,
      source: 'fifa',
      stage: 'fetch_fifa_live',
      reason: 'fifa_api_error',
      fallback: null
    }, log);
    if (fifaMatch) {
      moments.push(...detectFromFifa(matchId, fifaMatch.events, matchState));
    }

    // ── 2. ESPN keyEvents（补充或 fallback）───────────────────────────────
    const espnEvents = await safeExec(() => tryEspnKeyEvents(matchId, log), {
      jobName: 'moment-sync',
      matchId,
      source: 'espn',
      stage: 'fetch_espn_key_events',
      reason: 'espn_api_error',
      fallback: []
    }, log);
    if (espnEvents.length) {
      moments.push(...detectFromEspn(matchId, espnEvents, matchState));
    }

    // ── 3. 结构性时刻（补水/半场/补时/加时）────────────────────────────────
    moments.push(...detectStructural(matchId, minute, m.statusName, matchState, emitted));

    // ── 4. Track A 盘中重定价：为所有新 moments 注入概率快照 ──────────────
    const prePred = getPreMatchPrediction(matchId);
    if (prePred && moments.length) {
      safeExecSync(() => {
        const liveProb = reprice({
          preLambdaHome:  prePred.home_expected_goals ?? 1.2,
          preLambdaAway:  prePred.away_expected_goals ?? 1.0,
          homeScore:      matchState.homeScore,
          awayScore:      matchState.awayScore,
          minuteElapsed:  minute,
          homeRedCards:   m.homeRedCards ?? 0,
          awayRedCards:   m.awayRedCards ?? 0,
          isKnockout:     m.isKnockout ?? false,
        });
        const delta = probDelta(prePred, liveProb);

        for (const mo of moments) {
          mo.probHomeWin = liveProb.homeWin;
          mo.probDraw    = liveProb.draw;
          mo.probAwayWin = liveProb.awayWin;
          mo.deltaHomeWin = delta.deltaHomeWin;
          mo.deltaDraw    = delta.deltaDraw;
          mo.deltaAwayWin = delta.deltaAwayWin;
        }
      }, {
        jobName: 'moment-sync',
        matchId,
        source: 'live_reprice',
        stage: 'inject_reprice_probs',
        reason: 'reprice_injection_error'
      }, log);
    }

    const pushableGoals = selectPushableGoals(moments, matchId, minute, db);
    const saved = safeExecSync(() => persistMoments(moments), {
      jobName: 'moment-sync',
      matchId,
      source: 'sqlite',
      stage: 'persist_moments',
      reason: 'db_write_error',
      fallback: 0
    }, log) || 0;
    if (saved > 0 && log.log) {
      log.log(`[moment-sync] ${matchId} +${saved} moments (min=${minute})`);
    } else if (saved > 0) {
      console.log(`[moment-sync] ${matchId} +${saved} moments (min=${minute})`);
    }

    // ── 5. 新进球推送（只消费本轮首次持久化、接近当前分钟的 goal）────────────
    if (saved > 0 && pushableGoals.length) {
      for (const goal of pushableGoals) {
        await safeExec(() => push.sendPushNotification(
          matchId,
          buildGoalPayload(m, goal),
          { source: 'moment_sync' },
        ), {
          jobName: 'push',
          matchId,
          source: 'moment_sync',
          stage: 'goal_notification',
          reason: 'goal_push_failed',
        }, log);
      }
    }

    // ── 6. Pressure Index 快照 ────────────────────────────────────────────
    await safeExec(() => updatePressure(matchId, minute, matchState, moments, log), {
      jobName: 'moment-sync',
      matchId,
      source: 'espn_stats',
      stage: 'update_pressure',
      reason: 'pressure_calculation_error'
    }, log);

    // ── 7. 终场比分回写与内存清理 ──────────────────────────────────────────
    const fifaFinal = fifaMatch && fifaMatch.status === 0;
    const isFinal = m.statusName === 'STATUS_FINAL' || m.statusName === 'STATUS_FULL_TIME' || m.statusState === 'post' || fifaFinal;
    if (isFinal) {
      safeExecSync(() => writebackMatchScore({
        espnId: matchId,
        homeTeam: fifaMatch?.homeTeam?.id || m.homeEspnId || m.homeTeamFifaCode,
        awayTeam: fifaMatch?.awayTeam?.id || m.awayEspnId || m.awayTeamFifaCode,
        homeScore: fifaMatch ? fifaMatch.homeScore : m.homeScore,
        awayScore: fifaMatch ? fifaMatch.awayScore : m.awayScore,
        statusName: fifaFinal ? 'STATUS_FINAL' : m.statusName,
        matchDate: m.matchDate,
        source: fifaMatch ? 'fifa' : 'espn',
        logger: log,
      }), {
        jobName: 'moment-sync',
        matchId,
        source: fifaMatch ? 'fifa' : 'espn',
        stage: 'writeback_score',
        reason: 'score_writeback_exception'
      }, log);
      _structuralEmitted.delete(matchId);
    } else if (m.statusName === 'STATUS_FINAL' || m.statusName === 'STATUS_FULL_TIME') {
      _structuralEmitted.delete(matchId);
    }
  }

  return {
    start() {
      tick();
      return true;
    },
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      recordStop('moment-sync');
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function selectPushableGoals(moments, matchId, currentMinute, database = db) {
  const seen = new Set();
  return (moments || []).filter(moment => {
    if (moment?.type !== 'goal') return false;
    const minute = Number(moment.minute || 0);
    const minuteAdded = Number(moment.minuteAdded || 0);
    const now = Number(currentMinute || 0);
    if (now > 0 && (minute > now + 1 || now - minute > 5)) return false;

    // FIFA and ESPN can describe the same goal with different team identifiers.
    const key = `${minute}:${minuteAdded}`;
    if (seen.has(key)) return false;
    seen.add(key);

    const existing = database.prepare(`
      SELECT 1 FROM match_moments
      WHERE match_id = ? AND type = 'goal' AND minute = ? AND minute_added = ?
      LIMIT 1
    `).get(String(matchId), minute, minuteAdded);
    return !existing;
  });
}

function buildGoalPayload(match, goal) {
  const homeName = match.homeName || match.homeTeamFifaCode || 'Home';
  const awayName = match.awayName || match.awayTeamFifaCode || 'Away';
  const homeScore = Number(match.homeScore || 0);
  const awayScore = Number(match.awayScore || 0);
  const minute = Number(goal.minute || match.minute || 0);
  return {
    title: `⚽ GOAL · ${homeName} ${homeScore}–${awayScore} ${awayName}`,
    body: `${minute}′ · ${homeName} vs ${awayName}`,
    matchId: String(match.espnId),
    minute,
    score: { home: homeScore, away: awayScore },
    url: `/#match/${encodeURIComponent(String(match.espnId))}`,
    tag: `goal-${match.espnId}-${minute}-${homeScore}-${awayScore}`,
  };
}

async function updatePressure(matchId, minute, matchState, newMoments, logger) {
  try {
    // 拉当前 ESPN boxscore stats
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${matchId}`;
    const data = await fetchJSON(url).catch(() => null);
    const teams = data?.boxscore?.teams;
    if (!teams) return;

    const rawStats = parseEspnStats(teams);
    if (!rawStats) return;

    const prev = getPrevSnapshot(matchId);
    const windowMin = prev ? Math.max(1, minute - prev.minute) : minute;

    const pressure = computePressureIndex(prev, rawStats, windowMin);

    // 写入快照
    saveStatSnapshot(matchId, minute, rawStats, pressure);
    updateSubstitutionImpacts(matchId, minute);

    // Surge 检测：落后方持续高压 → 生成 alert moment
    for (const side of ['home', 'away']) {
      const pi = pressure[side];
      if (pi < 65) continue;

      // 是否落后
      const isTrailing = side === 'home'
        ? matchState.homeScore < matchState.awayScore
        : matchState.awayScore < matchState.homeScore;

      if (!isTrailing) continue;

      const surge = detectSurge(matchId, side, minute, { matchState });
      if (!surge.surge) continue;

      // 避免同一 surge 重复触发（用结构性 emitted set）
      const surgeKey = `surge_${side}_${Math.floor(minute / 5) * 5}`;
      const emitted = _structuralEmitted.get(matchId) ?? new Set();
      if (emitted.has(surgeKey)) continue;
      emitted.add(surgeKey);
      _structuralEmitted.set(matchId, emitted);

      // 生成 sustained_pressure_alert moment
      const { persistMoments: persist } = require('../services/moment-detector');
      persist([{
        matchId,
        type: 'sustained_pressure_alert',
        minute,
        minuteAdded: 0,
        teamId: side,
        importance: 78,
        source: 'pressure_index',
        scoreState: { home: matchState.homeScore, away: matchState.awayScore },
        raw: {
          pi,
          consecutiveHighPI: surge.consecutiveHighPI,
          sustainedMinutes: surge.sustainedMinutes,
          components: pressure.components[side],
        },
        detectedAt: new Date().toISOString(),
      }]);

      logger.log(`[moment-sync] surge alert: ${matchId} ${side} PI=${pi} min=${minute}`);
    }
  } catch (e) {
    logger.warn(`[moment-sync] pressure update error: ${e.message}`);
  }
}

function getPreMatchPrediction(espnMatchId) {
  // 取最早的赛前快照（真正的赛前 λ 基线）
  return db.prepare(`
    SELECT home_win_prob, draw_prob, away_win_prob, home_expected_goals, away_expected_goals
    FROM prediction_snapshots
    WHERE match_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(String(espnMatchId)) ?? null;
}

async function getLiveMatches(loggerInstance = null) {
  const log = loggerInstance || loggers.momentSync;
  return await safeExec(async () => {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
    const data = await fetchJSON(url);
    const events = data?.events ?? [];

    return events
      .filter(e => {
        const s = e.status?.type?.state;
        if (s === 'in' || s === 'live') return true;
        if (s === 'post') {
          try {
            const comp = e.competitions?.[0];
            const home = comp?.competitors?.find(c => c.homeAway === 'home');
            const away = comp?.competitors?.find(c => c.homeAway === 'away');
            const homeId = resolveTeamToRatingsId(home?.team?.id || home?.team?.abbreviation);
            const awayId = resolveTeamToRatingsId(away?.team?.id || away?.team?.abbreviation);
            if (!homeId || !awayId) return true;
            const matchDate = (e.date ?? '').slice(0, 10);
            const row = db.prepare(`
              SELECT played FROM matches
              WHERE ((home_team_id = ? AND away_team_id = ?) OR (home_team_id = ? AND away_team_id = ?))
                AND (? = '' OR substr(match_date, 1, 10) = ?)
              LIMIT 1
            `).get(homeId, awayId, awayId, homeId, matchDate, matchDate);
            return !row || row.played === 0;
          } catch {
            return true;
          }
        }
        return false;
      })
      .map(e => {
        const comp = e.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        return {
          espnId: e.id,
          homeScore: parseInt(home?.score ?? '0', 10),
          awayScore: parseInt(away?.score ?? '0', 10),
          statusName: e.status?.type?.name ?? '',
          statusState: e.status?.type?.state ?? '',
          minute: parseInt(e.status?.displayClock ?? '0', 10),
          homeEspnId: home?.team?.id ?? null,
          awayEspnId: away?.team?.id ?? null,
          homeName: home?.team?.displayName ?? home?.team?.shortDisplayName ?? home?.team?.abbreviation ?? 'Home',
          awayName: away?.team?.displayName ?? away?.team?.shortDisplayName ?? away?.team?.abbreviation ?? 'Away',
          homeTeamFifaCode: home?.team?.abbreviation ?? null,
          awayTeamFifaCode: away?.team?.abbreviation ?? null,
          matchDate: (e.date ?? '').slice(0, 10),
        };
      });
  }, {
    jobName: 'moment-sync',
    source: 'espn',
    stage: 'fetch_scoreboard',
    reason: 'espn_scoreboard_fetch_failed',
    fallback: []
  }, log) || [];
}

async function tryFifaLive(m, loggerInstance = null) {
  const log = loggerInstance || loggers.momentSync;
  return await safeExec(async () => {
    // 需要 FIFA IdStage + IdMatch；从 DB 缓存里找（match-id-bridge 存的）
    const bridge = db.prepare(
      `SELECT fifa_stage_id, fifa_match_id FROM fifa_match_bridge WHERE espn_id = ? LIMIT 1`
    ).get(String(m.espnId));
    if (!bridge?.fifa_match_id) return null;

    return await fifaApi.fetchLiveMatch(bridge.fifa_stage_id, bridge.fifa_match_id);
  }, {
    jobName: 'moment-sync',
    matchId: m.espnId,
    source: 'fifa',
    stage: 'fetch_fifa_live_api',
    reason: 'fifa_api_fetch_error',
    fallback: null
  }, log);
}

async function tryEspnKeyEvents(espnMatchId, loggerInstance = null) {
  const log = loggerInstance || loggers.momentSync;
  return await safeExec(async () => {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${espnMatchId}`;
    const data = await fetchJSON(url);
    return data?.keyEvents ?? [];
  }, {
    jobName: 'moment-sync',
    matchId: espnMatchId,
    source: 'espn',
    stage: 'fetch_espn_summary_api',
    reason: 'espn_summary_fetch_error',
    fallback: []
  }, log);
}

module.exports = { createMomentSyncJob, selectPushableGoals, buildGoalPayload };
