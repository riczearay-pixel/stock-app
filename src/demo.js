'use strict';

// 离线演示数据（DEMO=1 时使用），用随机游走生成，仅用于无网络环境下体验界面
const { mulberry32 } = require('./model');

const PARAMS = {
  sp500: { start: 2100, drift: 0.09, vol: 0.18, seed: 1 },
  gold: { start: 1150, drift: 0.07, vol: 0.15, seed: 2 },
};

function gaussian(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function demoHistory(key) {
  const p = PARAMS[key];
  const rand = mulberry32(p.seed);
  const points = [];
  let price = p.start;
  const day = 86400e3;
  let t = Date.now() - 10 * 365.25 * day;
  while (t < Date.now()) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      price *= Math.exp(p.drift / 252 - (p.vol ** 2) / 504 + (p.vol / Math.sqrt(252)) * gaussian(rand));
      points.push({ t, c: price });
    }
    t += day;
  }
  return { points, source: '演示数据（DEMO 模式，非真实行情）' };
}

function demoQuote(key, name, unit) {
  const { points } = demoHistory(key);
  const prev = points.at(-2).c;
  const now = Date.now();
  const rand = mulberry32(Math.floor(now / 5000));
  const intraday = [];
  let c = prev;
  for (let i = 60; i >= 0; i--) {
    c *= 1 + (rand() - 0.5) * 0.001;
    intraday.push({ t: now - i * 120e3, c });
  }
  const price = c;
  return {
    key, name, unit, currency: 'USD', price, previousClose: prev,
    change: price - prev, changePct: (price - prev) / prev, marketTime: now,
    intraday, source: '演示数据（DEMO 模式，非真实行情）',
  };
}

module.exports = { demoHistory, demoQuote };
