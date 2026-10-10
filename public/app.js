'use strict';

const QUOTE_REFRESH_MS = 15000;
const FORECAST_REFRESH_MS = 5 * 60000;
const HISTORY_DAYS_SHOWN = 504; // 图上显示最近约 2 年历史

const state = { active: 'sp500', quotes: {}, sparks: {}, fan: null, hist: null };

const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(d)}%`);
const prob = (n) => `${(n * 100).toFixed(1)}%`;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---------- 实时报价 ----------
async function refreshQuotes() {
  const dot = document.getElementById('dot');
  try {
    await Promise.all(['sp500', 'gold'].map(async (key) => renderQuote(await api(`/api/quote/${key}`))));
    dot.className = 'dot live';
    document.getElementById('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')} · 每 ${QUOTE_REFRESH_MS / 1000} 秒刷新`;
  } catch (err) {
    dot.className = 'dot err';
    document.getElementById('updated').textContent = `行情获取失败：${err.message}`;
  }
}

function renderQuote(q) {
  const el = document.querySelector(`.quote[data-key="${q.key}"]`);
  const priceEl = el.querySelector('.price');
  const prev = state.quotes[q.key];
  priceEl.textContent = fmt(q.price);
  if (prev && prev.price !== q.price) {
    priceEl.classList.add(q.price > prev.price ? 'flash-up' : 'flash-down');
    setTimeout(() => priceEl.classList.remove('flash-up', 'flash-down'), 800);
  }
  const chg = el.querySelector('.chg');
  chg.className = `chg ${q.change >= 0 ? 'up' : 'down'}`;
  chg.textContent = `${q.change >= 0 ? '+' : ''}${fmt(q.change)} (${pct(q.changePct, 2)})`;
  el.querySelector('.src').textContent = `数据来源：${q.source} · 行情时间 ${new Date(q.marketTime).toLocaleString('zh-CN')}`;
  state.quotes[q.key] = q;
  renderSpark(q, el.querySelector('.spark'));
}

function renderSpark(q, canvas) {
  const color = q.change >= 0 ? css('--up') : css('--down');
  const data = q.intraday.map((p) => ({ x: p.t, y: p.c }));
  let chart = state.sparks[q.key];
  if (!chart) {
    chart = state.sparks[q.key] = new Chart(canvas, {
      type: 'line',
      data: { datasets: [{ data, borderWidth: 1.5, pointRadius: 0, tension: 0.2 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { type: 'linear', display: false }, y: { display: false } },
      },
    });
  }
  chart.data.datasets[0].data = data;
  chart.data.datasets[0].borderColor = color;
  chart.update('none');
}

// ---------- 预测 ----------
async function loadForecast(key) {
  try {
    const [fc, hist] = await Promise.all([api(`/api/forecast/${key}`), api(`/api/history/${key}`)]);
    if (key !== state.active) return;
    renderFan(fc, hist);
    renderProbTable(fc);
    renderThreshTable(fc);
    renderHistogram(fc);
    renderParams(fc);
  } catch (err) {
    document.getElementById('params').innerHTML = `<div class="error">预测失败：${err.message}</div>`;
  }
}

// 交易日序列：从今天起跳过周末
function futureTradingDays(n) {
  const out = [];
  const d = new Date();
  d.setHours(16, 0, 0, 0);
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(d.getTime());
  }
  return out;
}

function renderFan(fc, hist) {
  const accent = state.active === 'gold' ? css('--gold') : css('--accent');
  const past = hist.points.slice(-HISTORY_DAYS_SHOWN).map((p) => ({ x: p.t, y: p.c }));
  const now = Date.now();
  const days = [now, ...futureTradingDays(fc.horizonDays)];
  const band = (arr) => [{ x: now, y: fc.startPrice }, ...arr.map((y, i) => ({ x: days[i + 1], y }))];
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

  const datasets = [
    { label: '历史收盘价', data: [...past, { x: now, y: fc.startPrice }], borderColor: accent, borderWidth: 1.5, pointRadius: 0 },
    { label: '95% 分位', data: band(fc.bands.p95), borderColor: 'transparent', pointRadius: 0, fill: false },
    { label: '5% 分位', data: band(fc.bands.p5), borderColor: 'transparent', backgroundColor: alpha(accent, 0.15), pointRadius: 0, fill: '-1' },
    { label: '75% 分位', data: band(fc.bands.p75), borderColor: 'transparent', pointRadius: 0, fill: false },
    { label: '25% 分位', data: band(fc.bands.p25), borderColor: 'transparent', backgroundColor: alpha(accent, 0.3), pointRadius: 0, fill: '-1' },
    { label: '中位数预测', data: band(fc.bands.p50), borderColor: accent, borderDash: [6, 4], borderWidth: 2, pointRadius: 0 },
  ];

  const options = {
    animation: false, responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { labels: { filter: (item) => ['历史收盘价', '中位数预测'].includes(item.text) } },
      tooltip: {
        callbacks: {
          title: (items) => new Date(items[0].parsed.x).toLocaleDateString('zh-CN'),
          label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: { callback: (v) => new Date(v).toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric' }), maxTicksLimit: 10 },
      },
      y: { ticks: { callback: (v) => fmt(v, 0) } },
    },
  };

  if (state.fan) state.fan.destroy();
  state.fan = new Chart(document.getElementById('fan'), { type: 'line', data: { datasets }, options });
}

function renderProbTable(fc) {
  const rows = fc.summary.map((s) => `
    <tr>
      <td>${s.months} 个月</td>
      <td class="up">${prob(s.probUp)}<span class="bar" style="width:${s.probUp * 60}px;background:var(--up)"></span></td>
      <td class="down">${prob(s.probDown)}</td>
      <td>${pct(s.medianReturn)}</td>
      <td>${pct(s.range90[0], 0)} ~ ${pct(s.range90[1], 0)}</td>
      <td title="历史上同样长度的窗口中上涨的比例">${prob(s.historicalUpRate)}</td>
    </tr>`).join('');
  document.getElementById('probTable').innerHTML = `
    <tr><th>期限</th><th>上涨概率</th><th>下跌概率</th><th>中位涨跌</th><th>90% 区间</th><th>历史上涨率</th></tr>${rows}`;
}

function renderThreshTable(fc) {
  const s = fc.summary.at(-1);
  const ts = Object.keys(s.probAbove).map(Number).sort((a, b) => a - b);
  const rows = [
    ...ts.slice().reverse().map((t) => [`上涨超过 ${t * 100}%`, s.probAbove[t], 'up', fc.startPrice * (1 + t)]),
    ...ts.map((t) => [`下跌超过 ${t * 100}%`, s.probBelow[t], 'down', fc.startPrice * (1 - t)]),
  ].map(([label, p, cls, price]) => `
    <tr><td>${label}</td><td>${fmt(price, 0)}</td>
    <td class="${cls}">${prob(p)}<span class="bar" style="width:${p * 80}px;background:var(--${cls})"></span></td></tr>`).join('');
  document.getElementById('threshTable').innerHTML = `<tr><th>情形</th><th>对应价格</th><th>概率</th></tr>${rows}`;
}

function renderHistogram(fc) {
  const up = css('--up');
  const down = css('--down');
  const labels = fc.histogram.map((b) => fmt((b.from + b.to) / 2, 0));
  const colors = fc.histogram.map((b) => ((b.from + b.to) / 2 >= fc.startPrice ? up : down));
  if (state.hist) state.hist.destroy();
  state.hist = new Chart(document.getElementById('hist'), {
    type: 'bar',
    data: { labels, datasets: [{ data: fc.histogram.map((b) => b.prob * 100), backgroundColor: colors.map((c) => c + 'b0'), barPercentage: 1, categoryPercentage: 1 }] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (items) => { const b = fc.histogram[items[0].dataIndex]; return `${fmt(b.from, 0)} ~ ${fmt(b.to, 0)}`; },
          label: (item) => `概率 ${item.parsed.y.toFixed(2)}%`,
        } },
      },
      scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { ticks: { callback: (v) => `${v}%` } } },
    },
  });
}

function renderParams(fc) {
  const p = fc.params;
  const items = [
    ['当前价格（起点）', fmt(fc.startPrice)],
    ['当前年化波动率', pct(p.annualizedVolNow).replace('+', '')],
    ['长期年化波动率', pct(p.annualizedVolLongRun).replace('+', '')],
    ['假设年化漂移', pct(p.annualizedDrift)],
    ['样本交易日', p.sampleDays.toLocaleString()],
    ['模拟路径数', fc.paths.toLocaleString()],
  ];
  document.getElementById('params').innerHTML =
    items.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('') +
    `<div><b style="font-size:13px">${fc.historySource}</b><span>历史数据来源</span></div>`;
}

// ---------- 启动 ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    state.active = btn.dataset.key;
    loadForecast(state.active);
  });
});

refreshQuotes();
loadForecast(state.active);
setInterval(refreshQuotes, QUOTE_REFRESH_MS);
setInterval(() => loadForecast(state.active), FORECAST_REFRESH_MS);
