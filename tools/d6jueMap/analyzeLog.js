#!/usr/bin/env node
/**
 * 解析六道觉分析日志（d6jue_analysis.log），输出每轮与汇总统计。
 *
 * 用法：
 *   node tools/d6jueMap/analyzeLog.js d6jue_analysis.log
 *
 * 日志由 src/common/d6jueAnalysisLog.ts 写入，格式：
 *   [ISO时间] run=<runId> <event> key=value ...
 */

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
	console.log('用法: node tools/d6jueMap/analyzeLog.js <d6jue_analysis.log>');
	process.exit(1);
}

const text = fs.readFileSync(path.resolve(file), 'utf8');
const lineRe = /^\[([^\]]+)\]\s+run=(\d+)\s+([a-zA-Z._]+)(?:\s+(.*))?$/;
const runMap = new Map();

for (const raw of text.split(/\r?\n/)) {
	const line = raw.trim();
	const m = lineRe.exec(line);
	if (!m) continue;
	const [, ts, runId, event, rest] = m;
	const data = {};
	if (rest) {
		for (const token of rest.split(/\s+/)) {
			const eq = token.indexOf('=');
			if (eq > 0) data[token.slice(0, eq)] = token.slice(eq + 1);
		}
	}
	if (!runMap.has(runId)) runMap.set(runId, { id: runId, firstTs: ts, events: [] });
	runMap.get(runId).events.push({ ts, event, data });
}

const runs = Array.from(runMap.values()).sort((a, b) => a.firstTs.localeCompare(b.firstTs));
if (runs.length === 0) {
	console.log('没有解析到 run=* 日志，请确认文件路径和内容。');
	process.exit(1);
}

const num = v => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};
const stepNo = left => (left > 0 ? 21 - left : 0);
const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

const all = {
	clear: 0,
	durations: [],
	leiSource: { buff: 0, shop: 0, none: 0 },
	leiSteps: [],
	powerSteps: [],
	shopEntries: 0,
	shopHits: 0,
	stockViews: 0,
	stockHits: 0,
	huanxi: 0,
	body: 0,
};

runs.forEach((run, index) => {
	const ev = run.events;
	const by = name => ev.filter(e => e.event === name);
	const mapSteps = by('map.step');
	const runEnd = by('run.end').slice(-1)[0];
	const runStart = by('run.start')[0];
	const targets = {};
	const nodeCounts = {};
	const bloomSteps = [];
	let powerReadyStep = 0;

	for (const e of mapSteps) {
		inc(targets, e.data.target || '?');
		const nodes = (e.data.nodes || '').split('/').filter(Boolean);
		for (const n of nodes) inc(nodeCounts, n);
		if (nodes.includes('绽放')) bloomSteps.push(num(e.data.step));
		if (!powerReadyStep && num(e.data.power) >= 3) powerReadyStep = num(e.data.step);
	}

	let leiSource = 'none';
	let leiStep = 0;
	let lastMapStep = null;
	for (const e of ev) {
		if (e.event === 'map.step') {
			lastMapStep = e;
			continue;
		}
		if (e.event === 'buff.pick' && e.data.name === '六道轰雷') {
			leiSource = 'buff';
			leiStep = lastMapStep ? num(lastMapStep.data.step) : stepNo(num(e.data.step));
			break;
		}
		if (e.event === 'shop.buy_success') {
			leiSource = 'shop';
			leiStep = lastMapStep ? num(lastMapStep.data.step) : stepNo(num(e.data.step));
			break;
		}
	}

	// 商店分段：map.step 目标宁息 -> shop.buy/refresh/exit
	const shops = [];
	let shop = null;
	for (const e of ev) {
		if (e.event === 'map.step' && e.data.target === '宁息') {
			shop = { maxStock: 1, hit: false, refreshes: 0 };
			shops.push(shop);
			continue;
		}
		if (!shop) continue;
		if (e.event === 'shop.refresh') {
			shop.maxStock = Math.max(shop.maxStock, num(e.data.stock));
			shop.refreshes++;
		} else if (e.event === 'shop.buy_click' || e.event === 'shop.buy') {
			shop.maxStock = Math.max(shop.maxStock, num(e.data.stock));
			shop.buyClicks = (shop.buyClicks || 0) + 1;
		} else if (e.event === 'shop.buy_success') {
			shop.maxStock = Math.max(shop.maxStock, num(e.data.stock));
			shop.hit = true;
		} else if (e.event === 'shop.buy_failed') {
			shop.maxStock = Math.max(shop.maxStock, num(e.data.stock));
			shop.failures = (shop.failures || 0) + 1;
		} else if (e.event === 'shop.exit') {
			shop.maxStock = Math.max(shop.maxStock, num(e.data.stock));
			shop = null;
		}
	}

	const shopHits = shops.filter(s => s.hit).length;
	const stockViews = shops.reduce((sum, s) => sum + s.maxStock, 0);
	const huanxiEvents = by('map.huanxi');
	const leiChecks = by('buff.lei_check');
	const leiCheckHit = leiChecks.filter(e => e.data.found === '1').length;
	const scans = by('buff.scan');
	const scanLei = scans.filter(e => (e.data.cards || '').split('/').includes('六道轰雷')).length;
	const lastState = ev.slice().reverse().find(e => e.data.wallet !== undefined) || { data: {} };
	const finalLei = runEnd ? num(runEnd.data.lei) : num((mapSteps.slice(-1)[0] || { data: {} }).data.lei);
	const finalPower = runEnd ? num(runEnd.data.power) : num((mapSteps.slice(-1)[0] || { data: {} }).data.power);
	const finalWallet = runEnd ? num(runEnd.data.wallet) : num(lastState.data.wallet);

	console.log(`\n===== Run ${index + 1} (id=${run.id}) =====`);
	console.log(`结果: ${runEnd ? (runEnd.data.result || '?') : '未结束'}${runEnd && runEnd.data.seconds ? `, 耗时=${runEnd.data.seconds}s` : ''}`);
	console.log(`步数: 已选${mapSteps.length}步, 最终力量=${finalPower}, 轰雷=${finalLei}, 万相铃=${finalWallet}`);
	console.log(`轰雷获取: ${leiSource === 'none' ? '未获得' : `${leiSource} @第${leiStep}步`}`);
	console.log(`力量>=3: ${powerReadyStep ? `第${powerReadyStep}步` : '未达到'}`);
	console.log(`目标分布: ${fmtCounts(targets)}`);
	console.log(`节点出现: ${fmtCounts(nodeCounts)}`);
	const bloomOk = bloomSteps.every(s => [5, 10, 15].includes(s));
	console.log(`绽放步数: ${bloomSteps.join(',') || '无'}${bloomSteps.length ? (bloomOk ? ' (与5/10/15一致)' : ' (与5/10/15不一致)') : ''}`);
	console.log(`商店: 进店${shops.length}次, 出货${shopHits}次${shops.length ? `(${pct(shopHits, shops.length)})` : ''}, 库存命中${shops.filter(s => s.hit).length}/${stockViews}${stockViews ? `(${pct(shopHits, stockViews)})` : ''}`);
	console.log(`商店购买: 点击${shops.reduce((s, x) => s + (x.buyClicks || 0), 0)}次, 校验失败${shops.reduce((s, x) => s + (x.failures || 0), 0)}次, 刷新${by('shop.refresh').length}次, 无钱购买${by('shop.hit_no_money').length}次`);
	console.log(`唤息: ${huanxiEvents.length}次 ${huanxiEvents.length ? '(' + fmtCounts(huanxiEvents.reduce((o, e) => { inc(o, e.data.reason || '?'); return o; }, {})) + ')' : ''}`);
	console.log(`buff: 轰雷检测命中${leiCheckHit}/${leiChecks.length}, 扫描命中${scanLei}/${scans.length}, 刷新${by('buff.refresh').length}次`);
	console.log(`unknown: ${by('map.unknown').length}次, boss: ${by('boss.enter').length ? '已到达' : '未到达'}`);

	all.clear += runEnd && runEnd.data.result === 'clear' ? 1 : 0;
	if (runEnd && runEnd.data.seconds) all.durations.push(num(runEnd.data.seconds));
	all.leiSource[leiSource]++;
	if (leiStep) all.leiSteps.push(leiStep);
	if (powerReadyStep) all.powerSteps.push(powerReadyStep);
	all.shopEntries += shops.length;
	all.shopHits += shopHits;
	all.stockViews += stockViews;
	all.stockHits += shopHits;
	all.huanxi += huanxiEvents.length;
});

function pct(a, b) {
	return b ? `${(a * 100 / b).toFixed(1)}%` : '0%';
}
function fmtCounts(obj) {
	return Object.keys(obj).map(k => `${k}${obj[k]}`).join(' ') || '无';
}
function avg(arr) {
	return arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '-';
}

console.log(`\n===== 汇总 ${runs.length} 轮 =====`);
console.log(`通关: ${all.clear}/${runs.length}, 平均耗时: ${avg(all.durations)}s`);
console.log(`轰雷来源: buff=${all.leiSource.buff}, shop=${all.leiSource.shop}, 未获得=${all.leiSource.none}`);
console.log(`轰雷获得步数: ${all.leiSteps.join(',') || '-'} (平均 ${avg(all.leiSteps)})`);
console.log(`力量>=3步数: ${all.powerSteps.join(',') || '-'} (平均 ${avg(all.powerSteps)})`);
console.log(`商店: 进店${all.shopEntries}次, 出货${all.shopHits}次(${pct(all.shopHits, all.shopEntries)}), 库存命中${all.stockHits}/${all.stockViews}(${pct(all.stockHits, all.stockViews)})`);
console.log(`主动/单混沌唤息: ${all.huanxi}次`);
