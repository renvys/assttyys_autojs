#!/usr/bin/env node
/**
 * 解析六道觉分析日志（d6jue_analysis.log），输出每轮与汇总统计。
 *
 * 用法：
 *   node tools/d6jueMap/analyzeLog.js d6jue_analysis.log
 *
 * 日志由 src/common/d6jueAnalysisLog.ts 写入，格式：
 *   === d6jue analysis session <ISO时间> ver=<策略版本> ===
 *   [ISO时间] run=<runId> <event> key=value ...
 *
 * 版本号优先取 run.start 的 ver=，没有时回退到最近一条 session 头。
 * 版本常量维护在 src/common/d6jueVersion.ts。
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
const sessionRe = /^===\s+d6jue analysis session\s+(\S+)(?:\s+ver=(\S+))?\s+===$/;
const runMap = new Map();
let sessionVer = '';

for (const raw of text.split(/\r?\n/)) {
	const line = raw.trim();
	const sm = sessionRe.exec(line);
	if (sm) {
		sessionVer = sm[2] || '';
		continue;
	}
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
	if (!runMap.has(runId)) runMap.set(runId, { id: runId, firstTs: ts, ver: sessionVer, events: [] });
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
	mapClicks: 0,
	mapConfirms: 0,
	mapRetries: 0,
	anchorBanner: 0,
	anchorFixed: 0,
	anchorMs: [],
	counterReads: 0,
	counterMiss: 0,
	counterReject: 0,
	counterRecover: 0,
	counterWaits: 0,
	stepCalibrates: 0,
	stepAlerts: 0,
	stepConfirmReasons: {},
	ocrCount: 0,
	ocrBad: 0,
	ocrMax: 0,
	ocrSyncs: 0,
	ocrSyncMax: 0,
	ocrReadErrors: 0,
	costChecks: 0,
	costVerified: 0,
	huanxiConfirm: 0,
	huanxiUnverified: 0,
	battleFail: 0,
	bossTimeout: 0,
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
	const bloomSeen = {};
	let powerReadyStep = 0;

	for (const e of mapSteps) {
		inc(targets, e.data.target || '?');
		const nodes = (e.data.nodes || '').split('/').filter(Boolean);
		for (const n of nodes) inc(nodeCounts, n);
		if (nodes.includes('绽放')) {
			const step = num(e.data.step);
			if (!bloomSeen[step]) {
				bloomSeen[step] = true;
				bloomSteps.push(step);
			}
		}
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
	const runVer = (runStart && runStart.data.ver) || run.ver || '';
	if (runVer) console.log(`版本: ${runVer}`);
	const confirmedSteps = by('map.step_confirm').length;
	const confirmReasons = by('map.step_confirm').reduce((o, e) => {
		inc(o, e.data.reason || 'legacy');
		return o;
	}, {});
	const stepCalibrates = by('step.calibrate');
	const stepAlerts = by('step.alert');
	const counterWaits = by('map.counter_wait');
	const retryEvents = by('map.step_retry');
	const retryGap = retryEvents.length
		? (retryEvents.reduce((s, e) => s + num(e.data.gap), 0) / retryEvents.length / 1000).toFixed(1)
		: '-';
	const maxStep = mapSteps.reduce((m, e) => Math.max(m, num(e.data.step)), 0);
	console.log(`步数: 第${maxStep}步, 点击${mapSteps.length}次, 确认${confirmedSteps}次, 重试${retryEvents.length}次(平均${retryGap}s), 最终力量=${finalPower}, 轰雷=${finalLei}, 万相铃=${finalWallet}`);
	if (confirmedSteps || stepCalibrates.length || stepAlerts.length) {
		console.log(`步数确认: ${fmtCounts(confirmReasons)}; 校准${stepCalibrates.length}次, 告警${stepAlerts.length}次`);
	}
	const anchorBannerSteps = mapSteps.filter(e => e.data.anchor === 'banner');
	const anchorFixedSteps = mapSteps.filter(e => e.data.anchor === 'fixed');
	const anchorTimes = mapSteps.map(e => num(e.data.anchorMs)).filter(v => v > 0);
	if (anchorBannerSteps.length || anchorFixedSteps.length) {
		console.log(`主地图锚点: 横幅${anchorBannerSteps.length}次, 固定${anchorFixedSteps.length}次, 检测平均${avg(anchorTimes)}ms`);
	}
	const counterEvents = by('map.counter');
	const counterMiss = by('map.counter_miss');
	const counterReject = by('map.counter_reject');
	const counterRecover = by('map.counter_recover');
	if (counterEvents.length || counterMiss.length || counterReject.length || counterRecover.length || counterWaits.length) {
		console.log(`回合读数: 成功${counterEvents.length}次, 失败${counterMiss.length}次, 拒绝${counterReject.length}次, 待确认${counterWaits.length}次, 恢复${counterRecover.length}次`);
	}
	console.log(`轰雷获取: ${leiSource === 'none' ? '未获得' : `${leiSource} @第${leiStep}步`}`);
	console.log(`力量>=3: ${powerReadyStep ? `第${powerReadyStep}步` : '未达到'}`);
	console.log(`目标分布: ${fmtCounts(targets)}`);
	console.log(`节点出现: ${fmtCounts(nodeCounts)}`);
	const bloomOk = bloomSteps.every(s => [5, 10, 15, 20].includes(s));
	console.log(`绽放步数: ${bloomSteps.join(',') || '无'}${bloomSteps.length ? (bloomOk ? ' (与5/10/15/20一致)' : ' (与5/10/15/20不一致)') : ''}`);
	console.log(`商店: 进店${shops.length}次, 出货${shopHits}次${shops.length ? `(${pct(shopHits, shops.length)})` : ''}, 库存命中${shops.filter(s => s.hit).length}/${stockViews}${stockViews ? `(${pct(shopHits, stockViews)})` : ''}`);
	console.log(`商店购买: 点击${shops.reduce((s, x) => s + (x.buyClicks || 0), 0)}次, 校验失败${shops.reduce((s, x) => s + (x.failures || 0), 0)}次, 刷新${by('shop.refresh').length}次, 无钱购买${by('shop.hit_no_money').length}次`);
	const ocrEvents = by('wallet.ocr');
	const ocrAccounting = ocrEvents.filter(e => e.data.ocr !== '?' && Math.abs(num(e.data.diff)) <= 500);
	const ocrDiffs = ocrAccounting.map(e => num(e.data.diff)).filter(v => v !== 0);
	const ocrReadErrors = ocrEvents.length - ocrAccounting.length;
	const maxOcrDiff = ocrDiffs.length ? Math.max(...ocrDiffs.map(v => Math.abs(v))) : 0;
	const syncEvents = by('wallet.sync');
	const syncDeltas = syncEvents.map(e => num(e.data.delta)).filter(v => v !== 0);
	const maxSync = syncDeltas.length ? Math.max(...syncDeltas.map(v => Math.abs(v))) : 0;
	console.log(`万相铃OCR: ${ocrEvents.length}次, 记账偏差${ocrDiffs.length}次, 最大偏差=${maxOcrDiff}, 读取异常${ocrReadErrors}次, OCR校准${syncDeltas.length}次(最大=${maxSync})${ocrDiffs.length ? ` (${ocrDiffs.slice(0, 8).join(',')}${ocrDiffs.length > 8 ? '...' : ''})` : ''}`);
	const costChecks = by('wallet.cost_check');
	const costOk = costChecks.filter(e => e.data.verified === '1').length;
	if (costChecks.length) {
		console.log(`刷新费用校验: ${costChecks.length}次, 通过${costOk}, 未通过${costChecks.length - costOk}`);
	}
	let lastPickInfo = null;
	const ocrSources = [];
	for (const e of ev) {
		if (e.event === 'buff.pick') {
			lastPickInfo = { name: e.data.name, pos: e.data.pos, island: e.data.island, step: e.data.step };
		} else if (e.event === 'skill.pick') {
			lastPickInfo = { name: '舞技强化', pos: '', island: e.data.island, step: e.data.step };
		} else if (e.event === 'wallet.ocr') {
			const diff = num(e.data.diff);
			if (e.data.ocr !== '?' && diff !== 0) {
				const src = lastPickInfo ? `${lastPickInfo.name}@${lastPickInfo.island || ('step' + lastPickInfo.step)}` : '无选buff';
				ocrSources.push(`${diff > 0 ? '+' : ''}${diff}(${src})`);
			}
			lastPickInfo = null;
		}
	}
	if (ocrSources.length) console.log(`OCR偏差来源: ${ocrSources.slice(0, 8).join(' ')}${ocrSources.length > 8 ? '...' : ''}`);
	console.log(`战斗失败: ${by('battle.fail').length}次, 首领超时: ${by('boss.timeout').length}次`);
	const huanxiConfirm = by('map.huanxi_confirm').length;
	const huanxiUnverified = by('map.huanxi_unverified').length;
	console.log(`唤息: ${huanxiEvents.length}次 ${huanxiEvents.length ? '(' + fmtCounts(huanxiEvents.reduce((o, e) => { inc(o, e.data.reason || '?'); return o; }, {})) + ')' : ''}, 费用确认${huanxiConfirm}次, 未确认${huanxiUnverified}次`);
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
	all.mapClicks += mapSteps.length;
	all.mapConfirms += confirmedSteps;
	all.mapRetries += retryEvents.length;
	all.anchorBanner += anchorBannerSteps.length;
	all.anchorFixed += anchorFixedSteps.length;
	all.anchorMs.push(...anchorTimes);
	all.counterReads += counterEvents.length;
	all.counterMiss += counterMiss.length;
	all.counterReject += counterReject.length;
	all.counterRecover += counterRecover.length;
	all.counterWaits += counterWaits.length;
	all.stepCalibrates += stepCalibrates.length;
	all.stepAlerts += stepAlerts.length;
	for (const key of Object.keys(confirmReasons)) inc(all.stepConfirmReasons, key);
	all.ocrCount += ocrEvents.length;
	all.ocrBad += ocrDiffs.length;
	all.ocrSyncs += syncDeltas.length;
	all.ocrReadErrors += ocrReadErrors;
	all.costChecks += costChecks.length;
	all.costVerified += costOk;
	all.huanxiConfirm += huanxiConfirm;
	all.huanxiUnverified += huanxiUnverified;
	for (const v of ocrDiffs) all.ocrMax = Math.max(all.ocrMax, Math.abs(v));
	for (const v of syncDeltas) all.ocrSyncMax = Math.max(all.ocrSyncMax, Math.abs(v));
	all.battleFail += by('battle.fail').length;
	all.bossTimeout += by('boss.timeout').length;
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
console.log(`地图点击: 点击${all.mapClicks}次, 确认${all.mapConfirms}次, 重试${all.mapRetries}次(${pct(all.mapRetries, all.mapClicks)})`);
if (all.anchorBanner || all.anchorFixed) {
	console.log(`主地图锚点: 横幅${all.anchorBanner}次, 固定${all.anchorFixed}次, 检测平均${avg(all.anchorMs)}ms`);
}
if (all.counterReads || all.counterMiss || all.counterReject || all.counterRecover || all.counterWaits) {
	console.log(`回合读数: 成功${all.counterReads}次, 失败${all.counterMiss}次, 拒绝${all.counterReject}次, 待确认${all.counterWaits}次, 恢复${all.counterRecover}次`);
}
if (Object.keys(all.stepConfirmReasons).length || all.stepCalibrates || all.stepAlerts) {
	console.log(`步数确认来源: ${fmtCounts(all.stepConfirmReasons) || '无'}; 校准${all.stepCalibrates}次, 告警${all.stepAlerts}次`);
}
console.log(`万相铃OCR: ${all.ocrCount}次, 记账偏差${all.ocrBad}次, 最大偏差=${all.ocrMax}, 读取异常${all.ocrReadErrors}次, OCR校准${all.ocrSyncs}次(最大=${all.ocrSyncMax})`);
console.log(`刷新费用校验: ${all.costChecks}次, 通过${all.costVerified}, 未通过${all.costChecks - all.costVerified}`);
console.log(`唤息费用确认: ${all.huanxiConfirm}次, 未确认${all.huanxiUnverified}次`);
console.log(`战斗失败: ${all.battleFail}次, 首领超时: ${all.bossTimeout}次`);
console.log(`主动/单混沌唤息: ${all.huanxi}次`);
