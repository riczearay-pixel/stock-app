'use strict';

// 预测模型：过滤历史模拟（Filtered Historical Simulation, FHS）蒙特卡洛
//
// 1. 用日收盘价计算对数收益率
// 2. 用 EWMA (RiskMetrics, λ=0.94) 估计每天的条件波动率
// 3. 收益率 / 当日波动率 = 标准化残差（保留真实的肥尾和偏度）
// 4. 模拟时：从历史残差中有放回抽样，乘以模拟出的波动率；
//    波动率从当前水平按半衰期向长期均值回归
// 5. 漂移项使用长期平均对数收益，并向 0 做收缩，避免过度外推
//
// 输出：每日分位数区间（扇形图）、各期限上涨/下跌概率、终值分布直方图。

const TRADING_DAYS_PER_MONTH = 21;

// 可复现的伪随机数生成器 (mulberry32)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs) {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  }
  return r;
}

// EWMA 条件方差序列；sigmas[i] 是第 i 天收益发生「之前」可得的波动率估计
function ewmaSigmas(returns, lambda) {
  const seedLen = Math.min(60, returns.length);
  let variance = std(returns.slice(0, seedLen)) ** 2;
  const sigmas = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) {
    sigmas[i] = Math.sqrt(variance);
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
  }
  return { sigmas, current: Math.sqrt(variance) };
}

// 历史基准：过去所有长度为 horizon 的窗口中，上涨的比例
function historicalBaseRate(closes, horizon) {
  let up = 0;
  let n = 0;
  for (let i = 0; i + horizon < closes.length; i++) {
    n++;
    if (closes[i + horizon] > closes[i]) up++;
  }
  return n ? up / n : NaN;
}

/**
 * @param {number[]} closes 按时间升序的日收盘价（建议 >= 3 年）
 * @param {object} [opts]
 */
function forecast(closes, opts = {}) {
  const {
    horizonDays = 126, // 约 6 个月交易日
    paths = 10000,
    lambda = 0.94,
    volHalfLifeDays = 40, // 波动率向长期均值回归的半衰期
    driftShrink = 0.5, // 漂移收缩系数：0=无漂移，1=完全使用历史均值
    seed = 42,
    thresholds = [0.05, 0.1, 0.2],
    startPrice = closes[closes.length - 1],
  } = opts;

  if (!Array.isArray(closes) || closes.length < 250) {
    throw new Error('历史数据不足（至少需要 250 个交易日）');
  }

  const rets = logReturns(closes);
  const { sigmas, current: sigmaNow } = ewmaSigmas(rets, lambda);
  const longRunSigma = std(rets);
  const residuals = rets.map((r, i) => r / sigmas[i]).filter(Number.isFinite);
  // 标准化残差去均值、单位化，避免重复计入漂移和波动
  const resMean = mean(residuals);
  const resStd = std(residuals);
  const z = residuals.map((x) => (x - resMean) / resStd);

  const mu = mean(rets) * driftShrink; // 日对数漂移
  const decay = Math.pow(0.5, 1 / volHalfLifeDays);

  // 预先计算每一天的波动率（确定性均值回归路径）
  const volPath = new Float64Array(horizonDays);
  let v2 = sigmaNow ** 2;
  const lr2 = longRunSigma ** 2;
  for (let d = 0; d < horizonDays; d++) {
    volPath[d] = Math.sqrt(v2);
    v2 = lr2 + (v2 - lr2) * decay;
  }
  const rand = mulberry32(seed);
  const cum = new Float64Array(paths * horizonDays); // 每条路径的累计对数收益
  for (let p = 0; p < paths; p++) {
    let acc = 0;
    const base = p * horizonDays;
    for (let d = 0; d < horizonDays; d++) {
      const shock = z[(rand() * z.length) | 0];
      acc += mu + volPath[d] * shock;
      cum[base + d] = acc;
    }
  }

  // 每日分位数（扇形图）
  const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
  const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
  const col = new Float64Array(paths);
  for (let d = 0; d < horizonDays; d++) {
    for (let p = 0; p < paths; p++) col[p] = cum[p * horizonDays + d];
    col.sort();
    const vals = qs.map((q) => startPrice * Math.exp(quantile(col, q)));
    bands.p5.push(vals[0]);
    bands.p25.push(vals[1]);
    bands.p50.push(vals[2]);
    bands.p75.push(vals[3]);
    bands.p95.push(vals[4]);
  }

  // 各期限统计
  const horizons = [1, 3, 6]
    .map((m) => Math.min(m * TRADING_DAYS_PER_MONTH, horizonDays))
    .filter((d, i, arr) => arr.indexOf(d) === i);
  const summary = horizons.map((d) => {
    const finals = new Float64Array(paths);
    for (let p = 0; p < paths; p++) finals[p] = Math.exp(cum[p * horizonDays + d - 1]) - 1;
    finals.sort();
    const probAbove = {};
    const probBelow = {};
    for (const t of thresholds) {
      let a = 0;
      let b = 0;
      for (const r of finals) {
        if (r > t) a++;
        if (r < -t) b++;
      }
      probAbove[t] = a / paths;
      probBelow[t] = b / paths;
    }
    let up = 0;
    let sum = 0;
    for (const r of finals) {
      if (r > 0) up++;
      sum += r;
    }
    return {
      tradingDays: d,
      months: Math.round(d / TRADING_DAYS_PER_MONTH),
      probUp: up / paths,
      probDown: 1 - up / paths,
      expectedReturn: sum / paths,
      medianReturn: quantile(finals, 0.5),
      range90: [quantile(finals, 0.05), quantile(finals, 0.95)],
      range50: [quantile(finals, 0.25), quantile(finals, 0.75)],
      medianPrice: startPrice * (1 + quantile(finals, 0.5)),
      probAbove,
      probBelow,
      historicalUpRate: historicalBaseRate(closes, d),
    };
  });

  // 终值分布直方图
  const finals = new Float64Array(paths);
  for (let p = 0; p < paths; p++) finals[p] = startPrice * Math.exp(cum[p * horizonDays + horizonDays - 1]);
  finals.sort();
  const lo = quantile(finals, 0.005);
  const hi = quantile(finals, 0.995);
  const bins = 40;
  const width = (hi - lo) / bins;
  const histogram = Array.from({ length: bins }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, prob: 0 }));
  for (const f of finals) {
    const i = Math.floor((f - lo) / width);
    if (i >= 0 && i < bins) histogram[i].prob += 1 / paths;
  }

  return {
    startPrice,
    horizonDays,
    paths,
    params: {
      annualizedVolNow: sigmaNow * Math.sqrt(252),
      annualizedVolLongRun: longRunSigma * Math.sqrt(252),
      annualizedDrift: mu * 252,
      sampleDays: rets.length,
    },
    bands,
    summary,
    histogram,
  };
}

module.exports = { forecast, logReturns, ewmaSigmas, quantile, mulberry32, historicalBaseRate };
