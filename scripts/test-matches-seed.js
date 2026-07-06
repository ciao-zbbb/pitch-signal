'use strict';

/**
 * matches 表播种（缺陷修复）回归测试
 *
 * 背景：seedRealGroups 虽定义却从未被调用，导致生产 matches 表为空，
 * 使 P0-3 终场比分回写 / P4-4 校准报告 / P3-1 Track-B 静默失效。
 * 本测试验证：
 *   1. 首次播种填充 groups(12) + matches(72)
 *   2. 重复调用幂等（不重复插入）
 *   3. sync_completed_matches 的 findMatch 能命中已播种对阵
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = '1';
const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'test_matches_seed.db');
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
process.env.TEST_DB_PATH = TEST_DB_PATH;

const { db, groups } = require('../lib/db');

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

console.log('=== matches 表播种（P0-3 / P3-1 / P4-4 依赖）测试 ===\n');

test('1. 首次播种填充 matches / groups 表', () => {
  const seeded = groups.seedRealGroups();
  assert.ok(seeded > 0, '应返回播种的组数');
  const matchCount = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
  assert.strictEqual(matchCount, 72, '应为 12 组 × 6 场 = 72 场');
  const groupCount = db.prepare('SELECT COUNT(*) AS c FROM groups').get().c;
  assert.strictEqual(groupCount, 12, '应为 12 个小组');
  const standingCount = db.prepare('SELECT COUNT(*) AS c FROM group_standings').get().c;
  assert.strictEqual(standingCount, 48, '应为 12 组 × 4 队 = 48 条积分记录');
});

test('2. 重复调用幂等：不重复插入', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
  const seededAgain = groups.seedRealGroups();
  assert.strictEqual(seededAgain, 0, '已播种应返回 0');
  const after = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
  assert.strictEqual(after, before, 'matches 行数不应变化');
});

test('3. sync 的 findMatch 能命中已播种对阵（修复前为空表会 matched:0）', () => {
  const row = db.prepare(`
    SELECT id FROM matches
    WHERE (home_team_id = ? AND away_team_id = ?)
       OR (home_team_id = ? AND away_team_id = ?)
    LIMIT 1
  `).get('Mexico', 'South Korea', 'South Korea', 'Mexico');
  assert.ok(row, '应能找到 A 组 Mexico vs South Korea');
});

test('4. INSERT OR IGNORE + 唯一索引防止重复对阵', () => {
  // 取已播种的 Mexico vs South Korea 的真实 (group, match_number)
  const seeded = db.prepare(`
    SELECT group_id, match_number FROM matches
    WHERE home_team_id = 'Mexico' AND away_team_id = 'South Korea'
    LIMIT 1
  `).get();
  assert.ok(seeded, '应存在 Mexico vs South Korea 的已播种对阵');
  // 用完全一致的 (group_id, match_number, 主客) 再次插入，应被唯一索引忽略
  db.prepare(`
    INSERT OR IGNORE INTO matches (group_id, match_number, home_team_id, away_team_id)
    VALUES (?, ?, 'Mexico', 'South Korea')
  `).run(seeded.group_id, seeded.match_number);
  const dup = db.prepare(`
    SELECT COUNT(*) AS c FROM matches
    WHERE home_team_id = 'Mexico' AND away_team_id = 'South Korea' AND match_number = ?
  `).get(seeded.match_number).c;
  assert.strictEqual(dup, 1, '同一对阵 + match_number 只能有 1 行');
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
process.exit(failed > 0 ? 1 : 0);
