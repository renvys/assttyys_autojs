/**
 * 自动选点辅助模块
 *
 * 目标：在 AI 或人工确认的“识别范围”内，给定同一状态的若干正样本、以及其他
 * 易混状态的负样本，自动选出一组锚点比色点（desc），要求：
 * 1. 所有正样本在这组点上都能通过比色（正样本稳定）；
 * 2. 每个负样本至少有一个点不通过（负样本可分）；
 * 3. 点尽量少、尽量平坦、尽量分散，且只落在确认过的识别范围内。
 *
 * 本模块不依赖 DOM/Vue/Auto.js，输入只要求 { width, height, data }，因此既可以在
 * 浏览器/Node 工具里使用 ImageData，也可以在 Auto.js 里把 Bitmap 转成同样的结构。
 *
 * 坐标换算严格按 ScriptLib 的 AnchorGraphicHelper 实现（包括其 left/center/right
 * 的 x 使用高度比例这一行为），保证离线验证结果与线上一致。
 */

export const ANCHOR = {
	NONE: -1,
	LEFT: 0,
	CENTER: 1,
	RIGHT: 2,
	TOP: 3,
	MIDDLE: 4,
	BOTTOM: 5,
} as const;

export type Anchor = -1 | 0 | 1 | 2 | 3 | 4 | 5;

export interface ImageDataLike {
	width: number;
	height: number;
	/** RGBA，长度应为 width * height * 4 */
	data: Uint8ClampedArray | Uint8Array | number[];
}

export interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface AutoSelectWeights {
	/** 正样本稳定性权重 */
	stability: number;
	/** 负样本区分度权重 */
	separation: number;
	/** 局部平坦度权重 */
	flatness: number;
	/** 集合覆盖增益权重（选择阶段使用） */
	coverage: number;
}

export interface AutoSelectOptions {
	/** 开发分辨率宽，默认 1280 */
	devWidth: number;
	/** 开发分辨率高，默认 720 */
	devHeight: number;
	/**
	 * 识别范围（开发坐标，x0/y0/x1/y1 均含边界）。
	 * null 表示全屏扫描；建议始终传入 AI/人工确认过的范围。
	 */
	region: Rect | null;
	/** 多点比色相似度，默认 93；容差 = round(255 * (100 - similar) / 100) */
	similar: number;
	/** 候选点网格步长，默认 4 */
	gridStep: number;
	/** 距离屏幕边缘的最小距离，默认 8 */
	border: number;
	/** 距离识别范围边缘的最小距离，默认 2；范围很小时可设为 0 */
	regionPadding: number;
	/** 最多选多少个点，默认 8 */
	maxPoints: number;
	/** 已选点之间的最小距离（开发坐标），默认 80 */
	minDistance: number;
	/** 正样本各通道相对中位数的最大允许偏差，默认 8（similar=93 时线上容差为 18） */
	positiveTolerance: number;
	/** 3x3 邻域内允许的最大通道差，默认 6 */
	flatTolerance: number;
	/** 负样本区分余量：通道差 > 线上容差 + 该值才算“拒绝”，默认 15 */
	negativeMargin: number;
	/** 每个点至少覆盖多少个负样本，默认 1 */
	minCoveragePerPoint: number;
	/**
	 * 锚点分区比例。默认 [1/3, 2/3]：
	 * x < devWidth * 1/3 -> left；x > devWidth * 2/3 -> right；否则 center。
	 */
	anchorZones: [number, number];
	/** 锚点方向：horizontal 使用 left/center/right，vertical 使用 top/middle/bottom */
	anchorMode: 'horizontal' | 'vertical';
	/** 需要排除的区域（开发坐标） */
	masks: Rect[];
	/** 自定义锚点选择；返回后不再使用 anchorZones/anchorMode */
	anchorResolver?: (x: number, y: number) => Anchor;
	weights: AutoSelectWeights;
}

export type AutoSelectOptionsInput = Partial<Omit<AutoSelectOptions, 'weights'>> & {
	weights?: Partial<AutoSelectWeights>;
};

export interface AutoSelectPoint {
	anchor: Anchor;
	/** 开发坐标 x */
	x: number;
	/** 开发坐标 y */
	y: number;
	/** 0xRRGGBB，正样本各通道中位数 */
	color: number;
	/** 正样本最小相似度，0~100；越高越稳 */
	stability: number;
	/** 负样本中的最大相似度，0~100；越低越安全（100 表示有负样本几乎一样） */
	worstNegativeSimilarity: number;
	/** 正样本 3x3 邻域最大通道差；越小越平坦 */
	flatness: number;
	/** 被该点拒绝的负样本里，最小的通道差 */
	coveredMinDiff: number;
	/** 该点拒绝的负样本下标（相对于传入的 negatives 数组） */
	covered: number[];
	/** 选择阶段的综合评分 */
	score: number;
}

export interface AutoSelectResult {
	points: AutoSelectPoint[];
	/** 正样本数量 */
	positives: number;
	/** 负样本数量 */
	negatives: number;
	/** 已覆盖的负样本下标 */
	coveredNegatives: number[];
	/** 无法被任何稳定点区分的负样本下标 */
	uncoveredNegatives: number[];
	warnings: string[];
	/** 实际使用的配置（已合并默认值） */
	options: AutoSelectOptions;
}

export interface PointCheck {
	/** 点在该图片上是否通过 */
	ok: boolean;
	/** 实际颜色与期望颜色的最大通道差；越界时为 Infinity */
	diff: number;
	/** 映射到图片上的坐标 */
	x: number;
	y: number;
}

export interface ValidationResult {
	positives: {
		index: number;
		pass: boolean;
		/** 该正样本上失败的点下标 */
		failedPoints: number[];
	}[];
	negatives: {
		index: number;
		/** 是否被至少一个点拒绝 */
		rejected: boolean;
		/** 该负样本上通过的点下标；全部通过即误命中 */
		matchedPoints: number[];
	}[];
	/** 误命中的负样本下标（最危险） */
	falsePositiveNegatives: number[];
	/** 漏识别的正样本下标（通常会重试，但应尽量避免） */
	falseNegativePositives: number[];
}

interface Sample {
	r: number;
	g: number;
	b: number;
	a: number;
	/** 3x3 邻域最大通道差 */
	flat: number;
	/** 图片上的实际坐标 */
	x: number;
	y: number;
}

export interface AutoSelectCandidate extends AutoSelectPoint {
	baseScore: number;
}

export const DEFAULT_AUTO_SELECT_OPTIONS: AutoSelectOptions = {
	devWidth: 1280,
	devHeight: 720,
	region: null,
	similar: 93,
	gridStep: 4,
	border: 8,
	regionPadding: 2,
	maxPoints: 8,
	minDistance: 80,
	positiveTolerance: 8,
	flatTolerance: 6,
	negativeMargin: 15,
	minCoveragePerPoint: 1,
	anchorZones: [1 / 3, 2 / 3],
	anchorMode: 'horizontal',
	masks: [],
	weights: {
		stability: 0.4,
		separation: 0.4,
		flatness: 0.2,
		coverage: 0.8,
	},
};

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/**
 * ScriptLib 的 Round：正数四舍六入五成双（banker's rounding），
 * 负数按 Java int 截断行为处理。映射后的坐标正常情况下应为非负。
 */
export function scriptLibRound(num: number): number {
	const integerPart = Math.trunc(num);
	const fractionalPart = num - integerPart;
	const scaled = Math.trunc(fractionalPart * 100);
	const tens = Math.trunc(scaled / 10);

	if (tens < 6) {
		if (tens > 4) {
			if (scaled % 10 !== 0 || integerPart % 2 !== 0) {
				return integerPart + 1;
			}
			return integerPart;
		}
		return integerPart;
	}
	return integerPart + 1;
}

/**
 * 按 AnchorGraphicHelper 的规则把开发坐标映射到实际图片/屏幕坐标。
 * 注意：left/center/right 的 x 使用高度比例，top/middle/bottom 的 y 使用宽度比例，
 * 与 ScriptLib 当前实现保持一致。16:9 下两个比例相等，非 16:9 会偏。
 */
export function mapPoint(
	anchor: Anchor,
	x: number,
	y: number,
	devWidth: number,
	devHeight: number,
	screenWidth: number,
	screenHeight: number,
): { x: number; y: number } {
	const left = 0;
	const top = 0;
	const right = screenWidth - 1;
	const bottom = screenHeight - 1;
	const multipleH = (bottom - top + 1) / devHeight;
	const multipleW = (right - left + 1) / devWidth;
	const center = scriptLibRound((right - left + 1) / 2) + left - 1;
	const middle = scriptLibRound((bottom - top + 1) / 2) + top - 1;

	let mappedX: number;
	let mappedY: number;

	switch (anchor) {
		case ANCHOR.LEFT:
		case ANCHOR.NONE:
			mappedX = scriptLibRound(x * multipleH) + left;
			mappedY = scriptLibRound(y * multipleH) + top;
			break;
		case ANCHOR.CENTER:
			mappedX = scriptLibRound(center - (devWidth / 2 - x - 1) * multipleH);
			mappedY = scriptLibRound(y * multipleH) + top;
			break;
		case ANCHOR.RIGHT:
			mappedX = scriptLibRound(right - (devWidth - x - 1) * multipleH);
			mappedY = scriptLibRound(y * multipleH) + top;
			break;
		case ANCHOR.TOP:
			mappedY = scriptLibRound(y * multipleW) + top;
			mappedX = scriptLibRound(x * multipleW) + left;
			break;
		case ANCHOR.MIDDLE:
			mappedY = scriptLibRound(middle - (devHeight / 2 - y - 1) * multipleW);
			mappedX = scriptLibRound(x * multipleW) + left;
			break;
		case ANCHOR.BOTTOM:
			mappedY = scriptLibRound(bottom - (devHeight - y - 1) * multipleW);
			mappedX = scriptLibRound(x * multipleW) + left;
			break;
		default:
			mappedX = x;
			mappedY = y;
			break;
	}

	return { x: mappedX, y: mappedY };
}

function resolveOptions(input?: AutoSelectOptionsInput): AutoSelectOptions {
	const options = {
		...DEFAULT_AUTO_SELECT_OPTIONS,
		...(input || {}),
		weights: {
			...DEFAULT_AUTO_SELECT_OPTIONS.weights,
			...((input && input.weights) || {}),
		},
		anchorZones: [
			...((input && input.anchorZones) || DEFAULT_AUTO_SELECT_OPTIONS.anchorZones),
		] as [number, number],
		masks: [...((input && input.masks) || [])],
		region: input && input.region ? { ...input.region } : null,
	};

	options.similar = Math.max(0, Math.min(100, options.similar));
	options.gridStep = Math.max(1, Math.floor(options.gridStep));
	options.border = Math.max(0, Math.floor(options.border));
	options.regionPadding = Math.max(0, Math.floor(options.regionPadding));
	options.maxPoints = Math.max(0, Math.floor(options.maxPoints));
	options.minDistance = Math.max(0, options.minDistance);
	options.positiveTolerance = Math.max(0, options.positiveTolerance);
	options.flatTolerance = Math.max(0, options.flatTolerance);
	options.negativeMargin = Math.max(0, options.negativeMargin);
	options.minCoveragePerPoint = Math.max(0, Math.floor(options.minCoveragePerPoint));

	let zone0 = clamp01(options.anchorZones[0]);
	let zone1 = clamp01(options.anchorZones[1]);
	if (zone0 > zone1) {
		const temp = zone0;
		zone0 = zone1;
		zone1 = temp;
	}
	options.anchorZones = [zone0, zone1];

	return options;
}

function getPixel(image: ImageDataLike, x: number, y: number): [number, number, number, number] {
	const index = (y * image.width + x) * 4;
	const data = image.data;
	return [
		data[index],
		data[index + 1],
		data[index + 2],
		data[index + 3] === undefined ? 255 : data[index + 3],
	];
}

function maxChannelDiff(
	color1: [number, number, number] | number[],
	color2: [number, number, number] | number[],
): number {
	return Math.max(
		Math.abs(color1[0] - color2[0]),
		Math.abs(color1[1] - color2[1]),
		Math.abs(color1[2] - color2[2]),
	);
}

/**
 * 与 ScriptLib Similarity 一致的最大通道差相似度，返回 0~100。
 */
export function colorSimilarity(
	color1: [number, number, number] | number[],
	color2: [number, number, number] | number[],
): number {
	return scriptLibRound((255 - maxChannelDiff(color1, color2)) / 255 * 100);
}

function median(values: number[]): number {
	values.sort((a, b) => a - b);
	const mid = values.length >> 1;
	if (values.length % 2 === 1) {
		return values[mid];
	}
	return Math.round((values[mid - 1] + values[mid]) / 2);
}

function sampleImage(
	image: ImageDataLike,
	devX: number,
	devY: number,
	anchor: Anchor,
	devWidth: number,
	devHeight: number,
	needFlat: boolean,
): Sample | null {
	const point = mapPoint(anchor, devX, devY, devWidth, devHeight, image.width, image.height);
	const margin = needFlat ? 1 : 0;

	if (
		point.x < margin || point.y < margin
		|| point.x >= image.width - margin || point.y >= image.height - margin
	) {
		return null;
	}

	const center = getPixel(image, point.x, point.y);
	// 透明像素会随背景变化，直接排除
	if (center[3] < 255) {
		return null;
	}

	let flat = 0;
	if (needFlat) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const neighbor = getPixel(image, point.x + dx, point.y + dy);
				if (neighbor[3] < 255) {
					return null;
				}
				flat = Math.max(flat, maxChannelDiff(center, neighbor));
			}
		}
	}

	return {
		r: center[0],
		g: center[1],
		b: center[2],
		a: center[3],
		flat,
		x: point.x,
		y: point.y,
	};
}

function isMasked(x: number, y: number, masks: Rect[]): boolean {
	for (const mask of masks) {
		if (x >= mask.x0 && x <= mask.x1 && y >= mask.y0 && y <= mask.y1) {
			return true;
		}
	}
	return false;
}

function resolveAnchor(x: number, y: number, options: AutoSelectOptions): Anchor {
	if (options.anchorResolver) {
		return options.anchorResolver(x, y);
	}

	const [zone0, zone1] = options.anchorZones;
	if (options.anchorMode === 'vertical') {
		if (y < options.devHeight * zone0) return ANCHOR.TOP;
		if (y > options.devHeight * zone1) return ANCHOR.BOTTOM;
		return ANCHOR.MIDDLE;
	}

	if (x < options.devWidth * zone0) return ANCHOR.LEFT;
	if (x > options.devWidth * zone1) return ANCHOR.RIGHT;
	return ANCHOR.CENTER;
}

function colorToRgb(color: number): [number, number, number] {
	return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function pointDistance(point1: { x: number; y: number }, point2: { x: number; y: number }): number {
	const dx = point1.x - point2.x;
	const dy = point1.y - point2.y;
	return Math.sqrt(dx * dx + dy * dy);
}

function isBetterCandidate(candidate: AutoSelectCandidate, current: AutoSelectCandidate | null): boolean {
	if (!current) return true;
	if (candidate.score > current.score + 1e-12) return true;
	if (candidate.score < current.score - 1e-12) return false;
	if (candidate.stability !== current.stability) return candidate.stability > current.stability;
	if (candidate.coveredMinDiff !== current.coveredMinDiff) {
		return candidate.coveredMinDiff > current.coveredMinDiff;
	}
	if (candidate.y !== current.y) return candidate.y < current.y;
	return candidate.x < current.x;
}

function stripCandidate(candidate: AutoSelectCandidate): AutoSelectPoint {
	return {
		anchor: candidate.anchor,
		x: candidate.x,
		y: candidate.y,
		color: candidate.color,
		stability: candidate.stability,
		worstNegativeSimilarity: candidate.worstNegativeSimilarity,
		flatness: candidate.flatness,
		coveredMinDiff: candidate.coveredMinDiff,
		covered: [...candidate.covered],
		score: candidate.score,
	};
}

/**
 * 扫描候选点。
 */
export function analyzeCandidates(
	positives: ImageDataLike[],
	negatives: ImageDataLike[],
	input?: AutoSelectOptionsInput,
): { candidates: AutoSelectCandidate[]; options: AutoSelectOptions; warnings: string[] } {
	const options = resolveOptions(input);
	const warnings: string[] = [];

	if (positives.length === 0) {
		warnings.push('没有正样本，无法自动选点');
		return { candidates: [], options, warnings };
	}
	if (negatives.length === 0) {
		warnings.push('没有负样本，无法评估区分度；自动选点至少需要一个易混状态的截图');
		return { candidates: [], options, warnings };
	}

	if (options.region) {
		const region = options.region;
		const x0 = Math.max(0, Math.min(options.devWidth - 1, Math.floor(region.x0)));
		const y0 = Math.max(0, Math.min(options.devHeight - 1, Math.floor(region.y0)));
		const x1 = Math.max(0, Math.min(options.devWidth - 1, Math.floor(region.x1)));
		const y1 = Math.max(0, Math.min(options.devHeight - 1, Math.floor(region.y1)));
		if (x1 <= x0 || y1 <= y0) {
			warnings.push(
				`识别范围无效：[${region.x0}, ${region.y0}, ${region.x1}, ${region.y1}]。` +
				'请确认 x1 > x0 且 y1 > y0，并且范围至少覆盖 2x2 像素。',
			);
			return { candidates: [], options, warnings };
		}
		options.region = { x0, y0, x1, y1 };
	}

	const expectedRatio = options.devWidth / options.devHeight;
	const checkAspect = (image: ImageDataLike, label: string) => {
		const ratio = image.width / image.height;
		if (Math.abs(ratio - expectedRatio) > 0.01) {
			warnings.push(
				`${label} 的宽高比不是 ${options.devWidth}x${options.devHeight}（16:9），` +
				'ScriptLib 在非 16:9 下锚点换算会偏移，建议先旋转/裁切到 16:9。',
			);
		}
	};
	positives.forEach((image, index) => checkAspect(image, `正样本 ${index + 1}/${positives.length}`));
	negatives.forEach((image, index) => checkAspect(image, `负样本 ${index + 1}/${negatives.length}`));

	const images = [...positives, ...negatives];
	const positiveCount = positives.length;
	const negativeCount = negatives.length;
	// 线上容差：similar=93 -> 18，similar=97 -> 8
	const threshold = scriptLibRound(255 - 255 * options.similar / 100);
	const rejectThreshold = threshold + options.negativeMargin;
	const candidates: AutoSelectCandidate[] = [];

	const region = options.region;
	const padding = options.regionPadding;
	const xStart = Math.max(options.border, region ? region.x0 + padding : 0);
	const xEnd = Math.min(
		options.devWidth - options.border,
		region ? region.x1 - padding + 1 : options.devWidth,
	);
	const yStart = Math.max(options.border, region ? region.y0 + padding : 0);
	const yEnd = Math.min(
		options.devHeight - options.border,
		region ? region.y1 - padding + 1 : options.devHeight,
	);

	if (xStart >= xEnd || yStart >= yEnd) {
		warnings.push(
			'识别范围内没有可扫描区域：范围可能小于 border/regionPadding，或完全落在屏幕边缘。' +
			'可尝试减小 border、把 regionPadding 设为 0，或扩大 region。',
		);
		return { candidates: [], options, warnings };
	}

	for (let y = yStart; y < yEnd; y += options.gridStep) {
		for (let x = xStart; x < xEnd; x += options.gridStep) {
			if (isMasked(x, y, options.masks)) continue;

			const anchor = resolveAnchor(x, y, options);
			const samples: (Sample | null)[] = new Array(images.length);
			let valid = true;

			for (let i = 0; i < images.length; i++) {
				const sample = sampleImage(
					images[i],
					x,
					y,
					anchor,
					options.devWidth,
					options.devHeight,
					i < positiveCount,
				);
				if (!sample) {
					valid = false;
					break;
				}
				samples[i] = sample;
			}
			if (!valid) continue;

			const reds: number[] = [];
			const greens: number[] = [];
			const blues: number[] = [];
			for (let i = 0; i < positiveCount; i++) {
				const sample = samples[i] as Sample;
				reds.push(sample.r);
				greens.push(sample.g);
				blues.push(sample.b);
			}
			const medianR = median(reds);
			const medianG = median(greens);
			const medianB = median(blues);
			const expected: [number, number, number] = [medianR, medianG, medianB];

			let positiveDeviation = 0;
			let flatness = 0;
			for (let i = 0; i < positiveCount; i++) {
				const sample = samples[i] as Sample;
				positiveDeviation = Math.max(
					positiveDeviation,
					Math.abs(sample.r - medianR),
					Math.abs(sample.g - medianG),
					Math.abs(sample.b - medianB),
				);
				flatness = Math.max(flatness, sample.flat);
			}

			if (positiveDeviation > options.positiveTolerance) continue;
			if (flatness > options.flatTolerance) continue;

			const covered: number[] = [];
			let minNegativeDiff = 255;
			let coveredMinDiff = Number.POSITIVE_INFINITY;

			for (let i = 0; i < negativeCount; i++) {
				const sample = samples[positiveCount + i] as Sample;
				const diff = maxChannelDiff(expected, [sample.r, sample.g, sample.b]);
				minNegativeDiff = Math.min(minNegativeDiff, diff);
				if (diff > rejectThreshold) {
					covered.push(i);
					coveredMinDiff = Math.min(coveredMinDiff, diff);
				}
			}

			if (covered.length === 0) {
				coveredMinDiff = 0;
			}
			if (covered.length < options.minCoveragePerPoint) continue;

			const stability = scriptLibRound((255 - positiveDeviation) / 255 * 100);
			const worstNegativeSimilarity = negativeCount > 0
				? scriptLibRound((255 - minNegativeDiff) / 255 * 100)
				: 0;

			const stabilityNorm = clamp01(1 - positiveDeviation / Math.max(1, options.positiveTolerance));
			const separationNorm = clamp01(coveredMinDiff / 64);
			const flatNorm = clamp01(1 - flatness / Math.max(1, options.flatTolerance));
			const baseScore = options.weights.stability * stabilityNorm
				+ options.weights.separation * separationNorm
				+ options.weights.flatness * flatNorm;

			candidates.push({
				anchor,
				x,
				y,
				color: (medianR << 16) | (medianG << 8) | medianB,
				stability,
				worstNegativeSimilarity,
				flatness,
				coveredMinDiff,
				covered,
				score: baseScore,
				baseScore,
			});

		}
	}

	if (candidates.length === 0) {
		warnings.push(
			'没有满足稳定/平坦/区分度条件的候选点；可尝试增加正样本、放宽 positiveTolerance/flatTolerance，' +
			'或检查负样本是否与正样本几乎相同。',
		);
	}

	return { candidates, options, warnings };
}

function selectCandidates(
	candidates: AutoSelectCandidate[],
	negativeCount: number,
	options: AutoSelectOptions,
	warnings: string[],
): { selected: AutoSelectCandidate[]; covered: Set<number> } {
	const selected: AutoSelectCandidate[] = [];
	const covered = new Set<number>();
	let minDistance = options.minDistance;

	while (selected.length < options.maxPoints && covered.size < negativeCount) {
		let best: AutoSelectCandidate | null = null;

		for (const candidate of candidates) {
			if (selected.indexOf(candidate) !== -1) continue;
			if (minDistance > 0 && selected.some(item => pointDistance(item, candidate) < minDistance)) {
				continue;
			}

			let gain = 0;
			for (const negativeIndex of candidate.covered) {
				if (!covered.has(negativeIndex)) gain++;
			}
			if (gain === 0) continue;

			const score = candidate.baseScore
				+ options.weights.coverage * (gain / Math.max(1, negativeCount));
			candidate.score = score;

			if (isBetterCandidate(candidate, best)) {
				best = candidate;
			}
		}

		if (!best) {
			if (minDistance > 0) {
				// 只有当“还有能覆盖新负样本的候选点，只是被最小间距挡住”时才放宽间距，
				// 避免在没有更多可覆盖点时给出误导性的警告。
				const hasRemainingGain = candidates.some(candidate => {
					if (selected.indexOf(candidate) !== -1) return false;
					return candidate.covered.some(index => !covered.has(index));
				});
				if (hasRemainingGain) {
					minDistance = 0;
					warnings.push('受最小间距限制无法继续覆盖，已自动把 minDistance 放宽到 0。');
					continue;
				}
			}
			break;
		}

		selected.push(best);
		for (const negativeIndex of best.covered) {
			covered.add(negativeIndex);
		}
	}

	return { selected, covered };
}

/**
 * 自动选点主入口。
 */
export function autoSelect(
	positives: ImageDataLike[],
	negatives: ImageDataLike[],
	input?: AutoSelectOptionsInput,
): AutoSelectResult {
	const analysis = analyzeCandidates(positives, negatives, input);
	const warnings = analysis.warnings;
	const options = analysis.options;
	const negativeCount = negatives.length;

	if (analysis.candidates.length === 0 || negativeCount === 0) {
		return {
			points: [],
			positives: positives.length,
			negatives: negativeCount,
			coveredNegatives: [],
			uncoveredNegatives: Array.from({ length: negativeCount }, (_, index) => index),
			warnings,
			options,
		};
	}

	const selection = selectCandidates(analysis.candidates, negativeCount, options, warnings);
	const coveredNegatives = Array.from(selection.covered).sort((a, b) => a - b);
	const uncoveredNegatives: number[] = [];
	for (let i = 0; i < negativeCount; i++) {
		if (!selection.covered.has(i)) uncoveredNegatives.push(i);
	}

	if (uncoveredNegatives.length > 0) {
		warnings.push(
			`有 ${uncoveredNegatives.length} 个负样本无法被任何稳定点区分：` +
			`${uncoveredNegatives.join(', ')}。这些状态可能在颜色上与正样本相同，需要 OCR、多点找色或合并逻辑。`,
		);
	}
	if (selection.selected.length >= options.maxPoints && uncoveredNegatives.length > 0) {
		warnings.push(`已达到 maxPoints=${options.maxPoints}，可适当增大上限或减少负样本种类。`);
	}

	return {
		points: selection.selected.map(stripCandidate),
		positives: positives.length,
		negatives: negativeCount,
		coveredNegatives,
		uncoveredNegatives,
		warnings,
		options,
	};
}

/**
 * 用与线上一致的 AND 语义验证一组点：
 * - 正样本：所有点都通过才算通过；
 * - 负样本：至少一个点失败才算被拒绝；
 * - 负样本全部点都通过 = 误命中，最危险。
 */
export function validateSelection(
	points: AutoSelectPoint[],
	positives: ImageDataLike[],
	negatives: ImageDataLike[],
	input?: AutoSelectOptionsInput,
): ValidationResult {
	const options = resolveOptions(input);
	const threshold = scriptLibRound(255 - 255 * options.similar / 100);

	const checkPoint = (point: AutoSelectPoint, image: ImageDataLike): PointCheck => {
		const sample = sampleImage(
			image,
			point.x,
			point.y,
			point.anchor,
			options.devWidth,
			options.devHeight,
			false,
		);
		if (!sample) {
			const mapped = mapPoint(
				point.anchor,
				point.x,
				point.y,
				options.devWidth,
				options.devHeight,
				image.width,
				image.height,
			);
			return { ok: false, diff: Infinity, x: mapped.x, y: mapped.y };
		}
		const diff = maxChannelDiff(colorToRgb(point.color), [sample.r, sample.g, sample.b]);
		return { ok: diff <= threshold, diff, x: sample.x, y: sample.y };
	};

	const positiveResults = positives.map((image, index) => {
		const failedPoints: number[] = [];
		points.forEach((point, pointIndex) => {
			if (!checkPoint(point, image).ok) failedPoints.push(pointIndex);
		});
		return {
			index,
			pass: failedPoints.length === 0,
			failedPoints,
		};
	});

	const negativeResults = negatives.map((image, index) => {
		const matchedPoints: number[] = [];
		points.forEach((point, pointIndex) => {
			if (checkPoint(point, image).ok) matchedPoints.push(pointIndex);
		});
		return {
			index,
			rejected: points.length > 0 && matchedPoints.length < points.length,
			matchedPoints,
		};
	});

	return {
		positives: positiveResults,
		negatives: negativeResults,
		falsePositiveNegatives: negativeResults
			.filter(item => !item.rejected)
			.map(item => item.index),
		falseNegativePositives: positiveResults
			.filter(item => !item.pass)
			.map(item => item.index),
	};
}

const ANCHOR_NAME: Record<number, string> = {
	[ANCHOR.NONE]: 'none',
	[ANCHOR.LEFT]: 'left',
	[ANCHOR.CENTER]: 'center',
	[ANCHOR.RIGHT]: 'right',
	[ANCHOR.TOP]: 'top',
	[ANCHOR.MIDDLE]: 'middle',
	[ANCHOR.BOTTOM]: 'bottom',
};

export function anchorName(anchor: Anchor): string {
	return ANCHOR_NAME[anchor] || 'left';
}

export function toHexColor(color: number): string {
	const hex = color.toString(16);
	return `0x${'000000'.slice(hex.length)}${hex}`;
}

export interface AutoSelectDesc {
	desc: [number, number, [string, number, number, number][]];
}

/**
 * 转成项目里使用的 desc 结构（锚点名称为 left/center/...）。
 */
export function toDesc(result: AutoSelectResult): AutoSelectDesc {
	const options = result.options;
	return {
		desc: [
			options.devWidth,
			options.devHeight,
			result.points.map(point => [
				ANCHOR_NAME[point.anchor],
				point.x,
				point.y,
				point.color,
			]),
		],
	};
}

/**
 * 转成可直接粘贴进 multiDetectColors.ts / operator 的代码片段。
 */
export function formatDesc(result: AutoSelectResult): string {
	const desc = toDesc(result).desc;
	const lines = desc[2].map(item => {
		return `\t\t\t[${item[0]}, ${item[1]}, ${item[2]}, ${toHexColor(item[3])}]`;
	});
	return `[\n\t${desc[0]}, ${desc[1]},\n\t[\n${lines.join(',\n')}\n\t]\n]`;
}

export default {
	autoSelect,
	analyzeCandidates,
	validateSelection,
	toDesc,
	formatDesc,
	mapPoint,
	scriptLibRound,
	colorSimilarity,
	toHexColor,
	DEFAULT_AUTO_SELECT_OPTIONS,
	ANCHOR,
};
