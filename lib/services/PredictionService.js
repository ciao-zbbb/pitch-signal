const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logger');
const { resolveDataPath } = require('../data-resolver');
const DATA_DIR = path.resolve(__dirname, '../../data');
const logger = createLogger('PredictionService');
const PredictionEngine = require('../prediction');
const { savePredictionSnapshot } = require('../postMatchReview');
const teamResolver = require('../team_resolver');
const { applyOutputRules } = require('../output-rules');
const marketValueSignal = require('./market-value-signal');
const continentalStrengthSignal = require('./continental-strength-signal');

class PredictionService {
  constructor(deps) {
    this.deps = deps;
  }

  async fetchExternalOdds(matchId, { allowCache = true, homeId = null, awayId = null } = {}) {
    const { getCached, setCache } = this.deps;
    const oddsKey = `analysis_odds_${matchId}`;
    if (allowCache) {
      const cached = getCached(oddsKey, 300000);
      if (cached) return cached;
    }

    const ODDS_KEY = process.env.THE_ODDS_API_KEY || '';
    if (!ODDS_KEY) return null;

    try {
      const { fetchMatchOdds } = require('./the-odds-api');
      const result = await fetchMatchOdds(homeId, awayId, ODDS_KEY);
      if (result) {
        setCache(oddsKey, result);
        return result;
      }
    } catch (error) {
      logger.warn(`External odds lookup failed for ${matchId}:`, { error: error.message });
    }

    return null;
  }

  getRatingTeam(input) {
    const { RATINGS } = this.deps;
    const resolved = teamResolver.resolve(input);
    const ratingsId = resolved?.ratings_id || String(input || '');
    // 尝试 ratings.teams[name_official]（如 "Germany"）
    let team = RATINGS.teams?.[ratingsId] || RATINGS.teams?.[String(input || '')];
    // id_bridge 没有 ratings 时走 estimated 兜底（不抛错）
    if (!team) {
      return { ratingsId, team: null, source: 'estimated', _note: 'No ratings data — using estimated baseline' };
    }
    return { ratingsId, team, source: 'ratings' };
  }

  calcAvg(team, source) {
    // 兜底：无 ratings 数据时返回 estimated 默认值
    if (!team) {
      return { rating: 1500, attack_strength: 1.0, defense_strength: 1.0, source: 'estimated_default' };
    }
    if (team?.rating) {
      return {
        rating: team.rating,
        attack_strength: team.attack_strength || 1.0,
        defense_strength: team.defense_strength || 1.0,
      };
    }
    const players = team?.players || [];
    if (!players.length) return { rating: 1500, attack_strength: 1.0, defense_strength: 1.0 };
    const avg = players.reduce((s, p) => s + (p.rating || 70), 0) / players.length;
    const atk = players.filter(p => ['LW','RW','ST','CF','F','AM','CAM'].includes(p.pos));
    const def = players.filter(p => ['GK','CB','LB','RB','LWB','RWB','D'].includes(p.pos));
    const atkAvg = atk.length ? atk.reduce((s, p) => s + (p.rating || 70), 0) / atk.length : avg;
    const defAvg = def.length ? def.reduce((s, p) => s + (p.rating || 70), 0) / def.length : avg;
    return {
      rating: Math.round(avg * 10) + 1000,
      attack_strength: Math.round((atkAvg / 75) * 1000) / 1000,
      defense_strength: Math.round((defAvg / 75) * 1000) / 1000,
    };
  }

  async predictMatch(matchId, { persist = false, includeExternalOdds = false, bypassCache = false } = {}) {
    const { getCached, setCache, espn, getTeamNameZh, getTeamNameI18n, routes, TEAM_FLAGS } = this.deps;
    const dbInstance = require('../db').db;

    const predKey = `pred_${matchId}`;
    const cached = getCached(predKey, 300000);
    // Public reads may use the cache. Persistence jobs deliberately recalculate so
    // a prior public request cannot prevent creation of the scheduled snapshot.
    if (cached && !persist && !bypassCache && !includeExternalOdds) return cached;

    const engine = new PredictionEngine();
    const matchData = await espn(`/summary?event=${matchId}`, `m_${matchId}`, 120000);
    if (!matchData?.header?.competitions?.[0]?.competitors) return { error: 'Match not found' };

    const comp = matchData.header.competitions[0];
    const homeComp = comp.competitors.find(c => c.homeAway === 'home');
    const awayComp = comp.competitors.find(c => c.homeAway === 'away');
    const homeId = homeComp?.team?.id;
    const awayId = awayComp?.team?.id;

    const homeLookup = this.getRatingTeam(homeId);
    const awayLookup = this.getRatingTeam(awayId);
    const homeRating = this.calcAvg(homeLookup.team);
    const awayRating = this.calcAvg(awayLookup.team);

    // Venue lookup: extract name from ESPN summary, match against venues.json
    let venue = null;
    try {
      const espnVenueName = matchData.gameInfo?.venue?.fullName || matchData.gameInfo?.venue?.shortName || comp.venue?.fullName || comp.venue?.name || '';
      if (espnVenueName) {
        const venuesRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'venues.json'), 'utf8'));
        const venuesArr = Array.isArray(venuesRaw) ? venuesRaw : Object.values(venuesRaw);
        venue = venuesArr.find(v => v.name && v.name.toLowerCase() === espnVenueName.toLowerCase()) || null;
      }
    } catch { /* venue stays null — engine handles gracefully */ }

    // Public beta must not use live market data as a prediction input.  Keep the
    // plumbing in PredictionEngine for a future, separately approved phase.
    const odds = includeExternalOdds
      ? await this.fetchExternalOdds(matchId, { allowCache: !bypassCache, homeId: homeLookup.ratingsId, awayId: awayLookup.ratingsId })
      : null;

    const marketValueEnabled = process.env.MARKET_VALUE_SIGNAL_ENABLED === 'true';
    const squadMarketValueSignal = marketValueEnabled
      ? marketValueSignal.buildSignal(homeLookup.ratingsId, awayLookup.ratingsId)
      : null;
    const continentalStrengthEnabled = process.env.CONTINENTAL_STRENGTH_SIGNAL_ENABLED === 'true';
    const confedStrengthSignal = continentalStrengthEnabled
      ? continentalStrengthSignal.buildSignal(homeLookup.ratingsId, awayLookup.ratingsId)
      : null;

    // P3-4: 首发阵容确定性计算（homeXI / awayXI 是否公布）
    let lineupUncertainty = 1; // 默认任一未公布为高(1)
    try {
      const lineupsSource = require('../lineups-source');
      const lineupsData = lineupsSource.getLineups(matchId);
      if (lineupsData && lineupsData.homeXI !== null && lineupsData.awayXI !== null && lineupsData.homeXI.length > 0 && lineupsData.awayXI.length > 0) {
        lineupUncertainty = 0; // 双方首发均已公布，不确定性为低(0)
      }
    } catch (e) {
      logger.debug('PredictionService: getLineups check failed for', { detail: `${matchId}: ${e.message}` });
    }

    // Public beta hard gate: AI context must not enter the prediction pipeline,
    // regardless of an accidentally supplied environment variable.
    const aiEnabled = false;
    let groupName = null;
    if (aiEnabled) {
      try {
        const gRow = dbInstance.prepare(
          "SELECT g.group_name FROM matches m JOIN groups g ON m.group_id = g.id WHERE (m.home_team_id = ? OR m.away_team_id = ?) AND (m.home_team_id = ? OR m.away_team_id = ?) LIMIT 1"
        ).get(homeLookup.ratingsId, homeLookup.ratingsId, awayLookup.ratingsId, awayLookup.ratingsId);
        groupName = gRow?.group_name || null;
      } catch { logger.debug('PredictionService: group lookup failed for', { detail: `${homeId} vs ${awayId}` }); }
    }

    const result = aiEnabled
      ? await engine.predictWithAI({ matchId, homeId: homeLookup.ratingsId, awayId: awayLookup.ratingsId, homeEspnId: homeId, awayEspnId: awayId, homeRating, awayRating, odds, groupName, marketValueSignal: squadMarketValueSignal, continentalStrengthSignal: confedStrengthSignal, lineupUncertainty })
      : await engine.predictWithMarket({ matchId, homeId: homeLookup.ratingsId, awayId: awayLookup.ratingsId, homeEspnId: homeId, awayEspnId: awayId, homeRating, awayRating, odds, venue, marketValueSignal: squadMarketValueSignal, continentalStrengthSignal: confedStrengthSignal, lineupUncertainty });

    if (odds) {
      result.externalOdds = odds;
    }
    result.predictionSource = odds ? 'baseline_plus_odds' : 'baseline_only';
    result.externalOddsUsed = Boolean(odds);
    result.marketValueSignalUsed = Boolean(squadMarketValueSignal);
    result.continentalStrengthSignalUsed = Boolean(confedStrengthSignal);
    
    result.match = {
      homeId,
      awayId,
      homeName: getTeamNameZh(homeId),
      awayName: getTeamNameZh(awayId),
      homeNameI18n: getTeamNameI18n ? getTeamNameI18n(homeId, homeComp?.team?.displayName) : null,
      awayNameI18n: getTeamNameI18n ? getTeamNameI18n(awayId, awayComp?.team?.displayName) : null,
      homeLogo: homeComp?.team?.logos?.[0]?.href,
      awayLogo: awayComp?.team?.logos?.[0]?.href,
      homeFlag: TEAM_FLAGS[homeId] || '🏳️',
      awayFlag: TEAM_FLAGS[awayId] || '🏳️',
      status: comp.status?.type?.name || 'STATUS_SCHEDULED',
    };

    // 读取 id_bridge probs 作为先验概率信号（w/d/l 三级），注入 result.priors
    try {
      const probs = JSON.parse(fs.readFileSync(resolveDataPath('probs.json'), 'utf8'));
      const prior = probs[matchId];
      if (prior) {
        result.priors = {
          homeWin: prior.h / 100,
          draw: prior.d / 100,
          awayWin: prior.a / 100,
          source: 'id_bridge_probs',
        };
      }
    } catch (_) { /* probs.json 不可用时跳过 */ }
    try {
      Object.assign(result, applyOutputRules(result, matchId));
    } catch (ruleErr) {
      logger.warn('Output rules failed (non-fatal):', { error: ruleErr.message });
    }

    // 末轮战略情境层：确定性的出线场景 + 同时进行的另一场 + 下轮避强对阵
    // 仅在小组末轮(组内 4 队皆 played===2)时填充；不修改任何概率，纯说明。
    try {
      const standingsResp = routes?.['GET /api/standings']
        ? await routes['GET /api/standings']()
        : null;
      const standingsGroups = standingsResp?.groups || null;
      if (standingsGroups) {
        const { buildFinalRoundContext } = require('../finalRoundContext');
        const scenario = buildFinalRoundContext({ homeId, awayId, standingsGroups });
        if (scenario?.applicable) result.tacticalScenario = scenario;
      }
    } catch (scenErr) {
      logger.warn('Final-round context failed (non-fatal):', { error: scenErr.message });
    }

    if (persist) {
      try {
        savePredictionSnapshot(matchId, result);
      } catch (snapshotError) {
        logger.warn(`Prediction snapshot failed for ${matchId}:`, { error: snapshotError.message });
      }

      try {
        dbInstance.prepare(`
          INSERT INTO predictions (match_id, home_win_prob, draw_prob, away_win_prob, predicted_home_goals, predicted_away_goals, confidence, model_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          matchId,
          result.homeWin || result.homeWinProb || 0,
          result.draw || result.drawProb || 0,
          result.awayWin || result.awayWinProb || 0,
          result.goals?.homeExpected || result.expectedScore?.home || 0,
          result.goals?.awayExpected || result.expectedScore?.away || 0,
          result.components?.elo?.confidence || 0,
          result._fusion || 'v4',
        );
      } catch (predSaveErr) {
        logger.warn(`Prediction save failed for ${matchId}:`, { error: predSaveErr.message });
      }
    }

    if (!includeExternalOdds) setCache(predKey, result);
    return result;
  }

  // T15: Elo ranking logic (moved from routes/prediction.js)
  async getEloRankings() {
    const { getCached, setCache, RATINGS, getTeamNameZh, getTeamNameI18n, TEAM_FLAGS } = this.deps;
    const dbInstance = require('../db').db;

    const cached = getCached('elo_rankings', 600000);
    if (cached) return cached;

    // 优先从 SQLite 读取
    try {
      const rows = dbInstance.prepare('SELECT team_id, team_name, rating FROM elo_ratings ORDER BY rating DESC').all();
      if (rows.length > 0) {
        const rankings = rows.map((r, i) => ({
          teamId: r.team_id,
          name: getTeamNameZh(r.team_id) || r.team_name,
          nameI18n: getTeamNameI18n ? getTeamNameI18n(r.team_id, r.team_name) : null,
          flag: TEAM_FLAGS[r.team_id] || '🏳️',
          rating: r.rating,
          rank: i + 1,
        }));
        setCache('elo_rankings', rankings);
        return rankings;
      }
    } catch (dbErr) {
      logger.warn('Elo rankings DB read failed, falling back to computation:', { error: dbErr.message });
    }

    // Fallback: 内存计算
    const EloRating = require('../elo');
    const elo = new EloRating();
    const teams = {};
    for (const [id, team] of Object.entries(RATINGS.teams || {})) {
      if (team.rating) {
        teams[id] = { name: getTeamNameZh(id), nameI18n: getTeamNameI18n ? getTeamNameI18n(id, team.name) : null, flag: TEAM_FLAGS[id] || '🏳️', rating: team.rating };
      } else {
        const players = team.players || [];
        if (players.length > 0) {
          const avg = players.reduce((s, p) => s + (p.rating || 70), 0) / players.length;
          teams[id] = { name: getTeamNameZh(id), nameI18n: getTeamNameI18n ? getTeamNameI18n(id, team.name) : null, flag: TEAM_FLAGS[id] || '🏳️', rating: Math.round(avg * 10) + 1000 };
        }
      }
    }
    const rankings = elo.rankings(teams).map((row) => {
      const source = teams[row.teamId] || teams[row.name] || {};
      return {
        ...row,
        name: source.name || row.name,
        nameI18n: source.nameI18n || row.nameI18n || null,
        flag: source.flag || TEAM_FLAGS[row.teamId] || TEAM_FLAGS[row.name] || '🏳️',
      };
    });

    // T04: 移除公共GET端点的DB写入副作用
    // 写入操作应由定时任务或管理员接口负责，不在读取时执行

    setCache('elo_rankings', rankings);
    return rankings;
  }

  async getTeamElo(teamId) {
    const { RATINGS, getTeamNameZh, getTeamNameI18n, TEAM_FLAGS } = this.deps;
    const dbInstance = require('../db').db;
    const teamResolver = require('../team_resolver');

    // 优先从 DB 读取
    try {
      const row = dbInstance.prepare('SELECT team_id, team_name, rating, peak_rating FROM elo_ratings WHERE team_id = ? OR team_name = ?').get(teamId, teamId);
      if (row) {
        const EloRating = require('../elo');
        const elo = new EloRating();
        return {
          teamId: row.team_id,
          requestedId: teamId,
          name: getTeamNameZh(row.team_id) || row.team_name,
          nameI18n: getTeamNameI18n ? getTeamNameI18n(row.team_id, row.team_name) : null,
          flag: TEAM_FLAGS[row.team_id] || TEAM_FLAGS[teamId] || '🏳️',
          rating: row.rating,
          peakRating: row.peak_rating,
          source: 'database',
          fifaEquiv: elo.initFromFifaRank(Math.max(1, Math.round((2100 - row.rating) / 12) + 1)),
        };
      }
    } catch { logger.warn('PredictionService.getTeamElo: DB lookup failed for', { detail: teamId }); }

    // Fallback
    const { ratingsId, team } = this.getRatingTeam(teamId);
    if (!team) return { error: 'Team not found' };

    const players = team.players || [];
    const avg = players.length ? players.reduce((s, p) => s + (p.rating || 70), 0) / players.length : null;
    const rating = team.rating || Math.round((avg || 70) * 10) + 1000;
    const EloRating = require('../elo');
    const elo = new EloRating();

    return {
      teamId: ratingsId,
      requestedId: teamId,
      name: getTeamNameZh(ratingsId),
      nameI18n: getTeamNameI18n ? getTeamNameI18n(ratingsId, team.name) : null,
      flag: TEAM_FLAGS[ratingsId] || TEAM_FLAGS[teamId] || '🏳️',
      rating,
      peakRating: rating,
      players: players.length,
      avgPlayerRating: avg == null ? null : Math.round(avg * 10) / 10,
      source: 'computed',
      fifaEquiv: elo.initFromFifaRank(Math.max(1, Math.round((2100 - rating) / 12) + 1)),
    };
  }

  // T15: Live prediction analysis (moved from routes/prediction.js)
  async predictLive(matchId, liveStats = {}) {
    const baseline = await this.predictMatch(matchId, {
      includeExternalOdds: true,
      bypassCache: true,
    });
    if (baseline?.error) return baseline;

    const liveAnalysis = PredictionService.buildLiveAnalysis(
      baseline,
      {
        homeName: baseline.match?.homeName || 'Home',
        awayName: baseline.match?.awayName || 'Away',
      },
      liveStats,
      baseline.externalOdds || null
    );

    return {
      matchId,
      match: baseline.match,
      predictionSource: baseline.externalOdds ? 'baseline_plus_odds' : 'baseline_only',
      externalOddsUsed: Boolean(baseline.externalOdds),
      baseline: {
        homeWin: baseline.homeWin,
        draw: baseline.draw,
        awayWin: baseline.awayWin,
        likelyScore: baseline.likelyScore,
        goals: baseline.goals,
      },
      externalOdds: baseline.externalOdds || null,
      liveAnalysis,
    };
  }

  // T15: Static helpers for live analysis (pure functions, no state)
  static _toNumber(value) {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  static _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  static _normalizeThreeWay(homeWin, draw, awayWin) {
    const sum = homeWin + draw + awayWin;
    if (!sum || !Number.isFinite(sum)) {
      return { homeWin: 0.333, draw: 0.334, awayWin: 0.333 };
    }
    return {
      homeWin: Math.round((homeWin / sum) * 1000) / 1000,
      draw: Math.round((draw / sum) * 1000) / 1000,
      awayWin: Math.round((awayWin / sum) * 1000) / 1000,
    };
  }

  static buildLiveAnalysis(basePrediction, matchMeta, liveStats = {}, externalOdds = null) {
    const toNum = PredictionService._toNumber;
    const clamp = PredictionService._clamp;

    const minute = clamp(toNum(liveStats.minute) ?? 0, 0, 120);
    const homeScore = toNum(liveStats.homeScore) ?? 0;
    const awayScore = toNum(liveStats.awayScore) ?? 0;
    const homeShots = toNum(liveStats.homeShots) ?? 0;
    const awayShots = toNum(liveStats.awayShots) ?? 0;
    const homeShotsOnTarget = toNum(liveStats.homeShotsOnTarget) ?? 0;
    const awayShotsOnTarget = toNum(liveStats.awayShotsOnTarget) ?? 0;
    const homePossession = toNum(liveStats.homePossession);
    const awayPossession = toNum(liveStats.awayPossession);
    const homeRedCards = toNum(liveStats.homeRedCards) ?? 0;
    const awayRedCards = toNum(liveStats.awayRedCards) ?? 0;
    const homeYellowCards = toNum(liveStats.homeYellowCards) ?? 0;
    const awayYellowCards = toNum(liveStats.awayYellowCards) ?? 0;

    const baseHome = Number(basePrediction.homeWin || 0.333);
    const baseDraw = Number(basePrediction.draw || 0.334);
    const baseAway = Number(basePrediction.awayWin || 0.333);
    const scoreDiff = homeScore - awayScore;
    const shotDiff = homeShots - awayShots;
    const sotDiff = homeShotsOnTarget - awayShotsOnTarget;
    const possessionDiff = homePossession != null && awayPossession != null
      ? (homePossession - awayPossession) / 100
      : 0;
    const timeFactor = minute / 90;

    let homeEdge = 0;
    homeEdge += scoreDiff * (0.16 + 0.20 * timeFactor);
    homeEdge += clamp(shotDiff, -8, 8) * 0.008;
    homeEdge += clamp(sotDiff, -5, 5) * 0.03;
    homeEdge += clamp(possessionDiff, -0.7, 0.7) * 0.10;
    homeEdge += clamp(awayYellowCards - homeYellowCards, -3, 3) * 0.01;
    homeEdge += clamp(awayRedCards - homeRedCards, -1, 1) * 0.18;

    if (externalOdds) {
      const homeDec = Number(externalOdds.homeWin);
      const drawDec = Number(externalOdds.draw);
      const awayDec = Number(externalOdds.awayWin);
      if (homeDec > 1 && drawDec > 1 && awayDec > 1) {
        const invHome = 1 / homeDec;
        const invDraw = 1 / drawDec;
        const invAway = 1 / awayDec;
        const total = invHome + invDraw + invAway;
        if (total > 0) {
          const marketHome = invHome / total;
          const marketAway = invAway / total;
          homeEdge += (marketHome - marketAway) * 0.12;
        }
      }
    }

    let adjustedHome = baseHome + homeEdge;
    let adjustedAway = baseAway - homeEdge * 0.82;
    let adjustedDraw = baseDraw - Math.abs(homeEdge) * 0.45;

    if (scoreDiff >= 2 && minute >= 15) adjustedDraw -= 0.04;
    if (scoreDiff <= -2 && minute >= 15) adjustedDraw -= 0.04;
    if (scoreDiff === 0 && minute < 25) adjustedDraw += 0.02;

    adjustedHome = clamp(adjustedHome, 0.01, 0.985);
    adjustedAway = clamp(adjustedAway, 0.01, 0.985);
    adjustedDraw = clamp(adjustedDraw, 0.01, 0.60);

    const normalized = PredictionService._normalizeThreeWay(adjustedHome, adjustedDraw, adjustedAway);
    const expectedHome = Number(basePrediction.goals?.homeExpected || 0);
    const expectedAway = Number(basePrediction.goals?.awayExpected || 0);
    const liveHomeGoals = Math.max(homeScore, Math.round((expectedHome + Math.max(0, shotDiff) * 0.08 + Math.max(0, sotDiff) * 0.18) * 10) / 10);
    const liveAwayGoals = Math.max(awayScore, Math.round((expectedAway + Math.max(0, -shotDiff) * 0.06 + Math.max(0, -sotDiff) * 0.16) * 10) / 10);

    const scorelineHints = [];
    if (scoreDiff >= 2) {
      scorelineHints.push(`${homeScore + 1}:${awayScore}`);
      scorelineHints.push(`${homeScore + 2}:${awayScore}`);
      if (awayShotsOnTarget > 0) scorelineHints.push(`${homeScore + 1}:${awayScore + 1}`);
    } else if (scoreDiff === 1) {
      scorelineHints.push(`${homeScore + 1}:${awayScore}`);
      scorelineHints.push(`${homeScore}:${awayScore}`);
      scorelineHints.push(`${homeScore + 1}:${awayScore + 1}`);
    } else if (scoreDiff === 0) {
      scorelineHints.push(`${homeScore + 1}:${awayScore}`);
      scorelineHints.push(`${homeScore}:${awayScore + 1}`);
      scorelineHints.push(`${homeScore}:${awayScore}`);
    } else {
      scorelineHints.push(`${homeScore}:${awayScore + 1}`);
      scorelineHints.push(`${homeScore + 1}:${awayScore + 1}`);
      scorelineHints.push(`${homeScore}:${awayScore}`);
    }

    return {
      minute,
      score: { home: homeScore, away: awayScore },
      probabilities: normalized,
      expectedGoals: {
        home: Math.round(liveHomeGoals * 10) / 10,
        away: Math.round(liveAwayGoals * 10) / 10,
      },
      likelyScorelines: scorelineHints.slice(0, 3),
      signals: {
        scoreDiff,
        shotDiff,
        shotsOnTargetDiff: sotDiff,
        possessionDiff: homePossession != null && awayPossession != null
          ? Math.round((homePossession - awayPossession) * 10) / 10
          : null,
        externalOddsUsed: Boolean(externalOdds),
      },
      summary: {
        stateShift: scoreDiff >= 2 ? 'reinforced' : (scoreDiff !== 0 ? 'lean_reinforced' : 'still_live'),
        note: `${matchMeta.homeName} vs ${matchMeta.awayName} at ${minute}' is being repriced from the pre-match baseline using scoreline plus live control signals.`,
      },
    };
  }
}

module.exports = PredictionService;
