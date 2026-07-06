#!/usr/bin/env node
/**
 * Sync completed World Cup group matches from ESPN into SQLite.
 *
 * This updates:
 * - matches: played, score, match_date, venue
 * - group_standings: played, W/D/L, GF/GA/GD, points
 *
 * It is safe to rerun: standings are reset and recomputed from completed DB matches.
 */
const { espn } = require('../services/espn');
const { db } = require('../lib/db');
const teamResolver = require('../lib/team_resolver');

const WC_GROUPS = {
  A: ['203', '467', '451', '450'],
  B: ['206', '452', '4398', '475'],
  C: ['205', '2869', '2654', '580'],
  D: ['660', '210', '628', '465'],
  E: ['481', '11678', '4789', '209'],
  F: ['449', '627', '466', '659'],
  G: ['459', '2620', '469', '2666'],
  H: ['164', '2597', '655', '212'],
  I: ['478', '654', '4375', '464'],
  J: ['202', '624', '474', '2917'],
  K: ['482', '2850', '2570', '208'],
  L: ['448', '477', '4469', '2659'],
};

const TEAM_TO_GROUP = Object.fromEntries(
  Object.entries(WC_GROUPS).flatMap(([group, ids]) => ids.map((id) => [id, group])),
);

function dateKeyFromOffset(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
}

function parseEvent(ev) {
  const comp = ev.competitions?.[0] || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  const status = comp.status?.type || {};
  if (status.state !== 'post') return null;

  const homeEspnId = home?.team?.id;
  const awayEspnId = away?.team?.id;
  const group = TEAM_TO_GROUP[homeEspnId];
  if (!group || group !== TEAM_TO_GROUP[awayEspnId]) return null;

  const homeId = teamResolver.getRatingsIdByEspnId(homeEspnId);
  const awayId = teamResolver.getRatingsIdByEspnId(awayEspnId);
  const homeScore = Number.parseInt(home?.score, 10);
  const awayScore = Number.parseInt(away?.score, 10);
  if (!homeId || !awayId || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;

  return {
    espnId: ev.id || '',
    group,
    homeId,
    awayId,
    homeScore,
    awayScore,
    date: ev.date || '',
    venue: comp.venue?.fullName || '',
  };
}

async function fetchCompletedMatches(daysBack) {
  const byId = new Map();
  for (let i = -daysBack; i <= 0; i++) {
    const dateKey = dateKeyFromOffset(i);
    try {
      const data = await espn(`/scoreboard?dates=${dateKey}`, `sync_${dateKey}`, 600000);
      for (const event of data.events || []) {
        const parsed = parseEvent(event);
        if (parsed) byId.set(parsed.espnId, parsed);
      }
    } catch (e) {
      console.warn(`Skipping ${dateKey}: ${e.message}`);
    }
  }
  return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function applyResult(table, homeId, awayId, homeScore, awayScore) {
  const home = table.get(homeId);
  const away = table.get(awayId);
  if (!home || !away) return;

  home.played++;
  away.played++;
  home.goals_for += homeScore;
  home.goals_against += awayScore;
  away.goals_for += awayScore;
  away.goals_against += homeScore;

  if (homeScore > awayScore) {
    home.wins++;
    away.losses++;
    home.points += 3;
  } else if (awayScore > homeScore) {
    away.wins++;
    home.losses++;
    away.points += 3;
  } else {
    home.draws++;
    away.draws++;
    home.points++;
    away.points++;
  }

  home.goal_difference = home.goals_for - home.goals_against;
  away.goal_difference = away.goals_for - away.goals_against;
}

function syncToDb(completedMatches) {
  if (completedMatches.length === 0) {
    return { matched: 0, applied: [], unmatched: [] };
  }

  const normalizeSeededTeamIds = db.transaction(() => {
    const aliases = [
      ['United States', 'USA'],
    ];
    for (const [from, to] of aliases) {
      db.prepare('UPDATE group_standings SET team_id = ?, team_name = ? WHERE team_id = ?').run(to, to, from);
      db.prepare('UPDATE matches SET home_team_id = ? WHERE home_team_id = ?').run(to, from);
      db.prepare('UPDATE matches SET away_team_id = ? WHERE away_team_id = ?').run(to, from);
    }
  });
  normalizeSeededTeamIds();

  const getGroup = db.prepare('SELECT id FROM groups WHERE group_name = ?');
  const findMatch = db.prepare(`
    SELECT id FROM matches
    WHERE group_id = ?
      AND (
        (home_team_id = ? AND away_team_id = ?)
        OR (home_team_id = ? AND away_team_id = ?)
      )
    LIMIT 1
  `);
  const updateMatch = db.prepare(`
    UPDATE matches
    SET home_team_id = ?, away_team_id = ?, home_score = ?, away_score = ?,
        played = 1, match_date = ?, venue = ?
    WHERE id = ?
  `);
  const standingsRows = db.prepare('SELECT * FROM group_standings').all();
  const resetStandings = db.prepare(`
    UPDATE group_standings
    SET played = 0, wins = 0, draws = 0, losses = 0,
        goals_for = 0, goals_against = 0, goal_difference = 0, points = 0
  `);
  const updateStanding = db.prepare(`
    UPDATE group_standings
    SET played = ?, wins = ?, draws = ?, losses = ?,
        goals_for = ?, goals_against = ?, goal_difference = ?, points = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    let matched = 0;
    const applied = [];
    const unmatched = [];

    for (const match of completedMatches) {
      const groupRow = getGroup.get(match.group);
      if (!groupRow) {
        unmatched.push({ ...match, reason: 'group_not_found' });
        continue;
      }
      const row = findMatch.get(groupRow.id, match.homeId, match.awayId, match.awayId, match.homeId);
      if (!row) {
        unmatched.push({ ...match, reason: 'match_pair_not_seeded' });
        continue;
      }
      updateMatch.run(
        match.homeId,
        match.awayId,
        match.homeScore,
        match.awayScore,
        match.date,
        match.venue,
        row.id,
      );
      matched++;
      applied.push(match);
    }

    resetStandings.run();

    const table = new Map(standingsRows.map((row) => [row.team_id, {
      id: row.id,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
    }]));

    for (const match of applied) {
      applyResult(table, match.homeId, match.awayId, match.homeScore, match.awayScore);
    }

    for (const row of table.values()) {
      updateStanding.run(
        row.played,
        row.wins,
        row.draws,
        row.losses,
        row.goals_for,
        row.goals_against,
        row.goal_difference,
        row.points,
        row.id,
      );
    }

    return { matched, applied, unmatched };
  });

  return tx();
}

async function main() {
  // 确保 matches 表已有赛程：findMatch 依赖其存在，否则同步会静默 matched:0
  try {
    const { groups } = require('../lib/db');
    groups.seedRealGroups();
  } catch (e) {
    console.warn(`Schedule seeding skipped: ${e.message}`);
  }

  const daysBack = Number.parseInt(process.argv[2] || '14', 10);
  const completedMatches = await fetchCompletedMatches(Number.isFinite(daysBack) ? daysBack : 14);
  const result = syncToDb(completedMatches);

  console.log(`Fetched completed group matches: ${completedMatches.length}`);
  console.log(`Synced DB matches: ${result.matched}`);
  for (const match of result.applied) {
    console.log(`${match.group}: ${match.homeId} ${match.homeScore}-${match.awayScore} ${match.awayId}`);
  }
  for (const match of result.unmatched) {
    console.warn(`Unmatched ${match.group}: ${match.homeId} ${match.homeScore}-${match.awayScore} ${match.awayId} (${match.reason})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
