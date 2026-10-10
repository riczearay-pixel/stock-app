'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { forecast, quantile, mulberry32 } = require('../src/model');
const { parseYahoo, parseStooqCsv } = require('../src/data');

function gbm(n, drift, vol, seed) {
  const rand = mulberry32(seed);
  const out = [100];
  for (let i = 1; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    out.push(out[i - 1] * Math.exp(drift / 252 + (vol / Math.sqrt(252)) * z));
  }
  return out;
}

test('quantile 线性插值', () => {
  assert.strictEqual(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(quantile([0, 10], 0.25), 2.5);
});

test('数据不足时报错', () => {
  assert.throws(() => forecast([1, 2, 3]), /历史数据不足/);
});

test('预测结果结构与单调性', () => {
  const fc = forecast(gbm(2520, 0.08, 0.2, 7), { paths: 4000 });
  assert.strictEqual(fc.bands.p50.length, 126);
  assert.deepStrictEqual(fc.summary.map((s) => s.months), [1, 3, 6]);
  for (let d = 0; d < 126; d++) {
    assert.ok(fc.bands.p5[d] <= fc.bands.p25[d] && fc.bands.p25[d] <= fc.bands.p50[d]);
    assert.ok(fc.bands.p50[d] <= fc.bands.p75[d] && fc.bands.p75[d] <= fc.bands.p95[d]);
  }
  for (const s of fc.summary) {
    assert.ok(Math.abs(s.probUp + s.probDown - 1) < 1e-9);
    assert.ok(s.probAbove[0.2] <= s.probAbove[0.1] && s.probAbove[0.1] <= s.probAbove[0.05]);
  }
  // 区间随时间变宽
  const w = (i) => fc.bands.p95[i] - fc.bands.p5[i];
  assert.ok(w(125) > w(20) && w(20) > w(0));
  const total = fc.histogram.reduce((a, b) => a + b.prob, 0);
  assert.ok(total > 0.98 && total <= 1.0000001);
});

test('波动率估计接近真实值', () => {
  const fc = forecast(gbm(2520, 0.05, 0.25, 11), { paths: 2000 });
  assert.ok(Math.abs(fc.params.annualizedVolLongRun - 0.25) < 0.02, fc.params.annualizedVolLongRun);
  // 6 个月 90% 区间宽度 ≈ 2 * 1.645 * 0.25 * sqrt(0.5) ≈ 0.58（对数空间）
  const s = fc.summary.at(-1);
  const width = Math.log(1 + s.range90[1]) - Math.log(1 + s.range90[0]);
  assert.ok(width > 0.45 && width < 0.75, width);
});

test('同一种子结果可复现', () => {
  const closes = gbm(1000, 0.05, 0.2, 3);
  const a = forecast(closes, { paths: 500 });
  const b = forecast(closes, { paths: 500 });
  assert.deepStrictEqual(a.summary, b.summary);
});

test('解析 Yahoo 数据（跳过空值）', () => {
  const { meta, points } = parseYahoo({
    chart: { result: [{ meta: { regularMarketPrice: 3 }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [1, null, 3] }] } }] },
  });
  assert.strictEqual(meta.regularMarketPrice, 3);
  assert.deepStrictEqual(points, [{ t: 1000, c: 1 }, { t: 3000, c: 3 }]);
});

test('解析 Stooq CSV', () => {
  const pts = parseStooqCsv('Date,Open,High,Low,Close,Volume\n2024-01-02,1,2,0.5,1.5,100\n2024-01-03,1,2,0.5,1.7,100\n');
  assert.strictEqual(pts.length, 2);
  assert.strictEqual(pts[1].c, 1.7);
  assert.throws(() => parseStooqCsv('No data'), /格式异常/);
});

test('解析东方财富日线与分时', () => {
  const { parseEastmoneyKlines, parseEastmoneyTrends } = require('../src/data');
  const pts = parseEastmoneyKlines({ data: { klines: ['2024-01-02,4745.20,4742.83,4754.33,4722.67,0,0', '2024-01-03,4725.07,4704.81,4729.29,4699.71,0,0'] } });
  assert.strictEqual(pts.length, 2);
  assert.strictEqual(pts[1].c, 4704.81);
  assert.strictEqual(new Date(pts[0].t).toISOString(), '2024-01-02T07:00:00.000Z');
  assert.throws(() => parseEastmoneyKlines({ data: null }), /为空/);
  const tr = parseEastmoneyTrends({ data: { preClose: 4742.83, trends: ['2024-01-03 22:31,4725.0,4726.5,4727,4724,0,0,4726'] } });
  assert.strictEqual(tr.preClose, 4742.83);
  assert.strictEqual(tr.points[0].c, 4726.5);
  assert.strictEqual(new Date(tr.points[0].t).toISOString(), '2024-01-03T14:31:00.000Z');
});
