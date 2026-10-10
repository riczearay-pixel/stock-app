'use strict';

// 数据源诊断：node src/check.js
// 逐个测试每个数据源能否获取报价和历史数据，帮助排查"行情获取失败"
const { ASSETS, SOURCES } = require('./data');

(async () => {
  for (const [key, asset] of Object.entries(ASSETS)) {
    console.log(`\n== ${asset.name} ==`);
    for (const src of SOURCES) {
      for (const kind of ['quote', 'history']) {
        const started = Date.now();
        try {
          const r = await src[kind](asset);
          const info = kind === 'quote'
            ? `价格 ${r.price}，昨收 ${r.previousClose}，分时 ${r.intraday.length} 条`
            : `${r.length} 条日线，最新 ${new Date(r.at(-1).t).toISOString().slice(0, 10)} 收盘 ${r.at(-1).c}`;
          console.log(`  ✅ ${src.name} ${kind === 'quote' ? '报价' : '历史'}：${info}（${Date.now() - started}ms）`);
        } catch (err) {
          console.log(`  ❌ ${src.name} ${kind === 'quote' ? '报价' : '历史'}：${err.code || err.cause?.code || err.message}（${Date.now() - started}ms）`);
        }
      }
    }
  }
})();
