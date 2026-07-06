#!/usr/bin/env node
'use strict';

/**
 * P3-4 · p3/lineup-ci 阵容置信区间联动测试
 * 验证首发公布对预测置信区间半宽（halfWidth）的影响
 */

const PredictionEngine = require('../lib/prediction');
const lineupsSource = require('../lib/lineups-source');
const PredictionService = require('../lib/services/PredictionService');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

function assertNear(actual, expected, epsilon, label) {
  const ok = Math.abs(actual - expected) <= epsilon;
  if (ok) { console.log(`  ✅ ${label} (${actual.toFixed(4)})`); passed++; }
  else { console.error(`  ❌ ${label}: expected ~${expected}, got ${actual}`); failed++; }
}

async function runTests() {
  console.log('=== P3-4: 首发阵容确定性 (lineupUncertainty) 与 CI 联动测试 ===\n');

  const engine = new PredictionEngine();
  const ratings = require('../data/ratings.json').teams;
  const aus = ratings['Australia'];
  const tur = ratings['Türkiye'];
  assert(aus && tur, 'Ratings loaded for test teams');

  // ========== 1. 直接传递 lineupUncertainty 参数验证 ==========
  console.log('\n📊 Test 1: calcConfidenceInterval & engine.predict 直接入参测试');
  const predAnnounced = engine.predict({
    homeId: 'Australia', awayId: 'Türkiye',
    homeRating: aus, awayRating: tur,
    lineupUncertainty: 0,
    xgMatchesPlayed: 6, // 充足样本量下不上限溢出(0.18)
  });
  const predUnannounced = engine.predict({
    homeId: 'Australia', awayId: 'Türkiye',
    homeRating: aus, awayRating: tur,
    lineupUncertainty: 1,
    xgMatchesPlayed: 6,
  });

  assert(predAnnounced.confidence.halfWidth < predUnannounced.confidence.halfWidth,
    `首发已公布 CI 半宽 (${predAnnounced.confidence.halfWidth}) 小于首发未公布 (${predUnannounced.confidence.halfWidth})`);
  assertNear(predUnannounced.confidence.halfWidth - predAnnounced.confidence.halfWidth, 0.05, 0.001,
    '首发未公布与已公布的 CI 半宽差异恰好为 +0.05');

  // ========== 2. engine.predict({ matchId }) 自动读取 lineups-source 联动 ==========
  console.log('\n📊 Test 2: engine.predict 传入 matchId 自动联动 lineups-source 验证');
  // 查证场次 400021440 拥有真实首发阵容
  const lineups440 = lineupsSource.getLineups('400021440');
  assert(lineups440 && lineups440.homeXI !== null && lineups440.awayXI !== null, '场次 400021440 在 lineups-source 中有已公布的首发阵容');

  // 查证场次 400021529 为未公布首发阵容
  const lineups529 = lineupsSource.getLineups('400021529');
  assert(!lineups529 || lineups529.homeXI === null || lineups529.awayXI === null, '场次 400021529 在 lineups-source 中首发阵容未公布 (null)');

  const predMatchAnnounced = engine.predict({
    matchId: '400021440',
    homeId: 'Australia', awayId: 'Türkiye',
    homeRating: aus, awayRating: tur,
    xgMatchesPlayed: 6,
  });
  const predMatchUnannounced = engine.predict({
    matchId: '400021529',
    homeId: 'Australia', awayId: 'Türkiye',
    homeRating: aus, awayRating: tur,
    xgMatchesPlayed: 6,
  });

  assert(predMatchAnnounced.confidence.halfWidth < predMatchUnannounced.confidence.halfWidth,
    `已公布首发场次 CI 半宽 (${predMatchAnnounced.confidence.halfWidth}) 显著小于未公布首发场次 (${predMatchUnannounced.confidence.halfWidth})`);
  assertNear(predMatchUnannounced.confidence.halfWidth - predMatchAnnounced.confidence.halfWidth, 0.05, 0.01,
    '真实比赛 matchId 自动识别后半宽显著差异 (符合规则 +0.05，伴有场地因子微调)');

  // ========== 3. PredictionService.predictMatch 服务层链路验证 ==========
  console.log('\n📊 Test 3: PredictionService.predictMatch 链路联动验证');
  const mockDeps = {
    getCached: () => null,
    setCache: () => {},
    espn: async (endpoint) => {
      if (endpoint.includes('400021440')) {
        return {
          header: {
            date: '2026-06-21T18:00:00Z',
            competitions: [{
              id: '400021440',
              competitors: [
                { homeAway: 'home', team: { id: 'Australia', displayName: 'Australia' } },
                { homeAway: 'away', team: { id: 'Türkiye', displayName: 'Turkey' } }
              ]
            }]
          }
        };
      }
      return {
        header: {
          date: '2026-06-21T18:00:00Z',
          competitions: [{
            id: '400021529',
            competitors: [
              { homeAway: 'home', team: { id: 'Australia', displayName: 'Australia' } },
              { homeAway: 'away', team: { id: 'Türkiye', displayName: 'Turkey' } }
            ]
          }]
        }
      };
    },
    getTeamNameZh: (id) => id,
    getTeamNameI18n: (id, fallback) => ({ zh: id, en: fallback || id }),
    TEAM_FLAGS: { Australia: '🇦🇺', Türkiye: '🇹🇷' },
    RATINGS: { teams: ratings },
    routes: {
      'GET /api/odds/:matchId': async () => null,
      'GET /api/match/:id/news': async () => ({ news: [] })
    }
  };

  const mockDb = {
    prepare: () => ({
      get: () => undefined,
      run: () => {},
      all: () => []
    }),
    transaction: (fn) => fn
  };

  const ps = new PredictionService({ db: mockDb, ...mockDeps });
  const serviceResAnnounced = await ps.predictMatch('400021440', { persist: false, bypassCache: true });
  const serviceResUnannounced = await ps.predictMatch('400021529', { persist: false, bypassCache: true });

  assert(serviceResAnnounced.confidence.halfWidth < serviceResUnannounced.confidence.halfWidth,
    `PredictionService 链路返回: 首发已出 CI (${serviceResAnnounced.confidence.halfWidth}) 较未出首发 (${serviceResUnannounced.confidence.halfWidth}) 更窄`);

  console.log(`\n============================`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('============================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test failed with exception:', err);
  process.exit(1);
});
