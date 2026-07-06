#!/usr/bin/env node
'use strict';

/**
 * 统一测试运行器 — PitchSignal Test Suite
 *
 * 用法:
 *   node scripts/test-runner.js                    # 运行所有
 *   node scripts/test-runner.js --match "Elo"      # 匹配过滤
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'scripts');

// 所有测试文件（字母序，含核心+边界）
const TEST_FILES = [
  'test-backtest-sort.js',
  'test-bracket-updater.js',
  'test-corner-backtest.js',
  'test-data-resolver.js',
  'test-diagnostic-scripts.js',
  'test-elo.js',
  'test-elo-guided-base-lambda.js',
  'test-eventFilter.js',
  'test-fifa-resilience.js',
  'test-final-round-context.js',
  'test-fuzzy-match.js',
  'test-health-enhance.js',
  'test-import-market-values.js',
  'test-live-state-machine.js',
  'test-logger-trycatch.js',
  'test-matchup-spatial.js',
  'test-output-rules.js',
  'test-parse-event-stage.js',
  'test-poisson.js',
  'test-post-match-review.js',
  'test-pre-match-snapshot-guard.js',
  'test-prediction.js',
  'test-roster-cache.js',
  'test-same-day-leakage.js',
  'test-score-writeback.js',
  'test-security.js',
  'test-services.js',
  'test-substitution-impact.js',
  'test-tactical-board.js',
  'test-team-resolver.js',
  'test-temp-units.js',
  'test-third-place.js',
  'test-tournament-stats-sync.js',
  'test-venue-factor.js',
  'test-venueFactors.js',
  // P2 专项测试
  'test-bot-kb.js',
  'test-calibration-report.js',
  'test-odds-divergence.js',
  'test-pwa-push.js',
  'test-user-predictions.js',
  'test-teamcontext-news.js',
  // P4 专项测试
  'test-continental-strength-signal.js',
  'test-market-value-signal.js',
  'test-prediction-market-ui.js',
  'test-shin-devig.js',
];

const filter = process.argv.includes('--match')
  ? process.argv[process.argv.indexOf('--match') + 1]
  : null;

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const failures = [];
let totalAssertions = 0;
let totalFailedAssertions = 0;

console.log('=== PitchSignal Test Suite ===\n');

for (const file of TEST_FILES) {
  if (filter && !file.toLowerCase().includes(filter.toLowerCase())) continue;

  const filePath = path.join(TEST_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  ${file} — file not found, skipping`);
    continue;
  }

  process.stdout.write(`📋 ${file} ... `);
  try {
    const env = {
      ...process.env,
      TEST_MODE: '1',
      TEST_DB_PATH: path.join(ROOT, 'data', 'test.db'),
      NODE_ENV: 'test',
    };
    const output = execSync(`node "${filePath}"`, {
      cwd: ROOT,
      env,
      stdio: 'pipe',
      timeout: 60000,
    }).toString();

    // Parse assertion counts from output (lines containing "passed" and "failed")
    const passMatch = output.match(/(\d+)\s+passed/);
    const failMatch = output.match(/(\d+)\s+failed/);
    if (passMatch) totalAssertions += parseInt(passMatch[1]);
    if (failMatch) totalFailedAssertions += parseInt(failMatch[1]);

    if (output.includes('⚠️  SKIP:') || output.includes('⚠️ SKIP:')) {
      console.log('⚠️  SKIP');
      totalSkipped++;
    } else {
      console.log('✅ PASS');
      totalPassed++;
    }
  } catch (e) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';

    // Try to extract assertion counts from partial output
    const passMatch = stdout.match(/(\d+)\s+passed/);
    const failMatch = stdout.match(/(\d+)\s+failed/);
    if (passMatch) totalAssertions += parseInt(passMatch[1]);
    if (failMatch) totalFailedAssertions += parseInt(failMatch[1]);

    console.log('❌ FAIL');
    totalFailed++;
    failures.push({ file, output: (stdout + '\n' + stderr).slice(-600) });
  }
}

// Summary
const totalSuites = totalPassed + totalFailed + totalSkipped;
console.log('\n============================');
console.log(`Suites:  ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped, ${totalSuites} total`);
console.log(`Asserts: ${totalAssertions} passed, ${totalFailedAssertions} failed`);
console.log('============================');

if (failures.length > 0) {
  console.log('\n--- Failure Details ---');
  for (const f of failures) {
    console.log(`\n❌ ${f.file}:`);
    console.log(f.output.slice(0, 400));
  }
  process.exit(1);
}

process.exit(0);
