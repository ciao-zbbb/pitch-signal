'use strict';

/**
 * 淘汰赛比分回写 (Knockout Upsert) 测试套件
 *
 * 背景：writebackMatchScore() 原是纯 UPDATE 语义，查不到 matches 行就返回
 * match_not_found，导致小组赛之外的所有终场比分（整个淘汰赛阶段）静默回写失败。
 * 本套件验证修复后的自愈式 upsert 行为：
 *   1. 两支球队在 matches 表从未出现 → 成功插入新行、比分/played=1 正确、group_id=NULL
 *   2. 幂等：同一淘汰赛重复回写不重复插入（走已有行的幂等保护）
 *   3. 防覆盖：重复回写不同比分被拒绝且不覆盖已确立比分
 *   4. group_id=NULL 在 foreign_keys=ON 下不被 FK 拒绝；多行 NULL 不违反 (group_id, match_number) 唯一索引
 *   5. stage 兜底：未透传 stage 时落 'Knockout'，不留空
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = '1';
const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'test_knockout_writeback.db');
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
process.env.TEST_DB_PATH = TEST_DB_PATH;

const { db } = require('../lib/db');
const { writebackMatchScore, resolveTeamToRatingsId } = require('../lib/services/score-writeback');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

console.log('=== Knockout Score Writeback (upsert) Tests ===\n');

// 镜像 fix/matches-seed-surge (#7) 新增的唯一索引，验证淘汰赛 group_id=NULL 多行插入不会与之冲突。
// 若该索引已随 #7 合入 db.js，则此处 CREATE IF NOT EXISTS 为 no-op。
db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_group_num ON matches(group_id, match_number)').run();

// 清空 matches，保证干净基线（避免任何自动播种的 72 场小组赛干扰 upsert 分支）
db.prepare('DELETE FROM matches').run();

function resolveOrFail(name) {
  const id = resolveTeamToRatingsId(name);
  assert.ok(id, `resolveTeamToRatingsId(${name}) 应解析出合法 ratings_id`);
  return id;
}

test('1. 淘汰赛终场比分自愈式 upsert 插入新行', () => {
  const h = resolveOrFail('Germany');
  const a = resolveOrFail('Portugal');
  const res = writebackMatchScore({
    homeTeam: 'Germany',
    awayTeam: 'Portugal',
    homeScore: 2,
    awayScore: 1,
    statusName: 'STATUS_FINAL',
    stage: 'R32',
    source: 'fifa',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.updated, true);
  assert.strictEqual(res.inserted, true);
  assert.strictEqual(res.reason, 'upserted_new_match');

  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(res.matchId);
  assert.strictEqual(row.home_team_id, h);
  assert.strictEqual(row.away_team_id, a);
  assert.strictEqual(row.home_score, 2);
  assert.strictEqual(row.away_score, 1);
  assert.strictEqual(row.played, 1);
  assert.strictEqual(row.group_id, null);
  assert.strictEqual(row.stage, 'R32');

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE home_team_id = ? AND away_team_id = ?').get(h, a).c;
  assert.strictEqual(cnt, 1, '该对阵只能有 1 行');
});

test('2. 幂等：同一淘汰赛重复回写不重复插入', () => {
  const h = resolveOrFail('Germany');
  const a = resolveOrFail('Portugal');
  const res = writebackMatchScore({
    homeTeam: 'Germany',
    awayTeam: 'Portugal',
    homeScore: 2,
    awayScore: 1,
    statusName: 'STATUS_FULL_TIME',
    stage: 'R32',
    source: 'espn',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.updated, false);
  assert.strictEqual(res.reason, 'already_written');

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE home_team_id = ? AND away_team_id = ?').get(h, a).c;
  assert.strictEqual(cnt, 1, '重复回写不应产生第 2 行');
});

test('3. 防覆盖：重复回写不同比分被拒绝且不覆盖', () => {
  const h = resolveOrFail('Germany');
  const a = resolveOrFail('Portugal');
  const res = writebackMatchScore({
    homeTeam: 'Germany',
    awayTeam: 'Portugal',
    homeScore: 3,
    awayScore: 2,
    statusName: 'STATUS_FINAL',
    stage: 'R32',
    source: 'espn_glitch',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.updated, false);
  assert.strictEqual(res.reason, 'idempotent_protected');

  const row = db.prepare('SELECT * FROM matches WHERE home_team_id = ? AND away_team_id = ?').get(h, a);
  assert.strictEqual(row.home_score, 2);
  assert.strictEqual(row.away_score, 1);
  assert.strictEqual(row.played, 1);
});

test('4. group_id=NULL 豁免 FK 约束 + 多行 NULL 不违反唯一索引', () => {
  const h1 = resolveOrFail('England');
  const a1 = resolveOrFail('Netherlands');
  const r1 = writebackMatchScore({
    homeTeam: 'England',
    awayTeam: 'Netherlands',
    homeScore: 1,
    awayScore: 0,
    statusName: 'STATUS_FINAL',
    stage: 'QF',
    source: 'fifa',
  });
  assert.strictEqual(r1.inserted, true, '第二组淘汰赛插入应成功（FK 对 NULL 豁免）');

  const h2 = resolveOrFail('Croatia');
  const a2 = resolveOrFail('Denmark');
  const r2 = writebackMatchScore({
    homeTeam: 'Croatia',
    awayTeam: 'Denmark',
    homeScore: 2,
    awayScore: 2,
    statusName: 'STATUS_FINAL',
    stage: 'SF',
    source: 'fifa',
  });
  assert.strictEqual(r2.inserted, true, '第三组淘汰赛插入应成功');

  const nullCnt = db.prepare('SELECT COUNT(*) AS c FROM matches WHERE group_id IS NULL').get().c;
  assert.strictEqual(nullCnt, 3, '3 行 group_id=NULL 共存，唯一索引对 NULL 互相不冲突');
});

test('5. stage 兜底：未透传 stage 时落 Knockout', () => {
  const h = resolveOrFail('Brazil');
  const a = resolveOrFail('France');
  const res = writebackMatchScore({
    homeTeam: 'Brazil',
    awayTeam: 'France',
    homeScore: 4,
    awayScore: 3,
    statusName: 'STATUS_FINAL',
    source: 'fifa',
  });

  assert.strictEqual(res.inserted, true);
  assert.strictEqual(res.stage, 'Knockout', '未透传 stage 应兜底为 Knockout');

  const row = db.prepare('SELECT stage FROM matches WHERE id = ?').get(res.matchId);
  assert.strictEqual(row.stage, 'Knockout');
});

// 清理临时测试库
db.close();
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

console.log(`\n============================`);
console.log(`Test Summary: ${passed} passed, ${failed} failed`);
console.log(`============================\n`);

if (failed > 0) {
  process.exit(1);
}
