'use strict';

// 行情数据：依次尝试多个数据源，哪个可用就用哪个，并记住上次成功的源优先使用
//   1. Yahoo Finance（海外网络通常可用，有分时；中国大陆会返回 403）
//   2. 新浪财经（中国大陆网络可直接访问，无分时）
//   3. 东方财富（中国大陆网络可直接访问，有分时）
//   4. Stooq（仅日线，部分地区可能拒绝访问）

const https = require('https');
const http = require('http');

const ASSETS = {
  sp500: {
    name: '标普500指数', currency: 'USD', unit: '点',
    yahoo: '^GSPC', eastmoney: '100.SPX', stooq: '^spx',
    sina: { quote: 'gb_$inx', history: 'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_INX=/US_MinKService.getDailyK?symbol=.INX' },
  },
  gold: {
    name: '黄金 (COMEX 期货)', currency: 'USD', unit: '美元/盎司',
    yahoo: 'GC=F', eastmoney: '101.GC00Y', stooq: 'xauusd',
    sina: { quote: 'hf_GC', history: 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_GC=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=GC&source=web' },
  },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 用 Node 自带的 http/https 模块发请求（请求头更接近浏览器，部分国内接口会拒绝 fetch 的默认请求头）
function nodeGet(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(nodeGet(new URL(res.headers.location, url).toString(), headers));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

let transport = nodeGet;
// 仅供测试替换网络层
function setTransport(fn) {
  transport = fn || nodeGet;
}

async function getText(url, headers = {}) {
  const res = await transport(url, { 'User-Agent': UA, Accept: '*/*', Connection: 'close', ...headers });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.text;
}
async function getJson(url, headers) {
  const text = await getText(url, headers);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回内容不是 JSON');
  }
}

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

// ---------- 新浪财经 ----------
const SINA_HEADERS = { Referer: 'https://finance.sina.com.cn/' };

// 实时报价：var hq_str_xxx="字段1,字段2,...";
function parseSinaQuote(text, code) {
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error('返回数据为空');
  const f = m[1].split(',');
  if (code.startsWith('gb_')) {
    // 美股/指数：[1]现价 [3]时间(北京) [4]涨跌额
    const price = Number(f[1]);
    return { price, previousClose: price - Number(f[4]), marketTime: parseBeijingTime(f[3].slice(0, 16)) };
  }
  // 外盘期货 hf_：[0]现价 [7]昨结算 [6]时间 [12]日期
  const t = parseBeijingTime(`${f[12]} ${String(f[6]).slice(0, 5)}`);
  return { price: Number(f[0]), previousClose: Number(f[7]), marketTime: Number.isFinite(t) ? t : Date.now() };
}

// 日线：var _X=([{"date"|"d":..., "close"|"c":...}, ...]);
function parseSinaKline(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('返回数据为空');
  let rows;
  try {
    rows = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('返回格式异常');
  }
  const points = [];
  for (const r of rows) {
    const c = Number(r.close ?? r.c);
    const t = parseBeijingTime(String(r.date ?? r.d).slice(0, 10));
    if (Number.isFinite(c) && c > 0 && Number.isFinite(t)) points.push({ t, c });
  }
  if (points.length === 0) throw new Error('无数据');
  return points;
}

const sina = {
  name: '新浪财经',
  async quote(a) {
    const text = await getText(`https://hq.sinajs.cn/list=${a.sina.quote}`, SINA_HEADERS);
    return { ...parseSinaQuote(text, a.sina.quote), intraday: [] };
  },
  async history(a) {
    const points = parseSinaKline(await getText(a.sina.history, SINA_HEADERS));
    const cutoff = Date.now() - 10 * 365.25 * 86400e3;
    return points.filter((p) => p.t >= cutoff);
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
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&ut=fa5fd1943c7b386f172d6893dbfba10b';
}

// HTTPS 被断开时再用 HTTP 试一次
async function getEastmoney(url) {
  try {
    return await getJson(url, EM_HEADERS);
  } catch (err) {
    return getJson(url.replace('https://', 'http://'), EM_HEADERS).catch(() => {
      throw err;
    });
  }
}

const eastmoney = {
  name: '东方财富',
  async quote(a) {
    const klines = parseEastmoneyKlines(await getEastmoney(eastmoneyKlineUrl(a.eastmoney, 5)));
    let intraday = [];
    let preClose;
    try {
      const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${a.eastmoney}&ndays=1&iscr=0` +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b';
      ({ points: intraday, preClose } = parseEastmoneyTrends(await getEastmoney(url)));
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
    return parseEastmoneyKlines(await getEastmoney(eastmoneyKlineUrl(a.eastmoney, 2600)));
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
const SOURCES = [yahoo, sina, eastmoney, stooq];
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
      errors.push(`${src.name}: ${err.code || err.cause?.code || err.message}`);
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
  ASSETS, SOURCES, fetchQuote, fetchHistory, setTransport, nodeGet,
  parseYahoo, parseStooqCsv, parseEastmoneyKlines, parseEastmoneyTrends, parseSinaQuote, parseSinaKline,
};
