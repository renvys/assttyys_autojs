import type { ImageDataLike } from './autoSelect';
import {
	D6_STEP_DIGIT_TEMPLATES,
	D6_STEP_DIGIT_W,
	D6_STEP_DIGIT_H,
} from './d6jueStepDigits';

/**
 * 识别主地图右上角「X回合后迎战迦摩天」里的橙色数字 X。
 *
 * 只做 0~9 的数字模板匹配，不走 OCR：
 *   1. 橙色阈值取数字笔画；
 *   2. 连通域 + 合并同一数字被阈值拆开的笔画；
 *   3. 每个数字归一化到 12x16 二值模板，和 0~9 模板做汉明距离；
 *   4. 返回 0~20 的 X，失败返回 null。
 *
 * 传入 image 是右上角数字区域的小截图。
 */
export interface D6StepCounterResult {
	value: number;
	digits: string;
	confidence: number;
}

interface Component {
	minx: number;
	maxx: number;
	miny: number;
	maxy: number;
	area: number;
}

const TEMPLATE_PIXELS = D6_STEP_DIGIT_W * D6_STEP_DIGIT_H;
const MAX_DIGIT_DIFF = 56;

function buildOrangeMask(image: ImageDataLike): Uint8Array {
	const W = image.width;
	const H = image.height;
	const mask = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const r = image.data[i];
			const g = image.data[i + 1];
			const b = image.data[i + 2];
			// 回合数字是偏橙的金色；白字和蓝色背景都会被排除
			if (r > 140 && g > 105 && b < 135 && r - b > 30 && g - b > 20) {
				mask[y * W + x] = 1;
			}
		}
	}
	return mask;
}

function findComponents(mask: Uint8Array, W: number, H: number): Component[] {
	const vis = new Uint8Array(W * H);
	const qx = new Int32Array(W * H);
	const qy = new Int32Array(W * H);
	const out: Component[] = [];
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const idx = y * W + x;
			if (!mask[idx] || vis[idx]) continue;
			let head = 0;
			let tail = 0;
			qx[tail] = x;
			qy[tail] = y;
			tail++;
			vis[idx] = 1;
			let minx = x;
			let maxx = x;
			let miny = y;
			let maxy = y;
			let area = 0;
			while (head < tail) {
				const cx = qx[head];
				const cy = qy[head];
				head++;
				area++;
				if (cx < minx) minx = cx;
				if (cx > maxx) maxx = cx;
				if (cy < miny) miny = cy;
				if (cy > maxy) maxy = cy;
				const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
				for (const [nx, ny] of neighbors) {
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const ni = ny * W + nx;
					if (!mask[ni] || vis[ni]) continue;
					vis[ni] = 1;
					qx[tail] = nx;
					qy[tail] = ny;
					tail++;
				}
			}
			out.push({ minx, maxx, miny, maxy, area });
		}
	}
	return out;
}

function mergeComponents(components: Component[], W: number, H: number): Component[] {
	const minArea = 6;
	const arr = components
		.filter(c => {
			const w = c.maxx - c.minx + 1;
			const h = c.maxy - c.miny + 1;
			return c.area >= minArea && w >= 2 && h >= 4 && h <= Math.max(18, H * 0.75);
		})
		.map(c => ({ ...c }));
	let changed = true;
	while (changed) {
		changed = false;
		outer:
		for (let i = 0; i < arr.length; i++) {
			for (let j = i + 1; j < arr.length; j++) {
				const a = arr[i];
				const b = arr[j];
				const overlapX = Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx) + 1;
				const gapX = Math.max(0, Math.max(a.minx, b.minx) - Math.min(a.maxx, b.maxx) - 1);
				const overlapY = Math.min(a.maxy, b.maxy) - Math.max(a.miny, b.miny) + 1;
				if ((overlapX > 0 || gapX <= 2) && overlapY > 0) {
					arr[i] = {
						minx: Math.min(a.minx, b.minx),
						maxx: Math.max(a.maxx, b.maxx),
						miny: Math.min(a.miny, b.miny),
						maxy: Math.max(a.maxy, b.maxy),
						area: a.area + b.area,
					};
					arr.splice(j, 1);
					changed = true;
					break outer;
				}
			}
		}
	}
	return arr.sort((a, b) => a.minx - b.minx);
}

function normalizeGlyph(mask: Uint8Array, W: number, b: Component): Uint8Array {
	const w = b.maxx - b.minx + 1;
	const h = b.maxy - b.miny + 1;
	const out = new Uint8Array(TEMPLATE_PIXELS);
	const scale = Math.min(D6_STEP_DIGIT_W / w, D6_STEP_DIGIT_H / h);
	const nw = Math.max(1, Math.round(w * scale));
	const nh = Math.max(1, Math.round(h * scale));
	const ox = Math.floor((D6_STEP_DIGIT_W - nw) / 2);
	const oy = Math.floor((D6_STEP_DIGIT_H - nh) / 2);
	for (let y = 0; y < nh; y++) {
		for (let x = 0; x < nw; x++) {
			const sx = b.minx + Math.floor(x * w / nw);
			const sy = b.miny + Math.floor(y * h / nh);
			if (mask[sy * W + sx]) out[(oy + y) * D6_STEP_DIGIT_W + (ox + x)] = 1;
		}
	}
	return out;
}

function templateDiff(glyph: Uint8Array, template: number[]): number {
	let diff = 0;
	for (let y = 0; y < D6_STEP_DIGIT_H; y++) {
		let row = 0;
		for (let x = 0; x < D6_STEP_DIGIT_W; x++) {
			if (glyph[y * D6_STEP_DIGIT_W + x]) row |= 1 << x;
		}
		let v = row ^ (template[y] || 0);
		while (v) {
			diff += v & 1;
			v >>>= 1;
		}
	}
	return diff;
}

function recognizeDigit(glyph: Uint8Array): { digit: string; diff: number } | null {
	let best: { digit: string; diff: number } | null = null;
	for (const digit of Object.keys(D6_STEP_DIGIT_TEMPLATES)) {
		for (const template of D6_STEP_DIGIT_TEMPLATES[digit]) {
			const diff = templateDiff(glyph, template);
			if (!best || diff < best.diff) best = { digit, diff };
		}
	}
	if (!best || best.diff > MAX_DIGIT_DIFF) return null;
	return best;
}

export function recognizeD6StepCounter(image: ImageDataLike): D6StepCounterResult | null {
	if (!image || image.width < 8 || image.height < 8) return null;
	const mask = buildOrangeMask(image);
	const comps = mergeComponents(findComponents(mask, image.width, image.height), image.width, image.height);
	// 回合数只有 1~2 位；多出来的通常是背景橙色装饰，直接放弃本次读数。
	if (comps.length < 1 || comps.length > 2) return null;

	const glyphs = comps.map(c => normalizeGlyph(mask, image.width, c));
	const digits = glyphs.map(g => recognizeDigit(g));
	if (digits.some(d => !d)) return null;

	let text = '';
	let totalDiff = 0;
	for (const d of digits) {
		if (!d) return null;
		text += d.digit;
		totalDiff += d.diff;
	}
	const value = parseInt(text, 10);
	if (isNaN(value) || value < 0 || value > 20) return null;
	return {
		value,
		digits: text,
		confidence: 1 - totalDiff / (TEMPLATE_PIXELS * glyphs.length),
	};
}
