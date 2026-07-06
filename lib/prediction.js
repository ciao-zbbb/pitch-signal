/**
 * 预测融合引擎 v4 - 特征归一化 + 置信度动态权重
 * 
 * 改进点：
 * 1. Min-Max 归一化：每个信号输出统一到 [0,1]
 * 2. 置信度加权：每个信号有 confidence 分数，权重 *= confidence
 * 3. 动态权重：根据信号质量自动调整
 * 4. Dixon-Coles τ 修正：平局概率修正
 */
const EloRating = require('./elo');
const PoissonModel = require('./poisson');
const fs = require('fs');
const path = require('path');

class PredictionEngine {
  constructor(options = {}) {
    this.elo = new EloRating(options.elo || {});
    this.poisson = new PoissonModel(options.poisson || {});
    this.eloGuidedBaseLambda = options.eloGuidedBaseLambda ?? 1.5;

    // 基础权重（会被置信度动态调整）
    this.baseWeights = Object.assign({
      elo: 0.30,
      poisson: 0.25,
      coach: 0.15,
      venue: 0.10,
      odds: 0.20,
      marketValue: 0.10,
      continentalStrength: 0.04,
    }, options.weights);

    // 加载教练数据
    try {
      this.coaches = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'coaches.json'), 'utf8'));
    } catch (e) {
      this.coaches = {};
    }
  }

  /**
   * Min-Max 归一化：将概率三元组归一化到 [0,1] 且和为 1
   * @param {number} home - 主队胜率
   * @param {number} draw - 平局概率
   * @param {number} away - 客队胜率
   * @returns {{ home, draw, away }} 归一化后的概率
   */
  normalizeProbs(home, draw, away) {
    const total = home + draw + away;
    if (total <= 0) return { home: 0.33, draw: 0.34, away: 0.33 };
    return {
      home: Math.round((home / total) * 1000) / 1000,
      draw: Math.round((draw / total) * 1000) / 1000,
      away: Math.round((away / total) * 1000) / 1000,
    };
  }

  /**
   * Elo 引导 λ
   */
  eloGuidedLambda(eloWinProb, rawLambda, eloRating, oppRating) {
    const ratingDiff = eloRating - oppRating;
    const baseLambda = this.eloGuidedBaseLambda;
    const eloLambda = baseLambda + (ratingDiff / 100) * 0.4;
    // Blend 80% raw Poisson (which contains knockout shrinkage logic) with 20% Elo expectation
    const blended = rawLambda * 0.8 + eloLambda * 0.2;
    return Math.max(0.2, Math.min(4.0, blended));
  }

  /**
   * Async wrapper to fetch live Polymarket data and inject it into the prediction flow.
   *
   * ⚠️ POLYMARKET 闸门(默认关闭)
   * 当前 polymarketClient.js 用队名哈希生成假赔率(_mockFetchMarket)。
   * 实测:打开闸门时 backtest Brier 从 0.5519 砸到 0.6726、准确率从 59% 砸到 46%——
   * 假数据在主动让模型变差。Phase 3 接真实 gamma-api 数据后再把 POLYMARKET_ENABLED=true。
   * 闸门关闭时本方法等同于 predict(),引擎落回诚实基线。
   */
  async predictWithMarket(params) {
    // POLYMARKET 闸门(在受控公开 Beta 中强行关闭)
    const POLYMARKET_ENABLED = false;
    if (!POLYMARKET_ENABLED) {
      return this.predict(params);
    }
    if (!this.polymarket) {
      const PolymarketClient = require('./polymarketClient');
      this.polymarket = new PolymarketClient();
    }

    const marketData = await this.polymarket.fetchMatchMarkets(params.homeId, params.awayId);
    if (marketData) {
      const implied = this.polymarket.extractImpliedProbabilities(marketData);
      if (implied) {
        params.polymarketOdds = {
          ...implied,
          liquidity: this.polymarket.assessLiquidity(marketData.volumeUsd)
        };
      }
    }

    return this.predict(params);
  }

  /**
   * AI 大脑注入(Shadow 模式) — predictWithMarket 之上的薄包装。
   *
   * 设计原则:
   *   - 不修改最终概率(纯加法 result.aiContext);compareBaseline 仍恒等通过。
   *   - "已发送的影响":合并 crossMatchEffect(同组+全局教训) +
   *     teamContext.getContext(双方各自最近 5 场教训) → result.aiContext。
   *   - Phase 2(激活)再启用:把 result.aiContext 喂给 Claude 产出"有界 ±5%
   *     调整 + 自然语言归因",并写入 components.ai。当前阶段仅 assemble + 落快照,
   *     不消耗 LLM token,不改概率。
   *
   * @param {object} params - 同 predictWithMarket;额外可传 groupName(用于跨场次效应)
   * @returns {Promise<object>} 与 predict() 同形,额外含 aiContext 字段
   */
  async predictWithAI(params) {
    const result = await this.predictWithMarket(params);

    const crossMatchEffect = require('./crossMatchEffect');
    const teamContext = require('./teamContext');

    const groupName = params.groupName || null;
    let crossMatchPrompt = null;
    if (groupName) {
      try {
        crossMatchPrompt = crossMatchEffect.compileCrossMatchPrompt(
          params.homeId,
          params.awayId,
          groupName
        );
      } catch (e) {
        crossMatchPrompt = `(cross-match analysis failed: ${e.message})`;
      }
    }

    let homeContext = null;
    let awayContext = null;
    try {
      // P2-5: 预热新闻缓存——先拉取新闻注入 teamContext,再 getContext 取用它。
      // newsCache TTL=30min,重复调用同一 match_id 不会重复拉取(被缓存拦截)。
      const newsOpts = { lang: params.lang || 'en', maxItems: 8 };
      await Promise.all([
        teamContext.requestTeamNews(params.homeId, newsOpts),
        teamContext.requestTeamNews(params.awayId, newsOpts),
      ]);
      [homeContext, awayContext] = await Promise.all([
        teamContext.getContext(params.homeId),
        teamContext.getContext(params.awayId),
      ]);
    } catch (e) {
      // teamContext 失败不该影响预测;记录降级信号
      homeContext = { error: e.message };
      awayContext = { error: e.message };
    }

    result.aiContext = {
      shadowMode: true,         // 当前仅采集,不影响概率
      applied: false,           // 一旦 Claude 产出 ±5% 调整,这里置 true
      groupName,
      crossMatchPrompt,
      homeContext,
      awayContext,
      // 未来字段:claudeAdjustment, claudeRationale(由 Phase 2 注入)
    };
    return result;
  }

  /**
   * 综合预测（v4 特征归一化版本）
   */
  predict(params) {
    const { homeId, awayId, homeEspnId, awayEspnId, homeRating, awayRating, odds, venue, marketValueSignal, continentalStrengthSignal } = params;

    // ============================================
    // 1. 各信号独立计算 + 置信度
    // ============================================

    // --- Elo 信号 ---
    const eloPred = this.elo.predictMatch(
      homeRating?.rating || 1500,
      awayRating?.rating || 1500
    );
    const eloConfidence = this.calcEloConfidence(
      homeRating?.rating || 1500,
      awayRating?.rating || 1500
    );
    const eloNorm = this.normalizeProbs(eloPred.homeWin, eloPred.draw, eloPred.awayWin);

    // --- Poisson 信号 ---
    const homeRawLambda = this.poisson.calculateLambda(
      homeRating?.attack_strength || 1.0,
      awayRating?.defense_strength || 1.0,
      true,
      { isKnockout: params.isKnockout, knockoutRound: params.knockoutRound, opponentIsEliteDefense: awayRating?.isEliteDefense }
    );
    const awayRawLambda = this.poisson.calculateLambda(
      awayRating?.attack_strength || 1.0,
      homeRating?.defense_strength || 1.0,
      false,
      { isKnockout: params.isKnockout, knockoutRound: params.knockoutRound, opponentIsEliteDefense: homeRating?.isEliteDefense }
    );
    const homeLambda = this.eloGuidedLambda(eloPred.homeWin, homeRawLambda, homeRating?.rating || 1500, awayRating?.rating || 1500);
    const awayLambda = this.eloGuidedLambda(eloPred.awayWin, awayRawLambda, awayRating?.rating || 1500, homeRating?.rating || 1500);

    // --- 环境因子（海拔/高温衰减）：λ' = λ · β_alt · β_temp ---
    // 数据缺失时 β=1，等价于不改动 λ，落回原基线（Est.）。
    // params.matchId 缺失（如 test-prediction.js 直调）时同样回退，不影响既有行为。
    let envFactor = null;
    let homeEnvBeta = 1, awayEnvBeta = 1;
    if (params.matchId) {
      try {
        const venueFactors = require('./venueFactors');
        envFactor = venueFactors.computeForMatch(params.matchId, params.homeId, params.awayId);
        homeEnvBeta = envFactor.home.beta;
        awayEnvBeta = envFactor.away.beta;
      } catch (e) {
        envFactor = { error: e.message };
      }
    }
    const homeLambdaAdj = homeLambda * homeEnvBeta;
    const awayLambdaAdj = awayLambda * awayEnvBeta;

    // --- 首发阵容确定性（P3-4） ---
    // PredictionService 已经算好 lineupUncertainty 并显式传入；这里只是给绕过
    // PredictionService、直接调用 engine.predict()/predictWithMarket() 的调用方
    // （测试脚本、离线工具等）兜底，避免它们悄悄退回"永远当作已确认"的假象。
    let lineupUncertainty = params.lineupUncertainty;
    if (lineupUncertainty == null && params.matchId) {
      try {
        const lineupsSource = require('./lineups-source');
        const lineupsData = lineupsSource.getLineups(params.matchId);
        if (lineupsData && lineupsData.homeXI !== null && lineupsData.awayXI !== null && lineupsData.homeXI.length > 0 && lineupsData.awayXI.length > 0) {
          lineupUncertainty = 0;
        } else {
          lineupUncertainty = 1;
        }
      } catch (e) {
        // 查询失败时按"未确认"处理（宽 CI），与 PredictionService.js 的兜底方向一致——
        // 出错时宁可让置信区间偏宽，也不要假装首发已确认从而误导用户。
        lineupUncertainty = 1;
      }
    }

    const poissonPred = this.poisson.predictMatchWithLambda(homeLambdaAdj, awayLambdaAdj);
    
    // Poisson 置信度：基于 λ 区分度 + Dixon-Coles 修正
    const poissonValid = Math.abs(poissonPred.homeWinProb - poissonPred.awayWinProb) > 0.05;
    const poissonConfidence = poissonValid ? 0.85 : 0.40;
    const poissonNorm = this.normalizeProbs(poissonPred.homeWinProb, poissonPred.drawProb, poissonPred.awayWinProb);

    // --- 教练信号 ---
    // coaches.json is keyed by ESPN ID; homeId/awayId are ratings_ids.
    // Fall back to ratings_id so the lookup degrades gracefully when ESPN ID is absent.
    const coachFactor = this.calcCoachFactor(homeEspnId || homeId, awayEspnId || awayId);
    const coachConfidence = this.calcCoachConfidence(homeEspnId || homeId, awayEspnId || awayId);
    const coachNorm = this.normalizeProbs(coachFactor.homeAdjust, 0.34, coachFactor.awayAdjust);

    // --- 场馆信号 ---
    const venueFactor = venue ? this.calcVenueFactor(venue) : { homeAdvantage: 1.0 };
    const venueConfidence = venue ? 0.60 : 0.0;
    // 场馆只影响主队胜率，平局和客队按比例分配
    const venueHomeBoost = (venueFactor.homeAdvantage - 1) * 5; // 0~0.25
    const venueNorm = this.normalizeProbs(0.45 + venueHomeBoost, 0.28, 0.27 - venueHomeBoost);

    // --- 盘口信号 ---
    // 过滤掉估算的 mock 赔率，以防 ratings 自循环融合
    const isMockOdds = odds && odds.source === 'estimated';
    const oddsFactor = (odds && !isMockOdds) ? this.calcOddsFactor(odds) : null;
    const oddsConfidence = oddsFactor ? this.calcOddsConfidence(odds) : 0;
    const oddsNorm = oddsFactor
      ? this.normalizeProbs(oddsFactor.homeWinProb, oddsFactor.drawProb, oddsFactor.awayWinProb)
      : { home: 0.33, draw: 0.34, away: 0.33 };

    // --- 阵容身价信号（P4-2） ---
    // 默认不传 marketValueSignal，因此生产概率不变。只有数据源 + 显式闸门
    // 都开启时，PredictionService 才会注入该信号。
    const marketValueNorm = marketValueSignal
      ? this.normalizeProbs(marketValueSignal.home, marketValueSignal.draw, marketValueSignal.away)
      : { home: 0.33, draw: 0.34, away: 0.33 };
    const marketValueConfidence = marketValueSignal ? marketValueSignal.confidence || 0.55 : 0;

    // --- 洲际强度头（P4-3） ---
    // 仅在服务层 env gate 或 compareBaseline 候选配置显式注入时生效。
    const continentalStrengthNorm = continentalStrengthSignal
      ? this.normalizeProbs(continentalStrengthSignal.home, continentalStrengthSignal.draw, continentalStrengthSignal.away)
      : { home: 0.33, draw: 0.34, away: 0.33 };
    const continentalStrengthConfidence = continentalStrengthSignal ? continentalStrengthSignal.confidence || 0.55 : 0;

    // ============================================
    // 2. 置信度动态权重
    // ============================================
    const signals = [
      { name: 'elo', norm: eloNorm, confidence: eloConfidence },
      { name: 'poisson', norm: poissonNorm, confidence: poissonConfidence },
      { name: 'coach', norm: coachNorm, confidence: coachConfidence },
      { name: 'venue', norm: venueNorm, confidence: venueConfidence },
      { name: 'odds', norm: oddsNorm, confidence: oddsConfidence },
      { name: 'marketValue', norm: marketValueNorm, confidence: marketValueConfidence },
      { name: 'continentalStrength', norm: continentalStrengthNorm, confidence: continentalStrengthConfidence },
    ];

    // 动态权重 = 基础权重 × 置信度
    const dynamicWeights = {};
    let totalWeight = 0;
    for (const sig of signals) {
      const w = (this.baseWeights[sig.name] || 0) * sig.confidence;
      dynamicWeights[sig.name] = w;
      totalWeight += w;
    }

    // 归一化权重到 [0,1]
    if (totalWeight > 0) {
      for (const k of Object.keys(dynamicWeights)) {
        dynamicWeights[k] = Math.round((dynamicWeights[k] / totalWeight) * 1000) / 1000;
      }
    }

    // ============================================
    // 3. 加权融合
    // ============================================
    let fusedHome = 0, fusedDraw = 0, fusedAway = 0;
    for (const sig of signals) {
      const w = dynamicWeights[sig.name] || 0;
      fusedHome += sig.norm.home * w;
      fusedDraw += sig.norm.draw * w;
      fusedAway += sig.norm.away * w;
    }

    // 基础数学融合
    let fused = this.normalizeProbs(fusedHome, fusedDraw, fusedAway);

    // ============================================
    // 4. Polymarket 贝叶斯融合 (Continuous Sigmoid)
    // ============================================
    // DESIGN FIX: Replaced hard 80/20 threshold switch (which caused prediction
    // jumps at 14.9%→15.1% divergence) with a smooth Sigmoid function.
    // Architecture Review ADR-005: Continuous Bayesian weighting.
    let polymarketApplied = false;
    let conflictResolved = null;
    let originalProb = { home: fused.home, draw: fused.draw, away: fused.away };
    let marketProb = null;

    if (params.polymarketOdds) {
      const pm = params.polymarketOdds;
      const pmNorm = this.normalizeProbs(pm.homeWin, pm.draw, pm.awayWin);
      marketProb = pmNorm;
      
      // Calculate divergence (max diff across outcomes)
      const maxDiff = Math.max(
        Math.abs(fused.home - pmNorm.home),
        Math.abs(fused.draw - pmNorm.draw),
        Math.abs(fused.away - pmNorm.away)
      );

      // Liquidity normalization: 'high' = 1.0, 'medium' = 0.5, 'low' = 0.1
      const liqMap = { high: 1.0, medium: 0.5, low: 0.1 };
      const liqNorm = liqMap[pm.liquidity] || 0.3;

      // Sigmoid continuous weighting:
      // w_market smoothly transitions from baseline (0.30) toward max (0.80)
      // as divergence and liquidity increase.
      // At dev=0, w_market ≈ 0.30 (baseline)
      // At dev=0.15 with high liquidity, w_market ≈ 0.55
      // At dev=0.30 with high liquidity, w_market ≈ 0.75
      const k = 20; // steepness of sigmoid
      const sigmoid = 1 / (1 + Math.exp(-k * (maxDiff - 0.15) * liqNorm));
      const marketWeight = Math.min(0.80, 0.30 + 0.50 * sigmoid);
      const mathWeight = 1.0 - marketWeight;

      if (maxDiff > 0.15 && liqNorm >= 0.5) {
        conflictResolved = 'sigmoid_market_weighted';
      } else if (maxDiff > 0.15 && liqNorm < 0.5) {
        conflictResolved = 'sigmoid_math_weighted_low_liquidity';
      }

      let finalHome = (fused.home * mathWeight) + (pmNorm.home * marketWeight);
      let finalDraw = (fused.draw * mathWeight) + (pmNorm.draw * marketWeight);
      let finalAway = (fused.away * mathWeight) + (pmNorm.away * marketWeight);
      
      fused = this.normalizeProbs(finalHome, finalDraw, finalAway);
      polymarketApplied = true;
    }

    // ============================================
    // Display score: rounded expected goals (期望比分).
    // NOT the Poisson joint mode — that is stored in poissonModeScore.
    // When both λ ∈ [1, 2) the joint mode is always 1-1 regardless of
    // team strength. round(λ) reflects the expected goal difference and
    // thus the predicted winner instead.
    //
    // If round(λ) produces a draw but one team has >60% win probability,
    // nudge the score to preserve the predicted winner.
    // This is a display correction only — it does not modify any probabilities.
    const DOMINANCE_THRESHOLD = 0.60;
    // Align to the same 1-decimal precision used by goals.homeExpected/awayExpected
    // before rounding to integer, so that e.g. rawLambda=1.47 → display=1.5 → round=2
    // instead of rawLambda=1.47 → round=1 (inconsistent with goals display).
    const dispHome = Math.round(homeLambdaAdj * 10) / 10;
    const dispAway = Math.round(awayLambdaAdj * 10) / 10;
    let expHome = Math.round(dispHome);
    let expAway = Math.round(dispAway);

    if (expHome === expAway) {
      if (fused.home > DOMINANCE_THRESHOLD)      expHome = expAway + 1;
      else if (fused.away > DOMINANCE_THRESHOLD) expAway = expHome + 1;
    } else if (fused.home > DOMINANCE_THRESHOLD && expHome < expAway) {
      // Rare: home team heavily favoured but λ is inverted (counter-attack setup)
      expHome = expAway + 1;
    } else if (fused.away > DOMINANCE_THRESHOLD && expAway < expHome) {
      expAway = expHome + 1;
    }

    const expectedScore = `${expHome}-${expAway}`;

    return {
      homeWin: fused.home,
      draw: fused.draw,
      awayWin: fused.away,
      expectedScore,
      poissonModeScore: poissonPred.likelyScore,
      poissonModeProb: Math.round(poissonPred.likelyScoreProb * 1000) / 1000,
      likelyScore: expectedScore,          // backward compat
      likelyScoreProb: Math.round(poissonPred.likelyScoreProb * 1000) / 1000,
      goals: {
        homeExpected: Math.round(homeLambdaAdj * 10) / 10,
        awayExpected: Math.round(awayLambdaAdj * 10) / 10,
      },
      components: {
        elo: { ...eloNorm, confidence: eloConfidence },
        poisson: { ...poissonNorm, homeLambda, awayLambda, homeLambdaAdj, awayLambdaAdj, envApplied: Boolean(envFactor && !envFactor.error && (envFactor.home?.applied || envFactor.away?.applied)), valid: poissonValid, confidence: poissonConfidence, dixonColes: poissonPred.dixonColes },
        coach: { ...coachNorm, confidence: coachConfidence },
        venue: { ...venueNorm, confidence: venueConfidence },
        odds: oddsFactor ? { ...oddsNorm, confidence: oddsConfidence } : null,
        marketValue: marketValueSignal ? { ...marketValueNorm, confidence: marketValueConfidence, meta: marketValueSignal } : null,
        continentalStrength: continentalStrengthSignal ? { ...continentalStrengthNorm, confidence: continentalStrengthConfidence, meta: continentalStrengthSignal } : null,
      },
      // 环境因子（海拔/高温衰减）：λ' = λ · β_alt · β_temp
      // 数据缺失时 β=1、applied=false，等价于不改动 λ（落回 Est. 基线）。
      // CPV 等无 espn_id 的球队：venueFactors 仍经 teams.json 解析，不抛错。
      venueFactor: envFactor && !envFactor.error ? {
        applied: envFactor.home?.applied || envFactor.away?.applied,
        home: envFactor.home,
        away: envFactor.away,
      } : (envFactor?.error ? { applied: false, error: envFactor.error } : { applied: false }),
      weights: dynamicWeights,
      // 中性字段名：公测 Beta 阶段外部市场信号闸门恒为关闭（applied:false）。
      // 不使用 "polymarket" 字样，避免在 API 响应/快照/日志中外泄任何竞品叙事。
      marketSignalFusion: polymarketApplied ? { applied: true, conflictResolved, originalProb, marketProb } : { applied: false },
      _fusion: 'v7_math_purified',
      // 置信区间：反映信号分歧、xG 样本量、阵容不确定性
      confidence: this.calcConfidenceInterval({
        homeWin: fused.home,
        draw:    fused.draw,
        awayWin: fused.away,
        eloNorm,
        poissonNorm,
        xgMatchesPlayed: params.xgMatchesPlayed ?? 0,
        lineupUncertainty: lineupUncertainty ?? 0,
        isKnockout: Boolean(params.isKnockout),
      }),
    };
  }

  /**
   * 置信区间计算
   *
   * 宽度来源：
   *   1. Elo 与 Poisson 的分歧程度（最大影响 ±8%）
   *   2. xG 样本量（WC 本届场次数，0场→最宽，≥5场→收窄）
   *   3. 阵容不确定性 0-1（首发未公布时传 0.5~1.0）
   *   4. 淘汰赛平局概率本身就更宽
   *
   * 输出 [lo, hi] 以点估计为中心，保证 lo ≥ 0、hi ≤ 1。
   * level: 'high' | 'medium' | 'low'
   */
  calcConfidenceInterval({ homeWin, draw, awayWin, eloNorm, poissonNorm, xgMatchesPlayed, lineupUncertainty, isKnockout }) {
    // 信号分歧：Elo vs Poisson 的最大差值
    const divergence = Math.max(
      Math.abs(eloNorm.home - poissonNorm.home),
      Math.abs(eloNorm.draw - poissonNorm.draw),
      Math.abs(eloNorm.away - poissonNorm.away)
    );

    // 样本惩罚：0场=1.0（最宽），3场=0.6，≥6场=0.3
    const samplePenalty = Math.max(0.3, 1.0 - xgMatchesPlayed * 0.12);

    // 基础半宽 = 5%（信号完全一致、样本充足、阵容确定时）
    const baseHalf = 0.05;
    const halfWidth = Math.min(0.18,
      baseHalf
      + divergence * 0.5        // 分歧最多贡献 +10%
      + samplePenalty * 0.06    // 样本不足最多 +6%
      + lineupUncertainty * 0.05 // 阵容不确定 +5%
      + (isKnockout ? 0.02 : 0)  // 淘汰赛额外 +2%
    );

    const clamp = (v) => Math.max(0, Math.min(1, v));
    const r3 = (v) => Math.round(v * 1000) / 1000;

    const level = halfWidth < 0.08 ? 'high' : halfWidth < 0.13 ? 'medium' : 'low';

    return {
      homeWin: [r3(clamp(homeWin - halfWidth)), r3(clamp(homeWin + halfWidth))],
      draw:    [r3(clamp(draw    - halfWidth)), r3(clamp(draw    + halfWidth))],
      awayWin: [r3(clamp(awayWin - halfWidth)), r3(clamp(awayWin + halfWidth))],
      halfWidth: r3(halfWidth),
      level,
    };
  }

  /**
   * Elo 置信度：基于评分差（差越大越确定）
   * ratingDiff 0→confidence 0.5, ratingDiff 300→confidence 0.95
   */
  calcEloConfidence(homeRating, awayRating) {
    const diff = Math.abs(homeRating - awayRating);
    return Math.min(0.95, 0.50 + diff / 600);
  }

  /**
   * 教练置信度：基于数据完整性
   */
  calcCoachConfidence(homeId, awayId) {
    const homeCoach = this.coaches[homeId];
    const awayCoach = this.coaches[awayId];
    let conf = 0.30; // 基线
    if (homeCoach) conf += 0.15;
    if (awayCoach) conf += 0.15;
    // Parse tenure (e.g., "8年" → 8)
    const parseTenure = (coach) => {
      if (!coach?.tenure) return 0;
      const match = coach.tenure.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    };
    if (parseTenure(homeCoach) > 5) conf += 0.10;
    if (parseTenure(awayCoach) > 5) conf += 0.10;
    return Math.min(0.80, conf);
  }

  /**
   * 盘口置信度：基于赔率合理性
   */
  calcOddsConfidence(odds) {
    const homeDec = parseFloat(odds.homeWin);
    const drawDec = parseFloat(odds.draw);
    const awayDec = parseFloat(odds.awayWin);
    if (!homeDec || !drawDec || !awayDec) return 0;
    // overround 在 1.0~1.15 之间为正常
    const overround = (1 / homeDec) + (1 / drawDec) + (1 / awayDec);
    if (overround < 0.9 || overround > 1.3) return 0.30; // 异常赔率
    return 0.85;
  }

  /**
   * 最可能比分
   */
  mostLikelyScore(homeLambda, awayLambda, homeWinProb, drawProb, awayWinProb) {
    const matrix = this.poisson.goalProbabilityMatrix(homeLambda, awayLambda);
    let maxProb = 0, bestScore = '0-0';
    for (let i = 0; i <= 5; i++) {
      for (let j = 0; j <= 5; j++) {
        if (matrix[i][j] > maxProb) {
          maxProb = matrix[i][j];
          bestScore = `${i}-${j}`;
        }
      }
    }
    return { score: bestScore, prob: maxProb };
  }

  /**
   * Parse coach style from Chinese descriptions into numeric signals.
   * Returns { attackBias, defenseBias } where each is 0~1.
   */
  _parseCoachStyle(style) {
    if (!style) return { attackBias: 0, defenseBias: 0 };
    const s = style.toLowerCase();
    let attackBias = 0, defenseBias = 0;
    // Attacking keywords (Chinese)
    if (s.includes('进攻') || s.includes('逼抢') || s.includes('高压') || s.includes('压迫')) attackBias += 0.6;
    if (s.includes('高位') || s.includes('快速') || s.includes('技术流')) attackBias += 0.3;
    if (s.includes('控球')) attackBias += 0.2;
    // Defensive keywords (Chinese)
    if (s.includes('防守') || s.includes('反击')) defenseBias += 0.6;
    if (s.includes('纪律') || s.includes('稳固') || s.includes('身体对抗')) defenseBias += 0.3;
    if (s.includes('保守') || s.includes('实用')) defenseBias += 0.2;
    // Clamp
    attackBias = Math.min(1, attackBias);
    defenseBias = Math.min(1, defenseBias);
    return { attackBias, defenseBias };
  }

  /**
   * Parse tenure string (e.g., "8年") into numeric years.
   */
  _parseTenure(coach) {
    if (!coach?.tenure) return 0;
    const match = coach.tenure.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 教练因素
   */
  calcCoachFactor(homeId, awayId) {
    const homeCoach = this.coaches[homeId];
    const awayCoach = this.coaches[awayId];
    let homeAdjust = 0.5, awayAdjust = 0.5;
    if (homeCoach) {
      const tenure = this._parseTenure(homeCoach);
      homeAdjust = 0.5 + tenure * 0.002;
      const style = this._parseCoachStyle(homeCoach.style);
      homeAdjust += style.attackBias * 0.04 - style.defenseBias * 0.02;
    }
    if (awayCoach) {
      const tenure = this._parseTenure(awayCoach);
      awayAdjust = 0.5 + tenure * 0.002;
      const style = this._parseCoachStyle(awayCoach.style);
      awayAdjust += style.attackBias * 0.02 - style.defenseBias * 0.04;
    }
    const total = homeAdjust + awayAdjust;
    return {
      homeAdjust: Math.round((homeAdjust / total) * 1000) / 1000,
      awayAdjust: Math.round((awayAdjust / total) * 1000) / 1000,
    };
  }

  /**
   * 场馆因素
   */
  calcVenueFactor(venue) {
    if (!venue) return { homeAdvantage: 1.0 };
    const capacityFactor = Math.min(1, (venue.capacity || 50000) / 100000);
    return { homeAdvantage: 1.0 + capacityFactor * 0.05 };
  }

  /**
   * Shin's method 去水（Shin, 1993）
   *
   * 简单比例去水（旧实现）把整个 overround 平均摊给三个结果；Shin's method
   * 把水位更多地压在冷门（长赔）上，更贴近"内幕/知情交易推高热门价格"的
   * 真实成因——学术与业界公认在大冷门常见的场景（世界杯小组赛正是如此）
   * 比简单比例更准。见 docs/prediction-methodology-review.md P4-1。
   *
   * z ∈ [0,1) 是隐含的"知情交易者占比"，三个结果没有解析解，用二分法数值
   * 求解（60 次迭代，双精度下足够收敛，零外部依赖）。
   *
   * @param {number[]} rawProbs - 未去水的隐含概率 1/decimalOdds，和 = overround
   * @returns {number[]} 去水后的真实概率，和为 1
   */
  shinDevig(rawProbs) {
    const B = rawProbs.reduce((s, b) => s + b, 0);
    if (!(B > 1)) return rawProbs.map(b => b / B); // 无水/倒挂：退化为比例去水

    const trueProbsForZ = (z) => rawProbs.map(b =>
      (Math.sqrt(z * z + 4 * (1 - z) * b * b / B) - z) / (2 * (1 - z))
    );
    const sumAt = (z) => trueProbsForZ(z).reduce((s, p) => s + p, 0);

    // sumAt(z) 从 z=0 处的 sqrt(B)(>1) 单调递减；找到 sumAt(hi)<1 的上界后二分
    let lo = 0, hi = 0.2;
    while (sumAt(hi) > 1 && hi < 0.99) hi = Math.min(0.99, hi * 2);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (sumAt(mid) > 1) lo = mid; else hi = mid;
    }
    const probs = trueProbsForZ((lo + hi) / 2);
    // 数值误差兜底：强制归一到 1
    const total = probs.reduce((s, p) => s + p, 0);
    return probs.map(p => p / total);
  }

  /**
   * 盘口因素
   */
  calcOddsFactor(odds) {
    if (!odds) return null;
    const homeDec = parseFloat(odds.homeWin);
    const drawDec = parseFloat(odds.draw);
    const awayDec = parseFloat(odds.awayWin);
    if (!homeDec || !drawDec || !awayDec) return null;
    const [homeWinProb, drawProb, awayWinProb] = this.shinDevig([1 / homeDec, 1 / drawDec, 1 / awayDec]);
    return {
      homeWinProb: Math.round(homeWinProb * 1000) / 1000,
      drawProb: Math.round(drawProb * 1000) / 1000,
      awayWinProb: Math.round(awayWinProb * 1000) / 1000,
    };
  }
}

module.exports = PredictionEngine;
