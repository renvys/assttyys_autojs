import type { ImageDataLike } from './autoSelect';

/**
 * 主场景岛屿横幅锚点。
 *
 * 只使用画面特征，不做 OCR：
 *   - 岛屿名字是竖排白字，带深色描边/半透明深色底；
 *   - 名字上方可能有金色/红色徽章，本模块不依赖徽章；
 *   - 取“最下面一段白色文字”的中心作为点击锚点，避开上方徽章和鬼角。
 *
 * 传入的 image 已经是目标选择位扩区后的截图，slotCenter 是选择位中心在
 * 该图中的局部坐标（开发分辨率 1280x720 下）。
 */
export interface D6BannerAnchor {
	/** 点击锚点（局部坐标） */
	x: number;
	y: number;
	/** 文字段宽高 */
	w: number;
	h: number;
	/** 匹配打分，仅用于日志 */
	score: number;
	/** 最下面一段文字的包围盒 [x1, y1, x2, y2] */
	textBox: [number, number, number, number];
}

/** 把屏幕分辨率截图缩到接近 1280x720，复用离线调好的阈值。 */
export function downsampleD6BannerImage(image: ImageDataLike, factor: number): ImageDataLike {
	if (!(factor > 1.001)) return image;
	const w = Math.max(1, Math.floor(image.width / factor));
	const h = Math.max(1, Math.floor(image.height / factor));
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const sy0 = Math.floor(y * factor);
		const sy1 = Math.min(image.height, Math.max(sy0 + 1, Math.floor((y + 1) * factor)));
		for (let x = 0; x < w; x++) {
			const sx0 = Math.floor(x * factor);
			const sx1 = Math.min(image.width, Math.max(sx0 + 1, Math.floor((x + 1) * factor)));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				for (let sx = sx0; sx < sx1; sx++) {
					const k = (sy * image.width + sx) * 4;
					r += image.data[k];
					g += image.data[k + 1];
					b += image.data[k + 2];
					a += image.data[k + 3];
					n++;
				}
			}
			const d = (y * w + x) * 4;
			if (n > 0) {
				data[d] = r / n;
				data[d + 1] = g / n;
				data[d + 2] = b / n;
				data[d + 3] = a / n;
			}
		}
	}
	return { width: w, height: h, data };
}

export function detectD6BannerAnchor(image: ImageDataLike, slotCenter: [number, number]): D6BannerAnchor | null {
	const W = image.width;
	const H = image.height;
	if (W < 20 || H < 20) return null;

	const bright = new Uint8Array(W * H);
	const dark = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const k = (y * W + x) * 4;
			const r = image.data[k];
			const g = image.data[k + 1];
			const b = image.data[k + 2];
			const l = 0.299 * r + 0.587 * g + 0.114 * b;
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			const idx = y * W + x;
			// 白字要求足够亮且接近中性白；雪地偏蓝，饱和度稍高
			bright[idx] = l >= 175 && max - min <= 48 ? 1 : 0;
			// 深色描边/半透明底
			dark[idx] = l <= 118 ? 1 : 0;
		}
	}

	// 深色像素积分图，用于快速统计 7x7 邻域
	const iw = W + 1;
	const integral = new Int32Array(iw * (H + 1));
	for (let y = 0; y < H; y++) {
		let rowSum = 0;
		for (let x = 0; x < W; x++) {
			rowSum += dark[y * W + x];
			integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
		}
	}
	const darkCount = (cx: number, cy: number, radius: number) => {
		const ax = Math.max(0, cx - radius);
		const ay = Math.max(0, cy - radius);
		const bx = Math.min(W - 1, cx + radius);
		const by = Math.min(H - 1, cy + radius);
		return integral[(by + 1) * iw + (bx + 1)]
			- integral[ay * iw + (bx + 1)]
			- integral[(by + 1) * iw + ax]
			+ integral[ay * iw + ax];
	};

	// 只保留“白字且周围有深色描边”的像素
	const mask = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const idx = y * W + x;
			if (bright[idx] && darkCount(x, y, 3) >= 3) mask[idx] = 1;
		}
	}

	// 8 邻域连通域
	const vis = new Uint8Array(W * H);
	const qx = new Int32Array(W * H);
	const qy = new Int32Array(W * H);
	const comps: Array<{ minx: number; maxx: number; miny: number; maxy: number; w: number; h: number; area: number }> = [];
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
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = cx + dx;
						const ny = cy + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const ni = ny * W + nx;
						if (!mask[ni] || vis[ni]) continue;
						vis[ni] = 1;
						qx[tail] = nx;
						qy[tail] = ny;
						tail++;
					}
				}
			}
			const w = maxx - minx + 1;
			const h = maxy - miny + 1;
			if (area < 10 || w > 55 || h > 110) continue;
			comps.push({ minx, maxx, miny, maxy, w, h, area });
		}
	}
	if (!comps.length) return null;

	// 同一字符的笔画、以及上下相邻字符合并成竖排文字块
	const blocks = comps.map(c => ({ ...c }));
	let merged = true;
	while (merged) {
		merged = false;
		outer:
		for (let i = 0; i < blocks.length; i++) {
			for (let j = i + 1; j < blocks.length; j++) {
				const a = blocks[i];
				const b = blocks[j];
				const acx = (a.minx + a.maxx) / 2;
				const bcx = (b.minx + b.maxx) / 2;
				const overlap = Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx) + 1;
				const minW = Math.min(a.w, b.w);
				const gapY = Math.max(0, Math.max(a.miny, b.miny) - Math.min(a.maxy, b.maxy) - 1);
				const widthRatio = Math.max(a.w, b.w) / Math.max(1, minW);
				const aligned = overlap >= minW * 0.3 || Math.abs(acx - bcx) <= 12;
				if (!aligned || gapY > 20 || widthRatio > 2.6) continue;
				const n = {
					minx: Math.min(a.minx, b.minx),
					maxx: Math.max(a.maxx, b.maxx),
					miny: Math.min(a.miny, b.miny),
					maxy: Math.max(a.maxy, b.maxy),
					area: a.area + b.area,
					w: 0,
					h: 0,
				};
				n.w = n.maxx - n.minx + 1;
				n.h = n.maxy - n.miny + 1;
				blocks.splice(j, 1);
				blocks[i] = n;
				merged = true;
				break outer;
			}
		}
	}

	// 过滤：竖排、窄、够高；过矮的可能是单个字/徽章
	const candidates: Array<{
		minx: number; maxx: number; miny: number; maxy: number; w: number; h: number; area: number;
		cx: number; cy: number; aspect: number; fill: number; dist: number; score: number;
	}> = [];
	for (const b of blocks) {
		if (b.w < 8 || b.w > 60 || b.h < 28 || b.h > 220) continue;
		const aspect = b.h / b.w;
		if (aspect < 1.15) continue;
		const fill = b.area / (b.w * b.h);
		if (fill < 0.12) continue;
		const cx = (b.minx + b.maxx) / 2;
		const cy = (b.miny + b.maxy) / 2;
		const ddx = cx - slotCenter[0];
		const ddy = cy - slotCenter[1];
		const dist = Math.sqrt(ddx * ddx + ddy * ddy);
		const score = b.area * Math.min(2.5, aspect) * (0.6 + fill);
		candidates.push({ ...b, cx, cy, aspect, fill, dist, score });
	}
	if (!candidates.length) return null;

	// 横幅一般在选择位附近；用距离做轻微惩罚，避免命中远处的 UI 文字
	candidates.sort((a, b) => {
		const sa = a.score / (1 + a.dist / 55);
		const sb = b.score / (1 + b.dist / 55);
		return sb - sa;
	});
	const best = candidates[0];

	// 在合并块内找“最下面的一段白色文字行”，避开上方徽章/鬼角。
	const rows: Array<{ y: number; count: number; minx: number; maxx: number }> = [];
	for (let y = best.miny; y <= best.maxy; y++) {
		let count = 0;
		let minx = W;
		let maxx = -1;
		for (let x = best.minx; x <= best.maxx; x++) {
			if (!mask[y * W + x]) continue;
			count++;
			if (x < minx) minx = x;
			if (x > maxx) maxx = x;
		}
		rows.push({ y, count, minx, maxx });
	}
	const runs: Array<{ miny: number; maxy: number; minx: number; maxx: number; white: number }> = [];
	let run: { miny: number; maxy: number; minx: number; maxx: number; white: number } | null = null;
	for (const row of rows) {
		const good = row.count >= 2 && row.maxx - row.minx + 1 >= 6;
		if (!good) {
			if (run) {
				runs.push(run);
				run = null;
			}
			continue;
		}
		if (!run) {
			run = { miny: row.y, maxy: row.y, minx: row.minx, maxx: row.maxx, white: row.count };
		} else {
			run.maxy = row.y;
			run.minx = Math.min(run.minx, row.minx);
			run.maxx = Math.max(run.maxx, row.maxx);
			run.white += row.count;
		}
	}
	if (run) runs.push(run);

	const textRuns = runs.filter(r => {
		const rw = r.maxx - r.minx + 1;
		const rh = r.maxy - r.miny + 1;
		return rh >= 14 && rw >= 8 && r.white >= 14;
	});
	if (!textRuns.length) return null;

	// 取最下面的一段（名字最后一个字）；若最后一段太矮，向上合并一段
	textRuns.sort((a, b) => b.maxy - a.maxy);
	let text = textRuns[0];
	for (let i = 1; i < textRuns.length; i++) {
		const r = textRuns[i];
		const gap = text.miny - r.maxy - 1;
		if (gap <= 4 && text.maxy - r.miny + 1 <= 110) {
			text = {
				minx: Math.min(text.minx, r.minx),
				maxx: Math.max(text.maxx, r.maxx),
				miny: r.miny,
				maxy: text.maxy,
				white: text.white + r.white,
			};
		}
	}
	const textW = text.maxx - text.minx + 1;
	const textH = text.maxy - text.miny + 1;
	return {
		x: (text.minx + text.maxx) / 2,
		y: (text.miny + text.maxy) / 2,
		w: textW,
		h: textH,
		score: best.score,
		textBox: [text.minx, text.miny, text.maxx, text.maxy],
	};
}
