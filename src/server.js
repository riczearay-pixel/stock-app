'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ASSETS, fetchQuote, fetchHistory } = require('./data');
const { forecast } = require('./model');
const { demoHistory, demoQuote } = require('./demo');

const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.env.DEMO === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 简单内存缓存，避免频繁请求上游
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// 数据源没有分时数据时（如新浪），用每次轮询到的价格拼出当日走势
const ticks = {};
function withTicks(q) {
  if (q.intraday.length > 0) return q;
  const day = new Date(q.marketTime).toDateString();
  const buf = (ticks[q.key] = (ticks[q.key] || []).filter((p) => new Date(p.t).toDateString() === day));
  if (buf.at(-1)?.c !== q.price || buf.length === 0) buf.push({ t: Date.now(), c: q.price });
  if (buf.length > 1000) buf.shift();
  return { ...q, intraday: [{ t: buf[0].t - 1, c: q.previousClose }, ...buf] };
}

const getQuote = (key) =>
  cached(`q:${key}`, 15e3, async () => (DEMO ? demoQuote(key, ASSETS[key].name, ASSETS[key].unit) : withTicks(await fetchQuote(key))));
const getHistory = (key) => cached(`h:${key}`, 3600e3, () => (DEMO ? demoHistory(key) : fetchHistory(key)));

async function getForecast(key) {
  const quote = await getQuote(key);
  const hist = await getHistory(key);
  // 预测结果按分钟缓存（起点为最新实时价）
  const minute = Math.floor(Date.now() / 60e3);
  return cached(`f:${key}:${minute}`, 60e3, () => {
    const closes = hist.points.map((p) => p.c);
    const result = forecast(closes, { startPrice: quote.price });
    return { key, name: ASSETS[key].name, asOf: Date.now(), historySource: hist.source, ...result };
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const m = url.pathname.match(/^\/api\/(quote|history|forecast)\/(\w+)$/);
  if (!m) return serveStatic(req, res, url.pathname);
  const [, kind, key] = m;
  if (!ASSETS[key]) return sendJson(res, 404, { error: `未知品种：${key}` });
  try {
    if (kind === 'quote') return sendJson(res, 200, await getQuote(key));
    if (kind === 'history') {
      const h = await getHistory(key);
      return sendJson(res, 200, { key, source: h.source, points: h.points });
    }
    return sendJson(res, 200, await getForecast(key));
  } catch (err) {
    console.error(`[${kind}/${key}]`, err);
    return sendJson(res, 502, { error: `获取数据失败：${err.message}` });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`标普500 & 黄金 行情预测 已启动: http://localhost:${PORT}${DEMO ? '  (DEMO 演示模式)' : ''}`);
  });
}

module.exports = { server };
