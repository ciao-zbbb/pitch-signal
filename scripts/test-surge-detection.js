'use strict';

/**
 * sustained_pressure_alert 检测（缺陷修复）回归测试
 *
 * 背景：原 detectSurge 用"从最新快照往回数、遇第一个 < 阈值就 break"的严格连续计数，
 * 而压力指数本身是逐分钟 delta，单个低谷即打断连续计数，导致真实存在的 3 分钟猛攻
 * 只要中间夹一次抖动就永远不报警（系统性漏报）。同时原逻辑未检查"期间未进球"，可能误报。
 *
 * 本测试验证：
 *   1. 中间夹一次低谷的真实猛攻（4 快照中 3 个 ≥65）应触发
 *   2. 真实连续 3 分钟高压触发
 *   3. 不足 3 个高 PI 快照不触发
 *   4. 窗口内该队已进球则不触发（期间未进球）
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = '1';
const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'test_surge_detection.db');
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
process.env.TEST_DB_PATH = TEST_DB_PATH;

const { db } = require('../lib/db');
const { detectSurge } = require('../lib/services/pressure-index');

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

const MATCH = 'surge-test-match';

function clear() {
  db.prepare('DELETE FROM match_live_stats WHERE match_id = ?').run(MATCH);
  db.prepare('DELETE FROM match_moments WHERE match_id = ?').run(MATCH);
}

function insertSnapshot(minute, ph, pa) {
  db.prepare(`
    INSERT OR REPLACE INTO match_live_stats
      (match_id, minute, pressure_home, pressure_away, pressure_dominant, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(MATCH, minute, ph, pa, ph >= pa ? 'home' : 'away', new Date().toISOString());
}

function insertGoal(minute, teamId) {
  db.prepare(`
    INSERT INTO match_moments
      (match_id, type, minute, minute_added, team_id, importance, source, detected_at)
    VALUES (?, 'goal', ?, 0, ?, 80, 'espn', ?)
  `).run(MATCH, minute, teamId, new Date().toISOString());
}

console.log('=== sustained_pressure_alert 检测（修复漏报）测试 ===\n');

test('1. 中间夹一次低谷的真实猛攻应被识别（修复前会漏报）', () => {
  clear();
  // home 在 70~73 持续高压，但 71 分钟 PI 抖动跌破阈值
  insertSnapshot(70, 66, 40);
  insertSnapshot(71, 64, 40); // 抖动低谷
  insertSnapshot(72, 67, 40);
  insertSnapshot(73, 68, 40); // 当前分钟触发检测
  const r = detectSurge(MATCH, 'home', 73);
  assert.strictEqual(r.surge, true, '4 快照中 3 个 ≥65 应触发');
  assert.strictEqual(r.suppressedByGoal, false);
  assert.strictEqual(r.highCount, 3);
});

test('2. 真实连续 3 分钟高压触发', () => {
  clear();
  insertSnapshot(80, 70, 30);
  insertSnapshot(81, 72, 30);
  insertSnapshot(82, 74, 30);
  const r = detectSurge(MATCH, 'home', 82);
  assert.strictEqual(r.surge, true);
});

test('3. 不足 3 个高 PI 快照不触发', () => {
  clear();
  insertSnapshot(90, 66, 30);
  insertSnapshot(91, 40, 30);
  const r = detectSurge(MATCH, 'home', 91);
  assert.strictEqual(r.surge, false);
});

test('4. 窗口内该队已进球则不触发（期间未进球）', () => {
  clear();
  insertSnapshot(100, 70, 30);
  insertSnapshot(101, 72, 30);
  insertSnapshot(102, 74, 30);
  insertGoal(101, 'HOME_TEAM_ID'); // 该队（home）在第 101 分钟进球
  const r = detectSurge(MATCH, 'home', 102, { matchState: { homeTeamId: 'HOME_TEAM_ID', awayTeamId: 'AWAY_TEAM_ID' } });
  assert.strictEqual(r.surge, false, '窗口内该队进球应否决');
  assert.strictEqual(r.suppressedByGoal, true);
});

test('5. 窗口内对方进球（该队未进球）仍触发', () => {
  clear();
  insertSnapshot(110, 70, 30);
  insertSnapshot(111, 72, 30);
  insertSnapshot(112, 74, 30);
  insertGoal(111, 'AWAY_TEAM_ID'); // 对方进球，home 仍 trailing 且未进球
  const r = detectSurge(MATCH, 'home', 112, { matchState: { homeTeamId: 'HOME_TEAM_ID', awayTeamId: 'AWAY_TEAM_ID' } });
  assert.strictEqual(r.surge, true, '对方进球不影响该队"未进球"判定');
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
process.exit(failed > 0 ? 1 : 0);
