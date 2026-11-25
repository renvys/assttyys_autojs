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
}

/** 把屏幕分辨率截图缩到接近 1280x720，复用离线调好的阈值。 */
export function downsampleD6BannerImage(image: ImageDataLike, factor: number): ImageDataLike {
	if (!(factor > 1.001)) return image;
	const srcW = image.width;
	const srcH = image.height;
	const src = image.data;
	const w = Math.max(1, Math.floor(srcW / factor));
	const h = Math.max(1, Math.floor(srcH / factor));
	const data = new Uint8ClampedArray(w * h * 4);
	// 预计算 x 方向映射，避免内层循环重复调用 Math.floor/min/max
	const sx0Map = new Int32Array(w);
	const sx1Map = new Int32Array(w);
	for (let x = 0; x < w; x++) {
		const s0 = Math.floor(x * factor);
		let s1 = Math.floor((x + 1) * factor);
		if (s1 <= s0) s1 = s0 + 1;
		if (s1 > srcW) s1 = srcW;
		sx0Map[x] = s0;
		sx1Map[x] = s1;
	}
	for (let y = 0; y < h; y++) {
		const sy0 = Math.floor(y * factor);
		let sy1 = Math.floor((y + 1) * factor);
		if (sy1 <= sy0) sy1 = sy0 + 1;
		if (sy1 > srcH) sy1 = srcH;
		const dstRow = y * w;
		for (let x = 0; x < w; x++) {
			const sx0 = sx0Map[x];
			const sx1 = sx1Map[x];
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				let k = (sy * srcW + sx0) * 4;
				for (let sx = sx0; sx < sx1; sx++) {
					r += src[k];
					g += src[k + 1];
					b += src[k + 2];
					a += src[k + 3];
					k += 4;
					n++;
				}
			}
			const d = (dstRow + x) * 4;
			if (n > 0) {
				const inv = 1 / n;
				data[d] = r * inv;
				data[d + 1] = g * inv;
				data[d + 2] = b * inv;
				data[d + 3] = a * inv;
			}
		}
	}
	return { width: w, height: h, data };
}

export function detectD6BannerAnchor(image: ImageDataLike, slotCenter: [number, number]): D6BannerAnchor | null {
	const W = image.width;
	const H = image.height;
	if (W < 20 || H < 20) return null;

	const data = image.data;
	const total = W * H;
	const iw = W + 1;
	// 单遍融合：计算白字稀疏表 + 深色像素积分图（省掉 dark 数组、第二遍全图遍历与 11 万次 Math.max/min）
	const integral = new Int32Array(iw * (H + 1));
	const brightX = new Int16Array(total);
	const brightY = new Int16Array(total);
	let brightCount = 0;
	let k = 0;
	for (let y = 0; y < H; y++) {
		let rowSum = 0;
		const prevIntRow = y * iw;
		const curIntRow = prevIntRow + iw;
		for (let x = 0; x < W; x++) {
			const r = data[k];
			const g = data[k + 1];
			const b = data[k + 2];
			k += 4;
			const l1000 = 299 * r + 587 * g + 114 * b;
			if (l1000 <= 118000) {
				rowSum++;
			} else if (l1000 >= 175000) {
				let max = r;
				let min = r;
				if (g > max) max = g;
				else if (g < min) min = g;
				if (b > max) max = b;
				else if (b < min) min = b;
				// 白字要求足够亮且接近中性白；雪地偏蓝，饱和度稍高
				if (max - min <= 48) {
					brightX[brightCount] = x;
					brightY[brightCount] = y;
					brightCount++;
				}
			}
			integral[curIntRow + x + 1] = integral[prevIntRow + x + 1] + rowSum;
		}
	}
	if (brightCount < 14) return null;

	// 只遍历稀疏白字像素，内联 7x7 深色描边积分图查询，同时收集 mask 稀疏坐标
	const mask = new Uint8Array(total);
	const maskX = new Int16Array(brightCount);
	const maskY = new Int16Array(brightCount);
	let maskCount = 0;
	for (let i = 0; i < brightCount; i++) {
		const x = brightX[i];
		const y = brightY[i];
		const ax = x > 3 ? x - 3 : 0;
		const ay = y > 3 ? y - 3 : 0;
		const bx1 = x + 4 < W ? x + 4 : W;
		const by1 = y + 4 < H ? y + 4 : H;
		const ayRow = ay * iw;
		const byRow = by1 * iw;
		const dc = integral[byRow + bx1] - integral[ayRow + bx1] - integral[byRow + ax] + integral[ayRow + ax];
		if (dc >= 3) {
			mask[y * W + x] = 1;
			maskX[maskCount] = x;
			maskY[maskCount] = y;
			maskCount++;
		}
	}
	if (maskCount < 14) return null;

	// 8 邻域连通域：只遍历稀疏 mask 点；用 mask[idx]=2 原地标记已访问，省掉 vis 全图数组并大幅缩减队列内存
	const qx = new Int16Array(maskCount);
	const qy = new Int16Array(maskCount);
	const comps: Array<{ minx: number; maxx: number; miny: number; maxy: number; w: number; h: number; area: number }> = [];
	const maxXBound = W - 1;
	const maxYBound = H - 1;
	for (let m = 0; m < maskCount; m++) {
		const sx = maskX[m];
		const sy = maskY[m];
		const sIdx = sy * W + sx;
		if (mask[sIdx] !== 1) continue;
		let head = 0;
		let tail = 0;
		qx[tail] = sx;
		qy[tail] = sy;
		tail++;
		mask[sIdx] = 2;
		let minx = sx;
		let maxx = sx;
		let miny = sy;
		let maxy = sy;
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
			const y0 = cy > 0 ? cy - 1 : 0;
			const y1 = cy < maxYBound ? cy + 1 : maxYBound;
			const x0 = cx > 0 ? cx - 1 : 0;
			const x1 = cx < maxXBound ? cx + 1 : maxXBound;
			for (let ny = y0; ny <= y1; ny++) {
				const nrow = ny * W;
				for (let nx = x0; nx <= x1; nx++) {
					const ni = nrow + nx;
					if (mask[ni] === 1) {
						mask[ni] = 2;
						qx[tail] = nx;
						qy[tail] = ny;
						tail++;
					}
				}
			}
		}
		const w = maxx - minx + 1;
		const h = maxy - miny + 1;
		if (area < 10 || w > 55 || h > 110) continue;
		comps.push({ minx, maxx, miny, maxy, w, h, area });
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
	};
}
