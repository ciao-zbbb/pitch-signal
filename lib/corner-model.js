'use strict';

/**
 * Corner Prediction Model — extracted from lib/routes/matchup.js
 *
 * Formula:
 *   homePredicted = homeAvg * (awayAvg / (LEAGUE_AVG / 2)) * homeStyleCoeff
 *   awayPredicted = awayAvg * (homeAvg / (LEAGUE_AVG / 2)) * awayStyleCoeff
 *   total = homePredicted + awayPredicted
 *
 * Style coefficients are tunable via backtest (p3/corner-backtest).
 */

const LEAGUE_AVG = 9.5;

// Default averages used when real data unavailable
const DEFAULT_HOME_AVG = 4.5;
const DEFAULT_AWAY_AVG = 3.8;

// Style coefficients → corner generation multiplier.
// Higher = more corners (wing-play, pressing). Lower = fewer (possession, counter).
const STYLE_COEFF = {
  '高位逼抢+快攻': 1.25,
  '高位逼抢+快速传导': 1.20,
  '高压逼抢+战术多变': 1.15,
  '高位压迫+快速转换': 1.20,
  '控球+中场组织': 0.85,
  '控球传控': 0.85,
  '防守反击+纪律性强': 0.75,
  '防守反击+身体对抗': 0.80,
  '均衡型': 1.00,
};

/**
 * Map a display style string to its coefficient.
 */
function getStyleCoeff(style) {
  return STYLE_COEFF[style] || 1.0;
}

/**
 * Predict corner counts for a match.
 * @param {number} homeAvg - home team historical corner average
 * @param {number} awayAvg - away team historical corner average
 * @param {string} homeStyle - home coach style (Chinese label)
 * @param {string} awayStyle - away coach style (Chinese label)
 * @returns {{ home: number, away: number, total: number, homeCoeff: number, awayCoeff: number }}
 */
function predictCorners(homeAvg, awayAvg, homeStyle, awayStyle) {
  const ha = typeof homeAvg === 'number' && homeAvg > 0 ? homeAvg : DEFAULT_HOME_AVG;
  const aa = typeof awayAvg === 'number' && awayAvg > 0 ? awayAvg : DEFAULT_AWAY_AVG;
  const homeCoeff = getStyleCoeff(homeStyle || '均衡型');
  const awayCoeff = getStyleCoeff(awayStyle || '均衡型');

  const homePredicted = ha * (aa / (LEAGUE_AVG / 2)) * homeCoeff;
  const awayPredicted = aa * (ha / (LEAGUE_AVG / 2)) * awayCoeff;
  const totalPredicted = Math.round((homePredicted + awayPredicted) * 10) / 10;

  return {
    home: Math.round(homePredicted * 10) / 10,
    away: Math.round(awayPredicted * 10) / 10,
    total: totalPredicted,
    homeCoeff,
    awayCoeff,
  };
}

module.exports = {
  predictCorners,
  getStyleCoeff,
  getStyleCoeffMap: () => ({ ...STYLE_COEFF }),
  LEAGUE_AVG,
  DEFAULT_HOME_AVG,
  DEFAULT_AWAY_AVG,
  STYLE_COEFF,
};
