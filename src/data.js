'use strict';

// 行情数据：依次尝试多个数据源，哪个可用就用哪个，并记住上次成功的源优先使用
//   1. Yahoo Finance（海外网络通常可用，有分时）
//   2. 东方财富（中国大陆网络可直接访问，有分时）
//   3. Stooq（仅日线，部分地区可能拒绝访问）

const ASSETS = {
  sp500: { name: '标普500指数', yahoo: '^GSPC', eastmoney: '100.SPX', stooq: '^spx', currency: 'USD', unit: '点' },
  gold: { name: '黄金 (COMEX 期货)', yahoo: 'GC=F', eastmoney: '101.GC00Y', stooq: 'xauusd', currency: 'USD', unit: '美元/盎司' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function request(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
const getJson = async (url, headers) => (await request(url, headers)).json();
const getText = async (url, headers) => (await request(url, headers)).text();

function quoteFrom(asset, key, { price, previousClose, marketTime, intraday }, source) {
  if (!Number.isFinite(price) || !Number.isFinite(previousClose)) throw new Error('报价数据不完整');
  return {
    key,
    name: asset.name,
    unit: asset.unit,
    currency: asset.currency,
    price,
    previousClose,
    change: price - previousClose,
    changePct: (price - previousClose) / previousClose,
    marketTime,
    intraday,
    source,
  };
}

// ---------- Yahoo Finance ----------
function yahooUrl(symbol, range, interval) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
}

function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || '返回数据为空');
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] != null && Number.isFinite(close[i])) points.push({ t: ts[i] * 1000, c: close[i] });
  }
  return { meta: r.meta, points };
}

const yahoo = {
  name: 'Yahoo Finance',
  async quote(a) {
    const { meta, points } = parseYahoo(await getJson(yahooUrl(a.yahoo, '1d', '2m')));
    return {
      price: meta.regularMarketPrice ?? points.at(-1)?.c,
      previousClose: meta.chartPreviousClose ?? meta.previousClose,
      marketTime: (meta.regularMarketTime || 0) * 1000 || points.at(-1)?.t,
      intraday: points,
    };
  },
  async history(a) {
    return parseYahoo(await getJson(yahooUrl(a.yahoo, '10y', '1d'))).points;
  },
};

// ---------- 东方财富 ----------
const EM_HEADERS = { Referer: 'https://quote.eastmoney.com/' };

// 东方财富时间为北京时间
function parseBeijingTime(s) {
  const iso = s.length <= 10 ? `${s}T15:00:00+08:00` : `${s.replace(' ', 'T')}:00+08:00`;
  return Date.parse(iso);
}

// kline 行格式："日期,开盘,收盘,最高,最低,..."
function parseEastmoneyKlines(json) {
  const lines = json?.data?.klines;
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('返回数据为空');
  const points = [];
  for (const line of lines) {
    const [date, , close] = line.split(',');
    const c = Number(close);
    const t = parseBeijingTime(date);
    if (Number.isFinite(c) && c > 0 && Number.isFinite(t)) points.push({ t, c });
  }
  return points;
}

// trends 行格式："时间,开盘,收盘,最高,最低,..."
function parseEastmoneyTrends(json) {
  const d = json?.data;
  if (!d || !Array.isArray(d.trends)) throw new Error('返回数据为空');
  const points = [];
  for (const line of d.trends) {
    const [time, , close] = line.split(',');
    const c = Number(close);
    const t = parseBeijingTime(time);
    if (Number.isFinite(c) && c > 0 && Number.isFinite(t)) points.push({ t, c });
  }
  const preClose = Number(d.preClose ?? d.prePrice);
  return { points, preClose: Number.isFinite(preClose) && preClose > 0 ? preClose : undefined };
}

function eastmoneyKlineUrl(secid, limit) {
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=${limit}&end=20500101` +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
}

const eastmoney = {
  name: '东方财富',
  async quote(a) {
    const klines = parseEastmoneyKlines(await getJson(eastmoneyKlineUrl(a.eastmoney, 5), EM_HEADERS));
    let intraday = [];
    let preClose;
    try {
      const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${a.eastmoney}&ndays=1&iscr=0` +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
      ({ points: intraday, preClose } = parseEastmoneyTrends(await getJson(url, EM_HEADERS)));
    } catch {
      // 分时数据只用于小图，失败不影响报价
    }
    const last = intraday.at(-1) || klines.at(-1);
    return {
      price: last.c,
      previousClose: preClose ?? klines.at(-2)?.c,
      marketTime: last.t,
      intraday,
    };
  },
  async history(a) {
    return parseEastmoneyKlines(await getJson(eastmoneyKlineUrl(a.eastmoney, 2600), EM_HEADERS));
  },
};

// ---------- Stooq ----------
function parseStooqCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (!/^Date,/i.test(lines[0] || '')) throw new Error('返回格式异常');
  const points = [];
  for (const line of lines.slice(1)) {
    const [date, , , , close] = line.split(',');
    const c = Number(close);
    const t = Date.parse(date + 'T21:00:00Z');
    if (Number.isFinite(c) && Number.isFinite(t)) points.push({ t, c });
  }
  if (points.length === 0) throw new Error('无数据');
  return points;
}

const stooq = {
  name: 'Stooq',
  async history(a) {
    const points = parseStooqCsv(await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(a.stooq)}&i=d`));
    const cutoff = Date.now() - 10 * 365.25 * 86400e3;
    return points.filter((p) => p.t >= cutoff);
  },
  async quote(a) {
    const points = await this.history(a);
    return { price: points.at(-1).c, previousClose: points.at(-2)?.c, marketTime: points.at(-1).t, intraday: [] };
  },
};

// ---------- 依次尝试 ----------
const SOURCES = [yahoo, eastmoney, stooq];
const preferred = { quote: null, history: null };

async function tryAll(kind, fn) {
  const order = preferred[kind] ? [preferred[kind], ...SOURCES.filter((s) => s !== preferred[kind])] : SOURCES;
  const errors = [];
  for (const src of order) {
    try {
      const value = await fn(src);
      preferred[kind] = src;
      return { value, source: src.name };
    } catch (err) {
      errors.push(`${src.name}: ${err.cause?.code || err.message}`);
    }
  }
  throw new Error(`所有数据源都不可用（${errors.join('；')}）`);
}

async function fetchQuote(key) {
  const a = ASSETS[key];
  const { value, source } = await tryAll('quote', async (src) => quoteFrom(a, key, await src.quote(a), src.name));
  return { ...value, source };
}

async function fetchHistory(key) {
  const a = ASSETS[key];
  const { value, source } = await tryAll('history', async (src) => {
    const points = await src.history(a);
    if (points.length < 250) throw new Error(`历史数据过少（${points.length} 条）`);
    return points;
  });
  return { points: value, source };
}

module.exports = {
  ASSETS, SOURCES, fetchQuote, fetchHistory,
  parseYahoo, parseStooqCsv, parseEastmoneyKlines, parseEastmoneyTrends,
};
