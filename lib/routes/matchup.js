const { createLogger } = require('../logger');
const logger = createLogger('matchup');
module.exports = function createMatchupRoutes(deps) {
  const { espn, fetchJSON, parseEvent, getTeamNameZh, getTeamNameI18n, TEAM_LOGOS, COACHES, TEAM_NAMES_ZH, getCached, setCache, routes, rosterCache, PLAYER_RATINGS, RATINGS, TEAM_NAMES, getPlayerRatingData, assignLineupCoords, matchupAPI, matchupSpatial, ratingsData, loader, calculateVenueImpact, analyzeStyleFit, TEAM_FLAGS, teamResolver, idBridge } = deps;
  const path = require('path');
  const fs = require('fs');
  const fsPromises = require('fs').promises;
  const DATA_DIR = path.join(__dirname, '..', '..', 'data');
  const lineupsSource = require('../lineups-source');
  const { getSubstitutionImpacts } = require('../services/substitution-impact');
  const playerNameZh = require('../player-name-zh');
  const { fuzzyMatchPlayer } = require('../fuzzy-match');
  const { predictCorners, getStyleCoeff, LEAGUE_AVG: CORNER_LEAGUE_AVG } = require('../corner-model');

  const enrichSubstitutions = (subs, homeId, awayId) => {
    if (!subs || !subs.length) return [];
    const homeRatings = getPlayerRatingData(homeId)?.team || {};
    const awayRatings = getPlayerRatingData(awayId)?.team || {};
    const homeSquad = homeRatings.players ? Object.values(homeRatings.players) : [];
    const awaySquad = awayRatings.players ? Object.values(awayRatings.players) : [];
    return subs.map(s => {
      const side = s.side || 'home';
      const squadPlayers = side === 'home' ? homeSquad : awaySquad;
      let offRating = 70;
      if (squadPlayers.length > 0) {
        const matchedOff = fuzzyMatchPlayer(
          { name: s.offName || '', num: null },
          squadPlayers.map(sp => ({ ...sp, num: sp.jersey || sp.num }))
        );
        if (matchedOff?.rating) offRating = matchedOff.rating;
      }
      let onRating = 70;
      if (squadPlayers.length > 0) {
        const matchedOn = fuzzyMatchPlayer(
          { name: s.onName || '', num: null },
          squadPlayers.map(sp => ({ ...sp, num: sp.jersey || sp.num }))
        );
        if (matchedOn?.rating) onRating = matchedOn.rating;
      }
      let onJersey = s.onJersey || '?';
      if (squadPlayers.length > 0 && (!onJersey || onJersey === '?')) {
        const matchedOn = fuzzyMatchPlayer(
          { name: s.onName || '', num: null },
          squadPlayers.map(sp => ({ ...sp, num: sp.jersey || sp.num }))
        );
        if (matchedOn?.jersey || matchedOn?.num) {
          onJersey = String(matchedOn.jersey || matchedOn.num);
        }
      }
      return {
        ...s,
        offRating,
        onRating,
        onJersey
      };
    });
  };

  return {
  'GET /api/h2h/:matchId': async (params) => {
    // 1. Fetch ESPN summary once. It contains both team IDs and head-to-head.
    let espnGames = [];
    let homeId = '', awayId = '';
    try {
      const d = await espn(`/summary?event=${params.matchId}`, `m_${params.matchId}`, 300000);
      for (const c of (d?.header?.competitions?.[0]?.competitors || [])) {
        if (c.homeAway === 'home') homeId = String(c.id || '');
        else awayId = String(c.id || '');
      }
      const h2hGames = d?.headToHeadGames || [];
      for (const team of h2hGames) {
        for (const ev of (team.events || [])) {
          const historicHomeId = String(ev.homeTeamId || '');
          const historicAwayId = String(ev.awayTeamId || '');
          espnGames.push({
            date: ev.gameDate,
            homeTeam: historicHomeId,
            awayTeam: historicAwayId,
            homeTeamName: getTeamNameZh(historicHomeId) || historicHomeId,
            awayTeamName: getTeamNameZh(historicAwayId) || historicAwayId,
            score: ev.score,
            competition: ev.competitionName || '未知赛事',
            result: ev.gameResult,
          });
        }
      }
    } catch (e) {
      logger.warn('[H2H] ESPN fetch failed:', { error: e.message });
    }

    // 2. Load CSV matches for this team pair
    let csvGames = [];
    try {
      // Get team names for CSV lookup (use ESPN IDs to get names)
      const homeName = getTeamNameZh(homeId) || homeId;
      const awayName = getTeamNameZh(awayId) || awayId;
      
      // Use loader to get CSV matches
      if (loader && typeof loader.getH2HMatches === 'function') {
        const csvMatches = loader.getH2HMatches(homeName, awayName);
        csvGames = csvMatches.map(m => ({
          date: m.date || `${m.year}`,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          homeTeamName: m.homeTeam,
          awayTeamName: m.awayTeam,
          score: m.score,
          competition: m.competition || 'World Cup',
          result: m.homeGoals > m.awayGoals ? 'homeWin' : m.homeGoals < m.awayGoals ? 'awayWin' : 'draw',
          year: m.year,
          stage: m.stage,
          source: 'csv',
        }));
      }
    } catch (e) {
      logger.warn('[H2H] CSV lookup failed:', { error: e.message });
    }
    
    // 3. Merge ESPN + CSV, deduplicate by year and score
    const allGames = [...espnGames];
    const existingKeys = new Set();
    
    // Index ESPN games by year+score for dedup
    for (const g of espnGames) {
      const year = g.date ? new Date(g.date).getFullYear() : 0;
      const key = `${year}_${g.score}`;
      existingKeys.add(key);
    }
    
    // Add CSV games that don't duplicate ESPN
    for (const g of csvGames) {
      const key = `${g.year}_${g.score}`;
      if (!existingKeys.has(key)) {
        allGames.push(g);
        existingKeys.add(key);
      }
    }

    // 3. Classify by competition type
    const worldCupLabels = ['FIFA World Cup', 'World Cup', '世界杯'];
    const friendlyLabels = ['Friendly', '友谊赛', '国际友谊赛'];
    const confedLabels = ['Copa América', 'EURO', 'Africa Cup', 'CONCACAF', 'AFC Asian Cup', '洲际杯'];

    const grouped = {
      worldCup: { label: '世界杯', labelI18n: { zh: '世界杯', en: 'World Cup' }, matches: [], stats: null },
      other: { label: '其他比赛', labelI18n: { zh: '其他比赛', en: 'Other Matches' }, subGroups: {} },
    };

    for (const g of allGames) {
      const comp = g.competition || '未知赛事';
      if (worldCupLabels.some(l => comp.includes(l))) {
        grouped.worldCup.matches.push(g);
      } else {
        let subType = '其他';
        let subTypeEn = 'Other';
        if (friendlyLabels.some(l => comp.includes(l))) { subType = '友谊赛'; subTypeEn = 'Friendly'; }
        else if (confedLabels.some(l => comp.includes(l))) { subType = '洲际杯赛'; subTypeEn = 'Continental Cup'; }
        else { subType = comp; subTypeEn = comp; }
        if (!grouped.other.subGroups[subType]) {
          grouped.other.subGroups[subType] = { label: subType, labelI18n: { zh: subType, en: subTypeEn }, matches: [], stats: null };
        }
        grouped.other.subGroups[subType].matches.push(g);
      }
    }

    // 4. Compute stats for each group from the current match perspective.
    const computeStats = (matches) => {
      let homeWins = 0, awayWins = 0, draws = 0;
      for (const m of matches) {
        const [hs, as] = (m.score || '0-0').split('-').map(Number);
        if (hs === as) {
          draws++;
          continue;
        }
        const winnerId = hs > as ? String(m.homeTeam || '') : String(m.awayTeam || '');
        if (homeId && winnerId === homeId) homeWins++;
        else if (awayId && winnerId === awayId) awayWins++;
        else if (hs > as) homeWins++;
        else awayWins++;
      }
      return { total: matches.length, homeWins, awayWins, draws };
    };

    grouped.worldCup.stats = computeStats(grouped.worldCup.matches);
    for (const sub of Object.values(grouped.other.subGroups)) {
      sub.stats = computeStats(sub.matches);
    }

    // 5. Generate summary (streak, recent 10)
    const generateSummary = (matches, teamId) => {
      if (!matches.length) return { streak: null, recent10: [], summaryText: '', summaryTextI18n: { zh: '', en: '' } };
      // Sort by date descending
      const sorted = matches.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      // Compute streak
      let streakCount = 0;
      let streakType = '';
      for (const m of sorted) {
        const [hs, as] = (m.score || '0-0').split('-').map(Number);
        const isHome = m.homeTeam === teamId; // simplified
        const won = (isHome && hs > as) || (!isHome && hs < as);
        const lost = (isHome && hs < as) || (!isHome && hs > as);
        const drawn = hs === as;
        if (streakCount === 0) {
          if (won) { streakType = 'win'; streakCount = 1; }
          else if (lost) { streakType = 'loss'; streakCount = 1; }
          else { streakType = 'draw'; streakCount = 1; }
        } else {
          const prevType = streakType;
          if (won && prevType === 'win') streakCount++;
          else if (lost && prevType === 'loss') streakCount++;
          else if (drawn && prevType === 'draw') streakCount++;
          else break;
        }
      }
      const streakTextZh = streakCount > 0 ? `${streakCount}连${streakType === 'win' ? '胜' : streakType === 'loss' ? '败' : '平'}` : '';
      const streakTextEn = streakCount > 0 ? `${streakCount} consecutive ${streakType === 'win' ? 'wins' : streakType === 'loss' ? 'losses' : 'draws'}` : '';
      // Recent 10
      const recent10 = sorted.slice(0, 10).map(m => {
        const [hs, as] = (m.score || '0-0').split('-').map(Number);
        const isHome = m.homeTeam === teamId;
        const result = (isHome && hs > as) || (!isHome && hs < as) ? 'W' : (isHome && hs < as) || (!isHome && hs > as) ? 'L' : 'D';
        return {
          date: m.date,
          opponent: m.homeTeam === teamId ? m.awayTeam : m.homeTeam,
          score: m.score,
          result,
        };
      });
      // Summary text
      const sampleSize = sorted.length;
      const trendZh = streakType === 'win' ? '交锋占优' : streakType === 'loss' ? '交锋劣势' : '交锋持平';
      const trendEn = streakType === 'win' ? 'head-to-head edge' : streakType === 'loss' ? 'head-to-head disadvantage' : 'level head-to-head';
      const summaryZh = streakTextZh
        ? (sampleSize < 3 ? `${streakTextZh}（样本${sampleSize}场）` : `${streakTextZh}，${trendZh}`)
        : '历史交锋样本不足';
      const summaryEn = streakTextEn
        ? (sampleSize < 3 ? `${streakTextEn} (${sampleSize} sample${sampleSize === 1 ? '' : 's'})` : `${streakTextEn}, ${trendEn}`)
        : 'Insufficient head-to-head sample';
      return {
        streak: streakTextZh,
        streakI18n: { zh: streakTextZh, en: streakTextEn },
        recent10,
        summaryText: summaryZh,
        summaryTextI18n: { zh: summaryZh, en: summaryEn },
      };
    };

    const homeSummary = generateSummary(allGames, homeId);
    const awaySummary = generateSummary(allGames, awayId);
    const groupForm = {};
    try {
      const standingsPayload = routes?.['GET /api/standings']
        ? await routes['GET /api/standings']()
        : null;
      for (const group of (standingsPayload?.groups || [])) {
        for (const row of (group.standings || [])) {
          const id = String(row.id || '');
          if (id !== homeId && id !== awayId) continue;
          groupForm[id === homeId ? 'home' : 'away'] = {
            played: Number(row.played) || 0,
            wins: Number(row.wins) || 0,
            draws: Number(row.draws) || 0,
            losses: Number(row.losses) || 0,
            gf: Number(row.gf) || 0,
            ga: Number(row.ga) || 0,
            pts: Number(row.pts) || 0,
          };
        }
      }
    } catch (e) {
      logger.warn('[H2H] group form lookup failed:', { error: e.message });
    }

    // 6. Build response
    const totalStats = computeStats(allGames);
    const homeTeamName = (getTeamNameZh(homeId) || homeId);
    const awayTeamName = (getTeamNameZh(awayId) || awayId);

    // Compatibility: legacy summary fields
    const legacySummary = totalStats.total ? {
      totalMatches: totalStats.total,
      homeWins: totalStats.homeWins,
      awayWins: totalStats.awayWins,
      draws: totalStats.draws,
      homeWinRate: Math.round(totalStats.homeWins / totalStats.total * 100) + '%',
      awayWinRate: Math.round(totalStats.awayWins / totalStats.total * 100) + '%',
      drawRate: Math.round(totalStats.draws / totalStats.total * 100) + '%',
    } : { totalMatches: 0, homeWins: 0, awayWins: 0, draws: 0, homeWinRate: '0%', awayWinRate: '0%', drawRate: '0%' };

    // Build recentMatches (combined, sorted desc)
    const allSorted = allGames.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const recentMatches = allSorted.slice(0, 10).map(m => {
      const [hs, as] = (m.score || '0-0').split('-').map(Number);
      let result = '平局';
      if (hs > as) result = '主胜';
      else if (hs < as) result = '客胜';
      return {
        date: m.date,
        competition: m.competition || '',
        homeScore: hs,
        awayScore: as,
        result,
        venue: '',
      };
    });

    // Determine data quality and source
    const hasESPN = espnGames.length > 0;
    const hasCSV = csvGames.length > 0;
    let dataQuality = 'unavailable';
    let source = null;
    
    if (hasESPN && hasCSV) {
      dataQuality = 'live';
      source = 'ESPN+CSV';
    } else if (hasESPN) {
      dataQuality = 'live';
      source = 'ESPN';
    } else if (hasCSV) {
      dataQuality = 'historical';
      source = 'CSV';
    }
    
    return {
      dataQuality,
      source,
      matchId: params.matchId,
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
      homeId,
      awayId,
      grouped,
      summary: {
        home: homeSummary,
        away: awaySummary,
        ...legacySummary,
      },
      statistics: { totalGoals: 0, avgGoals: '0.0', homeCleanSheets: 0, awayCleanSheets: 0 },
      recentMatches,
      recent: {
        home: homeSummary.recent10,
        away: awaySummary.recent10,
      },
      groupForm,
    };
  },

  // === Standings with qualified status ===
  'GET /api/team/:id/lineup': async (params) => {
    const lookup = getPlayerRatingData(params.id);
    const team = lookup.team;
    if (!team) return { error: 'Team not found in ratings database' };
    const players = Object.entries(team.players || {}).map(([id, p]) => ({
      id,
      ...p,
      nameZh: playerNameZh.lookup(p.name) || null
    }));
    return {
      teamId: lookup.espnId,
      requestedId: lookup.requestedId,
      ratingsId: lookup.ratingsId,
      name: getTeamNameZh(lookup.espnId),
      formation: team.formation,
      players: assignLineupCoords(players, team.formation)
    };
  },
  
  // === Bench Analysis ===
  'GET /api/match/:id/bench': async (params) => {
    // Get match data to find team IDs
    let homeId = '', awayId = '';
    try {
      const sb = await espn('/scoreboard', 'scores', 60000);
      for (const ev of (sb?.events || [])) {
        if (ev.id === params.id) {
          for (const c of (ev.competitions?.[0]?.competitors || [])) {
            if (c.homeAway === 'home') homeId = String(c.id || '');
            else awayId = String(c.id || '');
          }
          break;
        }
      }
    } catch { logger.debug('matchup: failed to parse scoreboard competitors (first pass)'); }
    
    if (!homeId || !awayId) {
      try {
        const md = await espn(`/summary?event=${params.id}`, `m_${params.id}`, 120000);
        for (const c of (md?.header?.competitions?.[0]?.competitors || [])) {
          if (c.homeAway === 'home') homeId = String(c.id || homeId);
          else awayId = String(c.id || awayId);
        }
      } catch { logger.debug('matchup: failed to parse summary competitors (fallback)'); }
    }
    
    // Get ratings data for both teams
    const homeLookup = getPlayerRatingData(homeId);
    const awayLookup = getPlayerRatingData(awayId);
    const homeData = homeLookup.team;
    const awayData = awayLookup.team;
    
    if (!homeData || !awayData) {
      return { error: 'Team data not found', homeId, awayId };
    }
    
    // Extract all players from ratings
    const homePlayers = Object.entries(homeData.players || {}).map(([id, p]) => ({ id, ...p }));
    const awayPlayers = Object.entries(awayData.players || {}).map(([id, p]) => ({ id, ...p }));
    
    // Split into starters (first 11) and bench
    const homeStarters = homePlayers.slice(0, 11);
    const homeBench = homePlayers.slice(11);
    const awayStarters = awayPlayers.slice(0, 11);
    const awayBench = awayPlayers.slice(11);
    
    // Calculate bench strength
    const calcBenchStrength = (bench) => {
      if (bench.length === 0) return 0;
      const avgRating = bench.reduce((sum, p) => sum + (p.rating || 65), 0) / bench.length;
      const superSubCount = bench.filter(p => p.rating >= 75).length;
      const positionCoverage = new Set(bench.map(p => p.pos)).size / 4; // GK, D, M, F
      return Math.min(100, Math.round(avgRating * 0.6 + superSubCount * 5 + positionCoverage * 20));
    };
    
    // Generate substitution matrix (with Chinese name support)
    const getName = (p) => playerNameZh.lookup(p.name) || p.name || p.id;
    const generateSubMatrix = (starters, bench) => {
      const matrix = {};
      for (const starter of starters) {
        const subs = bench
          .filter(p => p.pos === starter.pos || 
            (['RB','RCB','LCB','LB','CB'].includes(starter.pos) && ['RB','RCB','LCB','LB','CB','D'].includes(p.pos)) ||
            (['CDM','RCM','LCM','CAM','CM','RM','LM','M'].includes(starter.pos) && ['CDM','RCM','LCM','CAM','CM','RM','LM','M'].includes(p.pos)) ||
            (['ST','LW','RW','CF','F'].includes(starter.pos) && ['ST','LW','RW','CF','F'].includes(p.pos))
          )
          .sort((a, b) => (b.rating || 0) - (a.rating || 0));
        
        if (subs.length > 0) {
          matrix[getName(starter)] = {
            primary: getName(subs[0]),
            secondary: subs[1] ? getName(subs[1]) : null,
            tactical: subs.length > 2 ? `${getName(subs[2])} (备选)` : null
          };
        }
      }
      return matrix;
    };
    
    // Analyze player traits
    const analyzeTraits = (player) => {
      const traits = [];
      const dims = player.dims || {};
      
      if (dims.attack > 80) traits.push('进攻能力强');
      if (dims.defense > 80) traits.push('防守稳健');
      if (dims.physical > 80) traits.push('身体素质好');
      if (dims.form > 80) traits.push('状态出色');
      if (dims.experience > 80) traits.push('经验丰富');
      if (player.rating >= 80) traits.push('核心球员');
      if (player.rating >= 75 && player.rating < 80) traits.push('主力级别');
      
      return traits.length > 0 ? traits : ['轮换球员'];
    };
    
    // Calculate appearance probability
    const calcAppearanceProb = (player, isStarter) => {
      if (isStarter) return 1.0;
      const rating = player.rating || 65;
      const form = player.dims?.form || 65;
      return Math.min(0.95, Math.max(0.1, (rating * 0.4 + form * 0.6) / 100));
    };
    
    // Determine impact type
    const getImpactType = (player) => {
      const dims = player.dims || {};
      if (dims.attack > dims.defense && dims.attack > dims.physical) return 'creative';
      if (dims.defense > dims.attack && dims.defense > dims.physical) return 'defensive';
      if (dims.physical > dims.attack && dims.physical > dims.defense) return 'physical';
      return 'balanced';
    };
    
    // Build bench analysis response
    const buildTeamBench = (teamId, teamName, starters, bench) => {
      const benchPlayers = bench.map(p => ({
        playerId: p.id,
        name: p.name,
        nameZh: playerNameZh.lookup(p.name) || null,
        pos: p.pos,
        jersey: p.jersey,
        rating: p.rating,
        traits: analyzeTraits(p),
        substituteFor: starters
          .filter(s => s.pos === p.pos || 
            (['RB','RCB','LCB','LB','CB'].includes(s.pos) && ['RB','RCB','LCB','LB','CB','D'].includes(p.pos)) ||
            (['CDM','RCM','LCM','CAM','CM','RM','LM','M'].includes(s.pos) && ['CDM','RCM','LCM','CAM','CM','RM','LM','M'].includes(p.pos)) ||
            (['ST','LW','RW','CF','F'].includes(s.pos) && ['ST','LW','RW','CF','F'].includes(p.pos))
          )
          .map(s => playerNameZh.lookup(s.name) || s.name || s.id)
          .slice(0, 2),
        appearanceProb: calcAppearanceProb(p, false),
        impactType: getImpactType(p),
        recentForm: (p.dims?.form || 65) >= 75 ? 'good' : (p.dims?.form || 65) >= 65 ? 'average' : 'poor',
        injuryStatus: null,
        notes: null
      }));
      
      return {
        teamId,
        teamName,
        bench: benchPlayers,
        benchStrength: calcBenchStrength(bench),
        superSubCount: benchPlayers.filter(p => p.rating >= 75).length,
        defensiveOptions: benchPlayers.filter(p => ['RB','RCB','LCB','LB','CB','D','CDM'].includes(p.pos)).length,
        attackingOptions: benchPlayers.filter(p => ['ST','LW','RW','CF','F','CAM','RM','LM'].includes(p.pos)).length,
        substitutionMatrix: generateSubMatrix(starters, bench)
      };
    };
    
    const homeTeamName = getTeamNameZh(homeLookup.espnId);
    const awayTeamName = getTeamNameZh(awayLookup.espnId);
    
    const homeTeam = buildTeamBench(homeId, homeTeamName, homeStarters, homeBench);
    const awayTeam = buildTeamBench(awayId, awayTeamName, awayStarters, awayBench);
    const normalizePlayerName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const substitutionImpacts = getSubstitutionImpacts(params.id).map(item => {
      const teamId = String(item.teamId || '');
      const playerIn = normalizePlayerName(item.playerIn);
      let side = teamId === String(homeId) || teamId === 'home' ? 'home'
        : teamId === String(awayId) || teamId === 'away' ? 'away'
          : null;
      if (!side && playerIn) {
        if (homeBench.some(player => normalizePlayerName(player.name).includes(playerIn)
          || playerIn.includes(normalizePlayerName(player.name)))) side = 'home';
        else if (awayBench.some(player => normalizePlayerName(player.name).includes(playerIn)
          || playerIn.includes(normalizePlayerName(player.name)))) side = 'away';
      }
      return {
        ...item,
        side,
        teamImpact: side && item.impact?.[side] ? item.impact[side] : null,
      };
    });

    return {
      matchId: params.id,
      homeTeam,
      awayTeam,
      substitutionImpacts,
      comparison: {
        homeStrength: calcBenchStrength(homeBench),
        awayStrength: calcBenchStrength(awayBench),
        advantage: calcBenchStrength(homeBench) > calcBenchStrength(awayBench) ? 'home' :
                  calcBenchStrength(homeBench) < calcBenchStrength(awayBench) ? 'away' : 'even'
      }
    };
  },
  
  // === Matchup Formation (using matchup-api.js module) ===
  'GET /api/matchup/:id/formation': async (params) => {
    if (!matchupAPI) return { error: 'Matchup API module not loaded' };
    
    // Get team IDs from scoreboard
    let homeId = '', awayId = '';
    try {
      const sb = await espn('/scoreboard', 'scores', 60000);
      for (const ev of (sb?.events || [])) {
        if (ev.id === params.id) {
          for (const c of (ev.competitions?.[0]?.competitors || [])) {
            if (c.homeAway === 'home') homeId = String(c.id || '');
            else awayId = String(c.id || '');
          }
          break;
        }
      }
    } catch { logger.debug('matchup: failed to parse scoreboard competitors (second route)'); }
    
    if (!homeId || !awayId) {
      try {
        const md = await espn(`/summary?event=${params.id}`, `m_${params.id}`, 120000);
        for (const c of (md?.header?.competitions?.[0]?.competitors || [])) {
          if (c.homeAway === 'home') homeId = String(c.id || homeId);
          else awayId = String(c.id || awayId);
        }
      } catch { logger.debug('matchup: failed to parse summary competitors (second fallback)'); }
    }

    // === FIFA lineups path (preferred when available) ===
    try {
      const lineupsData = lineupsSource.getLineups(params.id);
      if (lineupsData?.homeXI && lineupsData?.awayXI) {
        const FP_TO_POS = { 0: 'GK', 1: 'CB', 2: 'CM', 3: 'ST' };
        const mapXI = (xi) => xi.map(p => ({
          id: p.fifaPlayerId || p.name,
          name: p.name,
          pos: p.pos === 'GK' ? 'GK' : FP_TO_POS[p.fieldPos] || 'CM',
          jersey: String(p.number || ''),
        }));
        const buildRatings = (xi, teamId) => {
          const ratingTeam = matchupSpatial?.getPlayerRatingData(teamId)?.team
            || getPlayerRatingData(teamId)?.team;
          const squad = Object.values(ratingTeam?.players || {});
          const r = {};
          for (const p of xi) {
            const pid = p.fifaPlayerId || p.name;
            const matched = fuzzyMatchPlayer(
              { name: p.name, num: p.number },
              squad.map(sp => ({ ...sp, num: sp.jersey || sp.num }))
            );
            r[pid] = {
              name: p.name,
              pos: p.pos === 'GK' ? 'GK' : matched?.pos || FP_TO_POS[p.fieldPos] || 'CM',
              rating: matched?.rating || 70,
            };
          }
          return r;
        };
        const homeTeamName = getTeamNameZh(homeId) || homeId;
        const awayTeamName = getTeamNameZh(awayId) || awayId;
        const homeTeam = { id: homeId || 'home', name: homeTeamName, shortName: homeId, roster: mapXI(lineupsData.homeXI) };
        const awayTeam = { id: awayId || 'away', name: awayTeamName, shortName: awayId, roster: mapXI(lineupsData.awayXI) };
        const ratingsWrapped = { data: {} };
        ratingsWrapped.data[homeTeam.id] = { formation: lineupsData.homeFormation || '4-3-3', players: buildRatings(lineupsData.homeXI, homeId) };
        ratingsWrapped.data[awayTeam.id] = { formation: lineupsData.awayFormation || '4-3-3', players: buildRatings(lineupsData.awayXI, awayId) };
        const result = matchupAPI.handleMatchupFormation(
          {}, params.id, homeTeam, awayTeam, ratingsWrapped, getCached(`odds_${params.id}`) || {}, null
        );
        result.pairs = (result.pairs || []).map(pair => ({
          ...pair,
          diff: pair.diff ?? pair.gap ?? 0,
          key: Math.abs(pair.diff ?? pair.gap ?? 0) >= 5,
        }));
        result.substitutions = enrichSubstitutions(lineupsData.substitutions || [], homeId, awayId);
        return result;
      }
    } catch (e) { logger.debug('matchup: FIFA lineups lookup failed:', { error: e.message }); }

    // === ESPN Summary Roster path (preferred for finished matches) ===
    try {
      const summary = await espn(`/summary?event=${params.id}`, `m_${params.id}`, 120000);
      const rosters = summary?.rosters || [];
      if (rosters.length >= 2) {
        const ESPN_POS = { G: 'GK', GK: 'GK', D: 'CB', F: 'ST', M: 'CM', MF: 'CM', FW: 'ST', DF: 'CB', MID: 'CM', FWD: 'ST', DEF: 'CB' };
        const buildFromEspnRoster = (rosterEntry, teamId) => {
          const formation = rosterEntry.formation || '4-3-3';
          const { FORM_COORDS } = require('../lineup-coords');
          const coords = FORM_COORDS[formation] || FORM_COORDS['4-3-3'];
          // Get team ratings for enrichment
          const teamRatings = getPlayerRatingData(teamId);
          const squadPlayers = Object.values(teamRatings.team?.players || {});
          const starters = (rosterEntry.roster || [])
            .filter(p => p.starter)
            .sort((a, b) => (parseInt(a.formationPlace) || 99) - (parseInt(b.formationPlace) || 99));
          const players = starters.map((p, i) => {
            const coord = coords[i] || coords[coords.length - 1];
            const abbr = p.position?.abbreviation || 'M';
            const displayName = p.athlete?.displayName || p.athlete?.shortName || `#${p.jersey}`;
            // Try to enrich rating via fuzzy name match against team ratings
            let rating = 75;
            if (squadPlayers.length > 0) {
              const lastName = displayName.split(' ').pop().toLowerCase();
              const match = squadPlayers.find(sp => {
                const spName = String(sp.name || '').toLowerCase();
                return spName.includes(lastName) || lastName.includes(spName.split(' ').pop());
              });
              if (match?.rating) rating = match.rating;
            }
            return {
              id: p.athlete?.id || `p${i}`,
              name: displayName,
              pos: ESPN_POS[abbr.toUpperCase()] || coord.pos || 'CM',
              jersey: p.jersey || String(i + 1),
              rating,
              x: coord.x,
              y: coord.y,
            };
          });
          return { teamId, formation, players };
        };
        const homeRosterEntry = rosters.find(r => r.homeAway === 'home') || rosters[0];
        const awayRosterEntry = rosters.find(r => r.homeAway === 'away') || rosters[1];
        const homeBuilt = buildFromEspnRoster(homeRosterEntry, homeId);
        const awayBuilt = buildFromEspnRoster(awayRosterEntry, awayId);
        if (homeBuilt.players.length >= 11 && awayBuilt.players.length >= 11) {
          const groupByLine = (players) => ({
            gk:  players.filter(p => p.pos === 'GK'),
            def: players.filter(p => ['CB','LB','RB','LWB','RWB'].includes(p.pos)),
            mid: players.filter(p => ['CM','CDM','CAM','LM','RM','LW','RW'].includes(p.pos)),
            fwd: players.filter(p => ['ST','CF'].includes(p.pos)),
            players,
          });
          const homeName = getTeamNameZh(homeId) || homeRosterEntry.team?.displayName || homeId;
          const awayName = getTeamNameZh(awayId) || awayRosterEntry.team?.displayName || awayId;
          const homeGrouped = groupByLine(homeBuilt.players);
          const awayGrouped = groupByLine(awayBuilt.players);
          // Generate spatial pairs using matchupSpatial.pairPlayers
          let pairs = [], homeAdv = 0, awayAdv = 0, even = 0;
          try {
            if (matchupSpatial?.pairPlayers) {
              pairs = matchupSpatial.pairPlayers(homeGrouped, awayGrouped);
              for (const p of pairs) {
                if (p.advantage === 'home') homeAdv++;
                else if (p.advantage === 'away') awayAdv++;
                else even++;
              }
            }
          } catch (e) { logger.debug('matchup: pairPlayers failed:', { error: e.message }); }

          // Extract substitutions from ESPN keyEvents
          const subEvents = (summary.keyEvents || []).filter(e => e.type?.text === 'Substitution' || e.type?.id === '76');
          // Build jersey lookup from both rosters
          const jerseyById = new Map();
          const nameById = new Map();
          for (const rEntry of rosters) {
            for (const p of (rEntry.roster || [])) {
              const aid = String(p.athlete?.id || '');
              if (aid) {
                if (p.jersey) jerseyById.set(aid, p.jersey);
                if (p.athlete?.displayName) nameById.set(aid, p.athlete.displayName);
              }
            }
          }
          const homeTeamId = homeRosterEntry.team?.id || '';
          const awayTeamId = awayRosterEntry.team?.id || '';
          const substitutions = subEvents.map(e => {
            const onAthlete = e.participants?.[0]?.athlete;
            const offAthlete = e.participants?.[1]?.athlete;
            const onId = String(onAthlete?.id || '');
            const offId = String(offAthlete?.id || '');
            const matchTeamId = String(e.team?.id || '');
            const side = matchTeamId === homeTeamId ? 'home' : 'away';
            return {
              on: onId,
              onName: onAthlete?.displayName || nameById.get(onId) || '?',
              onJersey: jerseyById.get(onId) || '?',
              off: offId,
              offName: offAthlete?.displayName || nameById.get(offId) || '?',
              offJersey: jerseyById.get(offId) || '?',
              minute: e.clock?.displayValue || '?',
              side,
            };
          });

          return {
            home: { team: homeName, teamId: homeId, formation: homeBuilt.formation, ...homeGrouped },
            away: { team: awayName, teamId: awayId, formation: awayBuilt.formation, ...awayGrouped },
            pairs,
            summary: { homeAdvantages: homeAdv, awayAdvantages: awayAdv, evenPairs: even,
              avgGap: pairs.length > 0 ? Math.round(pairs.reduce((s, p) => s + Math.abs(p.diff), 0) / pairs.length * 10) / 10 : 0 },
            substitutions,
          };
        }
      }
    } catch (e) { logger.debug('matchup: ESPN roster path failed:', { error: e.message }); }

    // Find team in RATINGS by ESPN ID or name
    const findTeamInRatings = (espnId) => {
      return getPlayerRatingData(espnId).team;
    };
    
    const homeData = findTeamInRatings(homeId);
    const awayData = findTeamInRatings(awayId);
    if (!homeData || !awayData) {
      // Fallback: try to build basic formation from ESPN summary roster (for finished matches)
      try {
        const summary = await espn(`/summary?event=${params.id}`, `m_${params.id}`, 120000);
        const rosters = summary?.rosters || summary?.boxscore?.players || [];
        if (rosters.length >= 2) {
          const buildTeamFromRoster = (rosterEntry, teamId, teamName) => {
            const players = (rosterEntry.roster || rosterEntry.statistics || []).map((p, i) => ({
              id: p.athlete?.id || `p${i}`,
              name: p.athlete?.displayName || p.athlete?.shortName || `Player ${i+1}`,
              pos: p.athlete?.position?.abbreviation || 'CM',
              jersey: p.athlete?.jersey || String(i + 1),
              rating: 70,
            }));
            return { id: teamId, name: teamName, shortName: teamName, roster: players };
          };
          const homeRoster = rosters.find(r => String(r.team?.id) === homeId) || rosters[0];
          const awayRoster = rosters.find(r => String(r.team?.id) === awayId) || rosters[1];
          const homeName = summary?.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName || homeId;
          const awayName = summary?.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName || awayId;
          const homeTeamFallback = buildTeamFromRoster(homeRoster, homeId, homeName);
          const awayTeamFallback = buildTeamFromRoster(awayRoster, awayId, awayName);
          const ratingsWrapped = { data: {} };
          try {
            const result = matchupAPI.handleMatchupFormation(
              {}, params.id, homeTeamFallback, awayTeamFallback, ratingsWrapped, {}, null
            );
            return result;
          } catch { logger.debug('matchup: matchupAPI.handleMatchupFormation failed'); }
        }
      } catch { logger.warn('matchup: both scoreboard and summary competitor parsing failed'); }
      return { error: 'Team not in ratings', homeId, awayId };
    }
    
    // Adapt format for matchup-api.js
    // His pickLineup expects: roster [{id, name, pos, jersey}] + ratings {playerId: {name, pos, rating}}
    const homeTeam = { id: homeId, name: homeData.name, shortName: homeData.name,
      roster: Object.entries(homeData.players || {}).map(([pid, p], i) => ({
        id: pid, name: p.name, pos: p.pos, jersey: p.jersey || i + 1
      })) };
    const awayTeam = { id: awayId, name: awayData.name, shortName: awayData.name,
      roster: Object.entries(awayData.players || {}).map(([pid, p], i) => ({
        id: pid, name: p.name, pos: p.pos, jersey: p.jersey || i + 1
      })) };
    
    const ratingsWrapped = { data: {} };
    ratingsWrapped.data[homeId] = { formation: homeData.formation, players: {} };
    ratingsWrapped.data[awayId] = { formation: awayData.formation, players: {} };
    
    for (const [pid, p] of Object.entries(homeData.players || {})) {
      ratingsWrapped.data[homeId].players[pid] = { name: p.name, pos: p.pos, rating: p.rating };
    }
    for (const [pid, p] of Object.entries(awayData.players || {})) {
      ratingsWrapped.data[awayId].players[pid] = { name: p.name, pos: p.pos, rating: p.rating };
    }
    
    const oddsCache = getCached(`odds_${params.id}`) || {};
    
    try {
      const result = matchupAPI.handleMatchupFormation(
        {}, params.id, homeTeam, awayTeam, ratingsWrapped, oddsCache, null
      );
      return result;
    } catch (e) {
      return { error: 'Matchup calculation failed', details: e.message };
    }
  },

  // === Corner Prediction ===
  'GET /api/corner-analysis/:id': async (params) => {
    // Get match data for real-time corners
    let matchData = null;
    try {
      matchData = await espn(`/summary?event=${params.id}`, `m_${params.id}`, 120000);
    } catch { logger.warn('matchup: ESPN summary fetch failed'); }

    // Get team IDs
    let homeId = '', awayId = '';
    try {
      const sb = await espn('/scoreboard', 'scores', 60000);
      for (const ev of (sb?.events || [])) {
        if (ev.id === params.id) {
          for (const c of (ev.competitions?.[0]?.competitors || [])) {
            if (c.homeAway === 'home') homeId = String(c.id || '');
            else awayId = String(c.id || '');
          }
          break;
        }
      }
    } catch { logger.debug('matchup: failed to parse competitors from summary (third route)'); }

    const homeLookup = getPlayerRatingData(homeId);
    const awayLookup = getPlayerRatingData(awayId);
    const homeData = homeLookup.team;
    const awayData = awayLookup.team;

    // Style coefficients are now centralized in lib/corner-model.js
    // Get coach styles
    const coachLookup = async (tid) => { try { return await routes['GET /api/coach/:teamId']({teamId:tid}); } catch { return {}; } };
    const homeCoach = await coachLookup(homeId);
    const awayCoach = await coachLookup(awayId);
    const homeStyleCoeff = getStyleCoeff(homeCoach?.style);
    const awayStyleCoeff = getStyleCoeff(awayCoach?.style);

    // Historical averages — try real data from recent-stats, fallback to defaults
    let homeAvgCorners = 4.5;  // fallback default
    let awayAvgCorners = 3.8;  // fallback default
    try {
      const recentStatsRoute = routes['GET /api/team/:id/recent-stats'];
      if (recentStatsRoute && homeId && awayId) {
        const [homeRecent, awayRecent] = await Promise.all([
          recentStatsRoute({ id: homeId }).catch(() => null),
          recentStatsRoute({ id: awayId }).catch(() => null),
        ]);
        if (homeRecent?.stats?.corners?.avg > 0) homeAvgCorners = homeRecent.stats.corners.avg;
        if (awayRecent?.stats?.corners?.avg > 0) awayAvgCorners = awayRecent.stats.corners.avg;
      }
    } catch { logger.debug('corner-analysis: recent-stats fallback to defaults'); }

    // Predicted corners — uses centralized lib/corner-model.js
    const cornerPred = predictCorners(homeAvgCorners, awayAvgCorners, homeCoach?.style, awayCoach?.style);
    const homePredicted = cornerPred.home;
    const awayPredicted = cornerPred.away;
    const totalPredicted = cornerPred.total;

    // Get odds line
    const oddsData = getCached(`odds_${params.id}`) || {};
    const oddsLine = oddsData.corners?.line || 9.5;

    // Get real-time corners from match stats
    let homeCorners = 0, awayCorners = 0, minute = 0;
    if (matchData) {
      const stats = matchData.boxscore?.teams || [];
      if (stats.length >= 2) {
        for (const s of (stats[0].statistics || [])) {
          if (s.name === 'wonCorners' || s.abbreviation === 'CK') homeCorners = parseInt(s.displayValue) || 0;
        }
        for (const s of (stats[1].statistics || [])) {
          if (s.name === 'wonCorners' || s.abbreviation === 'CK') awayCorners = parseInt(s.displayValue) || 0;
        }
      }
      // Get minute from status
      const status = matchData.header?.competitions?.[0]?.status || {};
      minute = parseInt(status.displayClock?.replace(/[^0-9]/g, '')) || 0;
    }

    const totalCurrent = homeCorners + awayCorners;

    // Real-time adjustment
    let realtimePredicted = totalPredicted;
    if (minute > 0) {
      const projectedFull = (totalCurrent / minute) * 90;
      // Dynamic weight based on minute
      let baseWeight, realtimeWeight;
      if (minute <= 15) { baseWeight = 0.8; realtimeWeight = 0.2; }
      else if (minute <= 30) { baseWeight = 0.6; realtimeWeight = 0.4; }
      else if (minute <= 60) { baseWeight = 0.4; realtimeWeight = 0.6; }
      else { baseWeight = 0.2; realtimeWeight = 0.8; }
      realtimePredicted = Math.round((totalPredicted * baseWeight + projectedFull * realtimeWeight) * 10) / 10;
    }

    // Over/Under verdict
    const diff = realtimePredicted - oddsLine;
    let trend, confidence;
    if (Math.abs(diff) < 0.5) { trend = 'neutral'; confidence = 'low'; }
    else if (diff > 1.5) { trend = 'over_strong'; confidence = 'high'; }
    else if (diff > 0.5) { trend = 'over_slight'; confidence = 'medium'; }
    else if (diff < -1.5) { trend = 'under_strong'; confidence = 'high'; }
    else { trend = 'under_slight'; confidence = 'medium'; }

    // Pace
    const expectedByNow = (minute / 90) * oddsLine;
    let pace = 'on_track';
    if (totalCurrent < expectedByNow - 0.5) pace = 'below';
    else if (totalCurrent > expectedByNow + 0.5) pace = 'above';

    // Progress bar
    const progress = Math.round((totalCurrent / oddsLine) * 100);
    const expectedProgress = Math.round((minute / 90) * 100);

    // Reasoning
    const reasons = [];
    const homeNameI18n = getTeamNameI18n(homeLookup.espnId);
    const awayNameI18n = getTeamNameI18n(awayLookup.espnId);
    if (homeStyleCoeff > 1.1) reasons.push({
      key: 'home_wing_attack',
      text: `${homeNameI18n.zh || '主队'}边路进攻型(${homeStyleCoeff})`,
      textI18n: {
        zh: `${homeNameI18n.zh || '主队'}边路进攻型(${homeStyleCoeff})`,
        en: `${homeNameI18n.en || 'Home'} wing-oriented attacking profile (${homeStyleCoeff})`,
      },
    });
    if (awayStyleCoeff < 0.85) reasons.push({
      key: 'away_counter_defense',
      text: `${awayNameI18n.zh || '客队'}防守反击型(${awayStyleCoeff})`,
      textI18n: {
        zh: `${awayNameI18n.zh || '客队'}防守反击型(${awayStyleCoeff})`,
        en: `${awayNameI18n.en || 'Away'} defensive counter-attacking profile (${awayStyleCoeff})`,
      },
    });
    if (pace === 'below') reasons.push({
      key: 'pace_below',
      text: '当前节奏低于预期',
      textI18n: { zh: '当前节奏低于预期', en: 'Current pace is below expectation' },
    });
    if (pace === 'above') reasons.push({
      key: 'pace_above',
      text: '当前节奏高于预期',
      textI18n: { zh: '当前节奏高于预期', en: 'Current pace is above expectation' },
    });
    const trendLabelI18n = {
      over_strong: { zh: '强烈倾向大球', en: 'Strong lean over' },
      over_slight: { zh: '轻微倾向大球', en: 'Slight lean over' },
      under_strong: { zh: '强烈倾向小球', en: 'Strong lean under' },
      under_slight: { zh: '轻微倾向小球', en: 'Slight lean under' },
      neutral: { zh: '暂无明确倾向', en: 'No clear lean' },
    }[trend] || { zh: trend.replace('_', ' '), en: trend.replace('_', ' ') };
    const fallbackReasonI18n = { zh: '数据不足，暂无明确倾向', en: 'Insufficient data, no clear lean yet' };
    const reasonI18n = reasons.length
      ? {
          zh: `${reasons.map(r => r.textI18n.zh).join(' + ')} → ${trendLabelI18n.zh}`,
          en: `${reasons.map(r => r.textI18n.en).join(' + ')} -> ${trendLabelI18n.en}`,
        }
      : fallbackReasonI18n;

    return {
      matchId: params.id,
      minute,
      historical: {
        homeAvg: homeAvgCorners,
        awayAvg: awayAvgCorners,
        homeStyle: homeCoach.style || '均衡型',
        awayStyle: awayCoach.style || '均衡型',
        homeStyleCoeff,
        awayStyleCoeff,
      },
      predicted: {
        total: totalPredicted,
        home: Math.round(homePredicted * 10) / 10,
        away: Math.round(awayPredicted * 10) / 10,
        realtimeAdjusted: realtimePredicted,
      },
      odds: {
        line: oddsLine,
        over: oddsData.corners?.over || null,
        under: oddsData.corners?.under || null,
      },
      realtime: {
        current: { home: homeCorners, away: awayCorners, total: totalCurrent },
        pace,
        projection: minute > 0 ? Math.round((totalCurrent / minute) * 90 * 10) / 10 : null,
        vsOddsLine: minute > 0 ? Math.round(((totalCurrent / minute) * 90 - oddsLine) * 10) / 10 : null,
      },
      progress: {
        actual: progress,
        expected: expectedProgress,
        status: progress < expectedProgress ? 'under_direction' : progress > expectedProgress ? 'over_direction' : 'on_track',
      },
      verdict: {
        trend,
        confidence,
        reason: reasonI18n.zh,
        reasonI18n,
        reasons,
      },
    };
  },

  // === Enhanced Odds Alerts (异动检测增强) ===
  'GET /api/matchup-spatial/:home/:away': async (params) => {
    const homeId = String(params.home);
    const awayId = String(params.away);
    if (!matchupSpatial) return { error: 'Spatial Matchup library not loaded' };
    
    // 查找比赛 ID 并获取真实阵容数据
    let matchOptions = {};
    
    try {
      // 1. 将 ESPN team ID 转换为 FIFA 代码（idBridge 由 server.js 加载并注入 deps）
      const homeFifaCode = Object.keys(idBridge).find(code => String(idBridge[code].espn_id) === homeId);
      const awayFifaCode = Object.keys(idBridge).find(code => String(idBridge[code].espn_id) === awayId);
      
      if (homeFifaCode && awayFifaCode) {
        // 2. 查找比赛 ID
        const { resolveDataPath } = require('../data-resolver');
        const matchesPath = resolveDataPath('matches.json');
        const matchesContent = await fsPromises.readFile(matchesPath, 'utf8');
        const matches = JSON.parse(matchesContent);
        const match = matches.matches?.find(m => {
          const homeCode = (m.home?.code || '').trim().toUpperCase();
          const awayCode = (m.away?.code || '').trim().toUpperCase();
          return homeCode === homeFifaCode && awayCode === awayFifaCode;
        });
        
        if (match) {
          // 3. 获取真实阵容数据
          const lineupsData = lineupsSource.getLineups(match.id);
          
          if (lineupsData.hasRealLineups) {
            matchOptions = {
              homeFormation: lineupsData.homeFormation,
              awayFormation: lineupsData.awayFormation,
              homeLineup: lineupsData.homeXI,
              awayLineup: lineupsData.awayXI,
              substitutions: enrichSubstitutions(lineupsData.substitutions || [], homeId, awayId),
              source: 'official',
              publishedAt: lineupsData.publishedAt || null
            };
          } else {
            // 无真实阵容，使用阵型规则
            matchOptions = {
              homeFormation: lineupsData.homeFormation,
              awayFormation: lineupsData.awayFormation,
              source: lineupsData.homeFormationSource || 'projected',
              publishedAt: null
            };
          }
        }
      }
    } catch (e) {
      logger.warn('[matchup-spatial] 获取阵容数据失败:', { error: e.message });
    }
    
    return matchupSpatial.buildSpatialMatchup(homeId, awayId, ratingsData, matchOptions);
  },

  // === Analysis Card (pre-match) ===
  'GET /api/analysis/:matchId': async (params) => {
    // Generate pre-match analysis card
    return {
      matchId: params.matchId,
      note: 'Full analysis generation will be implemented in Phase 4',
      // Will combine: venue + weather + coach + odds + player data + AI analysis
    };
  },

  // === Team Lineup from ratings.json ===
  };
};
