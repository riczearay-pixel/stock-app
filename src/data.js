'use strict';

// 行情数据：优先 Yahoo Finance，失败时回退到 Stooq（仅日线）

const ASSETS = {
  sp500: { name: '标普500指数', yahoo: '^GSPC', stooq: '^spx', currency: 'USD', unit: '点' },
  gold: { name: '黄金 (COMEX 期货)', yahoo: 'GC=F', stooq: 'xauusd', currency: 'USD', unit: '美元/盎司' },
};

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

function yahooUrl(symbol, range, interval) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
}

function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'Yahoo 返回数据为空');
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] != null && Number.isFinite(close[i])) points.push({ t: ts[i] * 1000, c: close[i] });
  }
  return { meta: r.meta, points };
}

function parseStooqCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (!/^Date,/i.test(lines[0] || '')) throw new Error('Stooq 返回格式异常');
  const points = [];
  for (const line of lines.slice(1)) {
    const [date, , , , close] = line.split(',');
    const c = Number(close);
    const t = Date.parse(date + 'T21:00:00Z');
    if (Number.isFinite(c) && Number.isFinite(t)) points.push({ t, c });
  }
  if (points.length === 0) throw new Error('Stooq 无数据');
  return points;
}

// 实时报价（含当日分时）
async function fetchQuote(key) {
  const a = ASSETS[key];
  try {
    const { meta, points } = parseYahoo(await getJson(yahooUrl(a.yahoo, '1d', '2m')));
    const price = meta.regularMarketPrice ?? points.at(-1)?.c;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    return {
      key,
      name: a.name,
      unit: a.unit,
      currency: meta.currency || a.currency,
      price,
      previousClose: prev,
      change: price - prev,
      changePct: (price - prev) / prev,
      marketTime: (meta.regularMarketTime || 0) * 1000 || points.at(-1)?.t,
      intraday: points,
      source: 'Yahoo Finance',
    };
  } catch (err) {
    const points = await fetchStooqDaily(a.stooq);
    const last = points.at(-1);
    const prev = points.at(-2);
    return {
      key,
      name: a.name,
      unit: a.unit,
      currency: a.currency,
      price: last.c,
      previousClose: prev.c,
      change: last.c - prev.c,
      changePct: (last.c - prev.c) / prev.c,
      marketTime: last.t,
      intraday: [],
      source: `Stooq（Yahoo 不可用：${err.message}）`,
    };
  }
}

async function fetchStooqDaily(symbol) {
  return parseStooqCsv(await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`));
}

// 日线历史
async function fetchHistory(key, range = '10y') {
  const a = ASSETS[key];
  try {
    const { points } = parseYahoo(await getJson(yahooUrl(a.yahoo, range, '1d')));
    if (points.length < 250) throw new Error('Yahoo 历史数据过少');
    return { points, source: 'Yahoo Finance' };
  } catch (err) {
    const years = parseInt(range, 10) || 10;
    const cutoff = Date.now() - years * 365.25 * 86400e3;
    const points = (await fetchStooqDaily(a.stooq)).filter((p) => p.t >= cutoff);
    return { points, source: `Stooq（Yahoo 不可用：${err.message}）` };
  }
}

module.exports = { ASSETS, fetchQuote, fetchHistory, parseYahoo, parseStooqCsv };
