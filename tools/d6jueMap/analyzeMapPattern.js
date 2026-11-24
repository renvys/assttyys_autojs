#!/usr/bin/env node
/**
 * 分析六道觉主地图的规律性：每轮 20 步的行结构、节点类型、选择位，
 * 以及“选择分支是否影响下一行”。
 *
 * 用法：
 *   node tools/d6jueMap/analyzeMapPattern.js <log1> [log2 ...]
 */

const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) {
	console.log('用法: node tools/d6jueMap/analyzeMapPattern.js <d6jue_analysis.log> [...]');
	process.exit(1);
}

const lineRe = /^\[([^\]]+)\]\s+run=(\d+)\s+([a-zA-Z._]+)(?:\s+(.*))?$/;
const runMap = new Map();

for (const file of files) {
	const text = fs.readFileSync(path.resolve(file), 'utf8');
	for (const raw of text.split(/\r?\n/)) {
		const m = lineRe.exec(raw.trim());
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
}

const runs = Array.from(runMap.values()).sort((a, b) => a.firstTs.localeCompare(b.firstTs));
const num = v => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};
const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
const pct = (a, b) => (b ? `${(a * 100 / b).toFixed(1)}%` : '0%');
const fmtCounts = (obj, total) => Object.keys(obj)
	.sort((a, b) => obj[b] - obj[a])
	.map(k => `${k} ${obj[k]}${total ? `(${pct(obj[k], total)})` : ''}`)
	.join(', ') || '无';

// 每轮：按 step 去重（重试会重复记录同一步），保留最后一次点击（真正推进的那次）
const runRows = [];
for (const run of runs) {
	const ver = (run.events.find(e => e.event === 'run.start') || { data: {} }).data.ver || '';
	const end = run.events.filter(e => e.event === 'run.end').slice(-1)[0];
	const rowByStep = new Map();
	for (const e of run.events) {
		if (e.event !== 'map.step') continue;
		const step = num(e.data.step);
		if (step < 1 || step > 20) continue;
		rowByStep.set(step, e);
	}
	if (rowByStep.size === 0) continue;
	const rows = [];
	for (const step of Array.from(rowByStep.keys()).sort((a, b) => a - b)) {
		const e = rowByStep.get(step);
		rows.push({
			step,
			left: num(e.data.left),
			nodes: (e.data.nodes || '').split('/').filter(Boolean),
			target: e.data.target || '?',
			slot: e.data.slot || '?',
			seq: e.data.seq,
			lei: num(e.data.lei),
			power: num(e.data.power),
			wallet: num(e.data.wallet),
			mode: e.data.mode || '',
		});
	}
	runRows.push({
		id: run.id,
		firstTs: run.firstTs,
		ver,
		result: end ? end.data.result : '未结束',
		rows,
		stepCount: rows.length,
	});
}

if (!runRows.length) {
	console.log('没有解析到 map.step 日志。');
	process.exit(1);
}

console.log(`日志文件: ${files.join(', ')}`);
console.log(`含地图点击的轮次: ${runRows.length}`);
console.log(`版本: ${Array.from(new Set(runRows.map(r => r.ver || '(未记录)'))).join(' | ')}`);

// ---- 1. 每轮行数与步号连续性 ----
let fullRuns = 0;
const stepCountDist = {};
const missingStepDist = {};
for (const run of runRows) {
	inc(stepCountDist, run.stepCount);
	if (run.stepCount === 20) fullRuns++;
	const got = new Set(run.rows.map(r => r.step));
	const missing = [];
	for (let s = 1; s <= 20; s++) if (!got.has(s)) missing.push(s);
	if (missing.length) inc(missingStepDist, missing.join(','));
}
console.log(`\n===== 1. 行数/步号 =====`);
console.log(`完整 20 行: ${fullRuns}/${runRows.length} (${pct(fullRuns, runRows.length)})`);
console.log(`每轮行数分布: ${fmtCounts(stepCountDist, runRows.length)}`);
if (Object.keys(missingStepDist).length) {
	console.log(`缺步行: ${fmtCounts(missingStepDist, runRows.length)}`);
}

// ---- 2. 每步的行形状（节点个数与选择位） ----
console.log(`\n===== 2. 每步行形状（节点数 / 选择位） =====`);
const countByStep = Array.from({ length: 21 }, () => ({}));
const slotByStep = Array.from({ length: 21 }, () => ({}));
const stepPresence = Array.from({ length: 21 }, () => 0);
for (const run of runRows) {
	for (const row of run.rows) {
		stepPresence[row.step]++;
		inc(countByStep[row.step], row.nodes.length);
		inc(slotByStep[row.step], row.slot);
	}
}
console.log('步  行数  节点数(占比)                         选择位(占比)');
for (let s = 1; s <= 20; s++) {
	const total = stepPresence[s];
	if (!total) continue;
	console.log(`${String(s).padStart(2)}  ${String(total).padStart(4)}  ${fmtCounts(countByStep[s], total).padEnd(38)} ${fmtCounts(slotByStep[s], total)}`);
}

// ---- 3. 每步节点组合的稳定性 ----
console.log(`\n===== 3. 每步节点组合（是否每次相同） =====`);
const nodesByStep = Array.from({ length: 21 }, () => ({}));
for (const run of runRows) {
	for (const row of run.rows) inc(nodesByStep[row.step], row.nodes.join('/'));
}
console.log('步  行数  不同组合数  最常见组合（占比）');
for (let s = 1; s <= 20; s++) {
	const total = stepPresence[s];
	if (!total) continue;
	const dist = nodesByStep[s];
	const keys = Object.keys(dist);
	const top = keys.sort((a, b) => dist[b] - dist[a])[0];
	console.log(`${String(s).padStart(2)}  ${String(total).padStart(4)}  ${String(keys.length).padStart(6)}      ${top} ${dist[top]}(${pct(dist[top], total)})`);
}

// ---- 4. 绽放位置 ----
console.log(`\n===== 4. 绽放出现位置 =====`);
const bloomSteps = {};
const bloomRowSets = {};
let bloomRuns = 0;
for (const run of runRows) {
	const steps = run.rows.filter(r => r.nodes.includes('绽放')).map(r => r.step);
	if (!steps.length) continue;
	bloomRuns++;
	for (const s of steps) inc(bloomSteps, s);
}
for (const run of runRows) {
	const bloomRows = run.rows.filter(r => r.nodes.includes('绽放'));
	if (bloomRows.length) inc(bloomRowSets, bloomRows.map(r => r.step).join(','));
}
console.log(`含绽放的轮次: ${bloomRuns}/${runRows.length}`);
console.log(`绽放步号分布: ${fmtCounts(bloomSteps, bloomRuns)}`);
console.log(`每轮绽放步号集合: ${fmtCounts(bloomRowSets, bloomRuns)}`);

// ---- 5. 宁息出现位置 ----
console.log(`\n===== 5. 宁息出现位置 =====`);
const shopSteps = {};
let shopRuns = 0;
const shopPerRun = {};
for (const run of runRows) {
	const steps = run.rows.filter(r => r.nodes.includes('宁息')).map(r => r.step);
	if (!steps.length) continue;
	shopRuns++;
	inc(shopPerRun, steps.length);
	inc(shopSteps, steps.join(','));
}
console.log(`含宁息的轮次: ${shopRuns}/${runRows.length}`);
console.log(`每轮宁息数量: ${fmtCounts(shopPerRun, shopRuns)}`);
console.log(`宁息步号集合(前12): ${Object.keys(shopSteps).sort((a, b) => shopSteps[b] - shopSteps[a]).slice(0, 12).map(k => `${k}×${shopSteps[k]}`).join('  ')}`);

// ---- 6. 每步节点类型频率 ----
console.log(`\n===== 6. 每步节点类型频率（行内出现） =====`);
const typeByStep = Array.from({ length: 21 }, () => ({}));
for (const run of runRows) {
	for (const row of run.rows) {
		for (const t of new Set(row.nodes)) inc(typeByStep[row.step], t);
	}
}
const types = ['绽放', '宁息', '神秘', '鏖战', '混沌'];
console.log(`步  样本   ${types.join('  ')}`);
for (let s = 1; s <= 20; s++) {
	const total = stepPresence[s];
	if (!total) continue;
	const cells = types.map(t => `${String(typeByStep[s][t] || 0).padStart(3)}(${pct(typeByStep[s][t] || 0, total).padStart(5)})`);
	console.log(`${String(s).padStart(2)}  ${String(total).padStart(4)}   ${cells.join(' ')}`);
}

// ---- 7. 选择分支是否影响下一行 ----
console.log(`\n===== 7. 分支选择与下一行（验证地图是随机序列还是分支图） =====`);
const trans = {};
let transSamples = 0;
for (const run of runRows) {
	for (let i = 0; i < run.rows.length; i++) {
		const row = run.rows[i];
		const next = run.rows.find(r => r.step === row.step + 1);
		if (!next || row.nodes.length < 2) continue;
		transSamples++;
		const key = `第${row.step}步[${row.nodes.join('/')}] 选${row.target}(${row.slot})`;
		if (!trans[key]) trans[key] = {};
		inc(trans[key], next.nodes.join('/'));
	}
}
console.log(`多节点行样本: ${transSamples}`);
for (const key of Object.keys(trans).sort()) {
	const dist = trans[key];
	const total = Object.values(dist).reduce((a, b) => a + b, 0);
	console.log(`${key} -> ${fmtCounts(dist, total)}`);
}

// ---- 8. 每轮地图序列打印（最近 12 轮，便于人工查看） ----
console.log(`\n===== 8. 最近轮次的地图序列 =====`);
const recent = runRows.slice(-12);
for (const run of recent) {
	console.log(`\nrun=${run.id} (${run.firstTs}, ${run.result}, ${run.stepCount}行)`);
	for (const r of run.rows) {
		console.log(`  ${String(r.step).padStart(2)}: ${r.nodes.join('/').padEnd(16)} 选${r.target}@${r.slot.padEnd(12)} lei=${r.lei} power=${r.power} wallet=${r.wallet}`);
	}
}

// ---- 9. 组合级统计：同一行集合在多少轮出现 ----
console.log(`\n===== 9. 行内节点数组合（全地图形状） =====`);
const shapes = {};
for (const run of runRows) {
	const shape = run.rows.map(r => r.nodes.length).join('');
	inc(shapes, shape);
}
console.log(`每轮 20 行节点数拼接分布: ${fmtCounts(shapes, runRows.length)}`);
