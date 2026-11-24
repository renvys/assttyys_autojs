import { IFuncOrigin, IFuncOperatorOrigin, IFuncOperator } from '@/interface/IFunc';
import { Script } from '@/system/script';
import { analyzeD6Map, pickD6MapChoice, d6MapSlotIndex, d6MapColName, D6_MINIMAP_DEV_REGION, warmUpD6Map, D6MapState } from '@/common/d6jueMap';
import { detectD6BannerAnchor, downsampleD6BannerImage, D6BannerAnchor } from '@/common/d6jueBanner';
import { recognizeD6StepCounter, D6StepCounterResult } from '@/common/d6jueStepCounter';
import { D6StepTracker, D6StepCounterUpdate } from '@/common/d6jueStepTracker';
import { bitmapToImageData } from '@/common/autoSelectBitmap';
import { perfLogLine } from '@/common/perfLog';
import { d6jueUnknownLog } from '@/common/d6jueLog';
import { d6jueAnalysisLog, d6jueAnalysisSetRun, d6jueAnalysisPath } from '@/common/d6jueAnalysisLog';
import { D6_LOGIC_VERSION } from '@/common/d6jueVersion';

// const normal = -1; //定义常量
const left = 0;
const center = 1;
const right = 2;

let mapSwitchLogged = false;
let unknownMapNotified = false;
let mapWarmedUp = false;
let mapReadCount = 0;
let bossDetectLogged = false;
let shopGridMissLogged = false;
let shopEnterTime = 0;
let lastWalletOcrTime = 0;
// buff 等待期间已经并行跑过钱包 OCR 时，跳过本轮调用方紧接着的重复 OCR。
let d6BuffWalletOcrSkipUntil = 0;
// buff/舞技选择后锁住，直到选择界面消失，防止切换动画期间同一屏被重复点击、重复记账
let buffSelectLockActive = false;
let buffSelectLockUntil = 0;
// buff 界面卡面稳定状态：入场/刷新动画结束前读卡会一直读到上一组，
// 必须等三张卡真正换完（卡面 hash 连续稳定）再扫描/决定下一次刷新。
let d6BuffScreenSettled = false;
let d6BuffRefreshCount = 0;
let d6BuffLastRefreshTime = 0;
let d6BuffScreenLastSeen = 0;
// 六道觉每座岛的进岛 +50 只记一次；buff +100 按选buff界面计（混沌精英可两次）。
// 岛屿 key 在点击主地图节点时更新，重试同一节点不会重置。
let d6IslandKey = '';
let d6IslandGainDone = false;
// 商店/选buff刷新：点击后先挂起费用，等下一次 OCR 校验是否真的扣了
let d6PendingRefreshCost = 0;
let d6PendingRefreshSource = '';
let d6PendingRefreshWalletBefore = 0;
let d6PendingRefreshTime = 0;
// 唤息：点击后等地图刷新确认，进入新地图才扣一次 300
let d6HuanxiPending = false;
let d6HuanxiPendingTime = 0;
let d6HuanxiPendingSig = '';
// 按小地图画面哈希缓存识别结果，避免冷却/等待期间对同一帧重复跑 NCC
let mapStateCache: { hash: string; state: D6MapState | null } | null = null;
let mapStateCacheTime = 0;
// 最近一次成功读取的小地图画面哈希：给步数状态机判断“点击后是否发生转场/动画”
let lastMapHash = '';
// 步数状态机：地图推进为主，右上角回合数字只做校验/恢复
let stepTracker: D6StepTracker | null = null;
// 回合数字读取缓存：同一地图行允许 300~500ms 后重读，避免换行动画/奖励弹窗期间一次 miss 就放弃
let stepCounterRead: {
	rowKey: string;
	result: D6StepCounterResult | null;
	attempts: number;
	firstTime: number;
	lastTime: number;
	exhausted: boolean;
	missLogged: boolean;
	rejectLogged: boolean;
	waitLogged: boolean;
	matchLogged: boolean;
} | null = null;

/** 小地图缓存哈希：颜色量化到 16 级 + 12x12 抽样，忽略轻微动画 */
function d6MapImageHash(image: { width: number; height: number; data: any }): string {
	let h = 2166136261;
	const stepX = Math.max(1, Math.floor(image.width / 12));
	const stepY = Math.max(1, Math.floor(image.height / 12));
	for (let y = 0; y < image.height; y += stepY) {
		for (let x = 0; x < image.width; x += stepX) {
			const i = (y * image.width + x) * 4;
			h = (((h ^ (image.data[i] >> 4)) * 16777619) >>> 0);
			h = (((h ^ (image.data[i + 1] >> 4)) * 16777619) >>> 0);
			h = (((h ^ (image.data[i + 2] >> 4)) * 16777619) >>> 0);
		}
	}
	return String(h);
}

/** buff 卡面哈希：三张卡图标区的颜色量化 + 32x12 抽样，比地图哈希更密，能区分换卡 */
function d6BuffCardsImageHash(image: { width: number; height: number; data: any }): string {
	let h = 2166136261;
	const stepX = Math.max(1, Math.floor(image.width / 32));
	const stepY = Math.max(1, Math.floor(image.height / 12));
	for (let y = 0; y < image.height; y += stepY) {
		for (let x = 0; x < image.width; x += stepX) {
			const i = (y * image.width + x) * 4;
			h = (((h ^ (image.data[i] >> 4)) * 16777619) >>> 0);
			h = (((h ^ (image.data[i + 1] >> 4)) * 16777619) >>> 0);
			h = (((h ^ (image.data[i + 2] >> 4)) * 16777619) >>> 0);
		}
	}
	return String(h);
}

/**
 * 步数状态机用的地图行指纹：类型 + 量化 x/y + 定位针。
 * 坐标量化到 8px，避免 NCC ±1~2px 抖动被当成“新的一行”。
 */
function d6StepRowKey(state: D6MapState): string {
	const nodes = state.reachable.map(n => `${n.type}${Math.round(n.x / 8) * 8}`).join('/');
	const pin = state.pin ? `${Math.round(state.pin.x / 8) * 8},${Math.round(state.pin.y / 8) * 8}` : '-';
	return `${nodes || '-'}|${Math.round(state.nextRowY / 8) * 8}|${pin}`;
}
// TODO(六道觉): 后续恢复“只有脚本点击开启才执行六道觉操作”的限制，改回 true
const REQUIRE_SCRIPT_START = false;

const MAP_PRIORITY: { [key: string]: number } = {
	神秘: 4,
	宁息: 3,
	鏖战: 2,
	混沌: 1,
	绽放: 0,
};
// 满足通关条件后：优先非战斗/可跳过节点，最后才打鏖战/混沌
const MAP_PRIORITY_CLEARED: { [key: string]: number } = {
	神秘: 6,
	宁息: 5,
	绽放: 4,
	鏖战: 2,
	混沌: 1,
};
// 只剩轰雷且钱够时：宁息商店 > 鏖战（必定给一次三选一） > 神秘 > 混沌 > 绽放
const MAP_PRIORITY_SHOP_HUNT: { [key: string]: number } = {
	宁息: 10,
	鏖战: 5,
	神秘: 4,
	混沌: 2,
	绽放: 0,
};
// 孔雀国全程 20 步；绽放固定在第 5/10/15 关
const D6_TOTAL_STEPS = 20;
const D6_MAP_SIG_WAIT = 700;
const D6_MAP_SETTLE_MS = 1000;
const D6_MAP_CLICK_HALF_W = 6;
// readMapState 的短 TTL 缓存：同一行在稳定/确认阶段会以约 1.5s 间隔被重复读取，
// 800ms 覆盖不到（实机几乎不命中）；改成 1800ms，覆盖同一行的第二次确认读，
// 同时远小于岛屿/事件 2s+ 的持续时间，不会把旧行当成新行。
const D6_MAP_STATE_CACHE_TTL_MS = 1800;
// 这些 operator 属于地图选择阶段，命中时不能当作“已进入岛屿”的证据。
// 0~3 是进入副本/开启，37/44 是唤息亮暗；其余 operator 在 stepPending 期间命中
// 都说明已经离开地图、进入岛屿事件/战斗/商店/buff 等界面。
const D6_STEP_MAP_OPERATORS: { [key: number]: boolean } = {
	0: true,
	1: true,
	2: true,
	3: true,
	// 12 核心buff满层/29 双倍次数是地图或开局就可见的标识，
	// 即使以后补上取色也不能当作“已进入岛屿”的证据。
	12: true,
	29: true,
	37: true,
	44: true,
};
const D6_HUANXI_COST = 300;
const D6_SHOP_LEI_PRICE = 200;
// 实机商店截图刷新按钮为「100(剩N次)」，每次 100，不是 50
const D6_SHOP_REFRESH_COST = 100;
const D6_SHOP_REFRESH_MAX = 3;
const D6_BUFF_REFRESH_COST = 50;
// buff 三张卡的图标区（开发坐标 1280x720）：入场/刷新动画期间会整体变化。
// 刷新后轮询这里的外接矩形哈希，连续稳定后才允许扫描/选卡。
const D6_BUFF_CARDS_DEV_REGION = { x0: 60, y0: 140, x1: 900, y1: 260 } as const;
// 入场/刷新最小等待（视频实测入场卡面约 0.5~0.8s 已可读，刷新新卡约 2.2~2.6s 才落）
const D6_BUFF_ENTER_MIN_MS = 900;
const D6_BUFF_REFRESH_MIN_MS = 2200;
// 固定落位等待：卡面有持续闪光/粒子，轮询“连续相同 hash”在实机上几乎必定超时，
// 旧实现每次 enter/refresh 都要跑满 4.5s，刷新后还会再补一次 enter，单次刷新约 9s。
// 改为按实测动画时长固定等待，等待后只读一次 hash 做日志，不再用 hash 阻塞。
const D6_BUFF_ENTER_SETTLE_MS = 900;
const D6_BUFF_REFRESH_SETTLE_MS = 2700;
// 超过这个间隔再次命中 buff 界面，视为新界面（正常一次刷新约 2.7~3.5s）
const D6_BUFF_SCREEN_GAP_MS = 8000;
// 每座岛 +50 只记一次：战斗岛在进入战斗/挑战时，商店在退出时，其他事件在完成时。
// 挑战的 50 就是这个，不再额外加；商店入口 OCR 证明此时尚未到账。
const D6_ISLAND_GAIN = 50;
// 选buff/舞技 +100 按“选buff界面”计：混沌精英能选两次，就有两次；同一屏的重复点击由选择锁挡住。
// 实机记录：极道轰炸/六道封印/怪力乱神/六道化身 曾出现 +150；生命加成/炽焚天火/舞技强化为 +100。
// 先按 100 计算；OCR 若对某张卡持续 +50，再按卡名补差，不按点击次数加。
const D6_ISLAND_BUFF_GAIN = 100;
// OCR 读数与每岛固定收益计算的合理差；超过视为 OCR 读错，不拿来校准
const D6_WALLET_OCR_DIFF_MAX = 500;
// 宁息商店 3×3 购买区（1280x720 开发坐标，按实机截图划分）
// 每格只取图标下方的名称/价格区，不含图标；第三行贴底，底部裁到 719
const D6_SHOP_GRID_X_BOUNDS = [680, 850, 1010, 1180];
const D6_SHOP_GRID_Y_BOUNDS = [70, 310, 545, 720];
const D6_SHOP_BUY_GRID: number[][] = [
	// 第一行
	[right, 1280, 720, 700, 195, 835, 300, 1000],
	[right, 1280, 720, 865, 195, 1000, 300, 1000],
	[right, 1280, 720, 1025, 195, 1160, 300, 1000],
	// 第二行
	[right, 1280, 720, 700, 435, 835, 540, 1000],
	[right, 1280, 720, 865, 435, 1000, 540, 1000],
	[right, 1280, 720, 1025, 435, 1160, 540, 1000],
	// 第三行
	[right, 1280, 720, 700, 670, 835, 719, 1000],
	[right, 1280, 720, 865, 670, 1000, 719, 1000],
	[right, 1280, 720, 1025, 670, 1160, 719, 1000],
];

/** 图标坐标 -> 九宫格下标（-1 表示不在商店面板内） */
function d6ShopGridIndex(x: number, y: number): number {
	if (x < D6_SHOP_GRID_X_BOUNDS[0] || x >= D6_SHOP_GRID_X_BOUNDS[3]
		|| y < D6_SHOP_GRID_Y_BOUNDS[0] || y >= D6_SHOP_GRID_Y_BOUNDS[3]) return -1;
	const col = x < D6_SHOP_GRID_X_BOUNDS[1] ? 0 : (x < D6_SHOP_GRID_X_BOUNDS[2] ? 1 : 2);
	const row = y < D6_SHOP_GRID_Y_BOUNDS[1] ? 0 : (y < D6_SHOP_GRID_Y_BOUNDS[2] ? 1 : 2);
	return row * 3 + col;
}
// buff 黑名单：默认永不选择
const DEFAULT_BUFF_BLACKLIST = '六道·混沌,六道·偶戏,妖力化身,攻击加成,背水一战';
// buff 名称 -> multiFindColors 的 key（去掉 Rhino 不认的间隔号 ·）
const buffColorKey = (name: string) => `六道觉_buff_${name.replace(/\u00b7/g, '')}`;
// 需要注意的 buff：名称用于图标识别和等级限制
const CAUTION_BUFF_YAO = '妖力化身';
const CAUTION_BUFF_CHIFEN = '炽焚天火';
const CAUTION_BUFF_BEISHUI = '背水一战';
const CAUTION_BUFF_ATTACK = '攻击加成';
// 已取色的已知 buff；黑名单里的名称会在运行时追加
const KNOWN_BUFF_NAMES = [CAUTION_BUFF_YAO, CAUTION_BUFF_CHIFEN, CAUTION_BUFF_BEISHUI, CAUTION_BUFF_ATTACK, '六道化身', '洞察之力', '极道轰炸'];
let buffPatternWarned = false;

/**
 * 六道之门·觉（完整挂机流程骨架）
 *
 * 当前状态：
 * - 进入、事件、选buff、商店、战斗、结算、统计与方案切换的流程均已搭好。
 * - 开启-六道觉、确认-选择试炼式神、开启-上阵式神、选择舞技、初始技能、备战/唤息、鏖战（主地图节点 + 进入后选择怪物）、挑战、舞技强化、舞技强化刷新、选择强化、获得奖励已取色；其余界面标有 TODO(六道觉) 的 operator 只有注释示例。
 *
 * 右上角小地图说明：
 * - 识别逻辑在 src/common/d6jueMap.ts：按金色像素密度找出全部岛屿图标并分类
 *   （鏖战/混沌/神秘/宁息/绽放），亮色=当前可进入，取最上面一排亮色节点，
 *   按从左到右顺序对应主地图固定选择位。
 * - 不假设固定列数/行数，也不再按“某个岛屿出现在左/中/右”单独取主地图锚点；
 *   新增岛屿只需补一份图标模板。
 *
 * 取色说明：
 * 1. 每个 operator 对应流程中的一个界面/状态，编号见数组内注释。
 * 2. 没有 desc 的占位状态会被 isReady() 过滤，运行时不会误判、不会误点击。
 * 3. 补色时取消对应注释，按 1280x720 填入 desc 与 oper 即可，无需改流程代码。
 * 4. 商店购买按钮这类位置会变化的目标，填到 multiFindColors.ts 的
 *    '六道觉_购买buff'（已建好空占位，空 desc 查找返回 null）。
 * 5. 若觉的界面与六道椒图一致，可直接参考/复用 316_六道椒图.ts 的取色数据。
 *
 * 建议方案顺序（需自行在 UI 中添加功能 323）：
 * [690, 509, 510, 0, 1, 323, 2, 3, 24, 29, 503]
 * 注意：本功能应排在[2退出结算]前；入口步骤需要方案中包含[29庭院进入探索地图]。
 */
// 主地图固定选择位（1280x720 开发坐标），下标与 d6jueMap.ts 的 D6_MAP_SLOTS 一致。
// 运行时用于两件事：operator[53] 的固定点击区；横幅锚点检测时反推截图缩放比例。
// 混沌秘宝专属点（宝匣/离开按钮）不是纯色，固定用 88 的相似度检查；
// 用户全局 colorSimilar 可能设得更高，会把 2~4 的通道差也判失败。
const D6_CHEST_SIMILAR = 88;

const D6_MAP_SLOT_DEV_RECTS: Array<[number, number, number, number]> = [
	[645, 340, 695, 500], // single
	[384, 320, 424, 490], // two-left
	[885, 350, 940, 510], // two-right
	[265, 310, 320, 460], // three-left
	[710, 340, 765, 500], // three-center
	[1005, 320, 1065, 480], // three-right
	[190, 330, 240, 480], // four-1
	[450, 450, 505, 600], // four-2
	[870, 460, 925, 610], // four-3
	[1000, 360, 1060, 510], // four-4
];

/**
 * 主地图点击分布：以历史横幅锚点重试成功点为样本标定（1280×720 开发坐标）。
 *
 * - x 方向很稳定：σ 取 5~6px；three-right 的真实横幅比原固定中心右移约 21px。
 * - y 方向随行高/镜头波动：σ 取 14~20px，并用 min/max 截断，避免点进岛屿/水面。
 * - 每次点击从截断正态分布重新取点，不是固定连击，也不是固定哈希点。
 * - 点完后的重试次数由 D6StepTracker 的时间门控决定（默认 4.5s/8s），
 *   不做快速连点，避免在岛屿过场里误点事件 UI。
 */
interface D6MapClickDistribution {
	cx: number;
	cy: number;
	sx: number;
	sy: number;
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

const D6_MAP_CLICK_DIST: Array<D6MapClickDistribution | null> = [
	// single 原固定点成功率 97%，中心取原点击均值(671,448)与锚点中位数(663,429)之间，避免回退
	{ cx: 668, cy: 440, sx: 6, sy: 14, xMin: 645, xMax: 690, yMin: 410, yMax: 470 }, // single
	{ cx: 392, cy: 447, sx: 5, sy: 16, xMin: 378, xMax: 410, yMin: 415, yMax: 475 }, // two-left
	// two-right 原固定点成功率 95%，以原均值为中心，仅放宽 x 覆盖偶发的左偏横幅
	{ cx: 910, cy: 450, sx: 16, sy: 20, xMin: 860, xMax: 940, yMin: 380, yMax: 490 }, // two-right
	{ cx: 293, cy: 328, sx: 5, sy: 18, xMin: 278, xMax: 312, yMin: 300, yMax: 360 }, // three-left
	{ cx: 730, cy: 411, sx: 5, sy: 18, xMin: 715, xMax: 748, yMin: 385, yMax: 450 }, // three-center
	{ cx: 1056, cy: 353, sx: 5, sy: 18, xMin: 1045, xMax: 1065, yMin: 320, yMax: 388 }, // three-right
	null, // four-1：样本不足，保留固定点击
	{ cx: 476, cy: 473, sx: 6, sy: 18, xMin: 460, xMax: 495, yMin: 448, yMax: 518 }, // four-2
	null, // four-3
	null, // four-4
];

// 横幅锚点 x 缓存：重试成功一次后，把真实横幅 x 作为后续随机分布的中心。
// 只缓存 x（不同行非常稳定）；y 仍由分布覆盖行高波动。
const d6MapAnchorXCache: { [slotIndex: number]: number } = {};

let d6NormalSpare: number | null = null;

function d6NormalRandom(): number {
	if (d6NormalSpare !== null) {
		const v = d6NormalSpare;
		d6NormalSpare = null;
		return v;
	}
	let u = 0;
	let v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	const r = Math.sqrt(-2 * Math.log(u));
	const a = 2 * Math.PI * v;
	d6NormalSpare = r * Math.sin(a);
	return r * Math.cos(a);
}

function d6Clamp(value: number, min: number, max: number): number {
	return value < min ? min : (value > max ? max : value);
}

function pickD6MapClickPoint(slotIndex: number): { x: number; y: number; cx: number; cy: number } | null {
	const dist = D6_MAP_CLICK_DIST[slotIndex];
	if (!dist) return null;
	const cachedX = d6MapAnchorXCache[slotIndex];
	const cx = cachedX === undefined ? dist.cx : d6Clamp(cachedX, dist.xMin, dist.xMax);
	const x = d6Clamp(cx + d6NormalRandom() * dist.sx, dist.xMin, dist.xMax);
	const y = d6Clamp(dist.cy + d6NormalRandom() * dist.sy, dist.yMin, dist.yMax);
	return { x: Math.round(x), y: Math.round(y), cx: Math.round(cx), cy: dist.cy };
}

export class Func323 implements IFuncOrigin {
	id = 323;
	name = '六道觉';
	desc = '六道之门·觉完整挂机(右上角地图按图标模板识别)；应排在[2退出结算]前';
	config = [{
		desc: '配置',
		config: [{
			name: 'pushResult',
			desc: '结束时使用ospPush推送结果',
			type: 'switch',
			default: false,
		}, {
			name: 'onlyDouble',
			desc: '只打双倍（双倍次数用完自动停止）',
			type: 'switch',
			default: true,
		}, {
			name: 'overTimes',
			desc: '挂机局数，完成后自动切换方案，0表示一直刷',
			type: 'integer',
			default: '0'
		}, {
			name: 'next_scheme',
			desc: '下一个方案',
			type: 'scheme',
			default: '返回庭院',
		}, {
			name: 'coreBuff',
			desc: '核心buff名称（OCR识别，留空则不主动选buff）',
			type: 'text',
			default: '',
		}, {
			name: 'coreBuffMax',
			desc: '核心buff目标层数（0表示不限制）',
			type: 'integer',
			default: '0',
		}, {
			name: 'logMapNodes',
			desc: '识别并记录右上角地图结构（仅日志）',
			type: 'switch',
			default: false,
		}, {
			name: 'perfLog',
			desc: '性能日志（记录地图识别/选buff/状态检查耗时）',
			type: 'switch',
			default: false,
		}, {
			name: 'mapSettleMs',
			desc: '识别到新地图后等待多少毫秒再点击',
			type: 'integer',
			default: '1000',
		}, {
			name: 'mapRetryMs',
			desc: '地图点击未生效后的重试等待（毫秒）',
			type: 'integer',
			default: '700',
		}, {
			name: 'stepRetryMs',
			desc: '点击岛屿后未观测到进岛/换行证据时的重试等待（毫秒）；过短会在入岛动画期间重复点击',
			type: 'integer',
			default: '4500',
		}, {
			name: 'walletOcr',
			desc: '万相铃按每岛固定收益计算，商店/选buff时OCR校验并校准；关闭OCR后只靠计算，可能累积误差',
			type: 'switch',
			default: true,
		}, {
			name: 'buffBlacklist',
			desc: 'buff黑名单（逗号分隔，默认：六道·混沌,六道·偶戏,妖力化身,攻击加成,背水一战；其中妖力化身/攻击加成/背水一战始终强制加入；名称需在 multiFindColors.ts 配置 六道觉_buff_<名称> 多点找色）',
			type: 'text',
			default: DEFAULT_BUFF_BLACKLIST,
		}],
	}];
	// 注意：数组索引必须与注释中的状态编号严格一致，空状态也要保留占位，否则 thisOperator[n] 会错位
	operator: IFuncOperatorOrigin[] = [{ // 0 探索地图 -> 进入六道之门
		// TODO(六道觉): 取色（探索地图界面）
		// 坐标沿用 316[31]，进入位置不同再调整
		oper: [
			[center, 1280, 720, 936, 649, 977, 683, 1000],
		],
	}, { // 1 六道之门 -> 选择「觉」
		// TODO(六道觉): 取色（六道之门副本选择界面）
		// TODO(六道觉): 补充点击「觉」的 oper
	}, { // 2 六道觉 -> 进入副本
		// TODO(六道觉): 取色（觉副本详情/准备界面）
		// TODO(六道觉): 补充进入/挑战按钮的 oper
	}, { // 3 六道觉 -> 开启-六道觉（开新局，重置本局统计）
		// 已取色：开启-六道觉
		desc: [1280, 720,
			[
				[right, 1100, 51, 0xf7e52c],
				[right, 1157, 605, 0x272727],
				[right, 1174, 646, 0xc2dee7],
				[right, 916, 650, 0xd2fbff],
				[left, 91, 631, 0xfb91b1],
			]
		],
		oper: [
			[right, 1280, 720, 1120, 600, 1210, 680, 1500], // 开启-六道觉
		],
	}, { // 4 六道觉 -> 选事件界面
		// 事件判定只依赖唤息（状态 37/44）：暗/亮任一命中即处理，节点由小地图决定
		// TODO(六道觉): 如需保留通用选事件界面识别，可在此取色
	}, { // 5 六道觉 -> 事件图标（已废弃：目标完全由小地图决定，不再使用事件图标兜底）
	}, { // 6 六道觉 -> 选buff界面
		// 舞技强化/buff选择判定改为「备战 + 刷新」双条件，见状态 36/39
		// TODO(六道觉): 如仍需单独识别该界面，可在此取色
	}, { // 7 选buff_OCR区域（仅坐标，不参与状态判定，由[6]调用）
		// TODO(六道觉): 填入3个buff名称识别区域 + 3个对应的点击区域
		// 示例坐标参考 316[33]，确认觉的界面后再调整：
		// oper: [
		// 	[center, 1280, 720, 150, 331, 280, 375, 1000], // 识别区域1
		// 	[center, 1280, 720, 407, 330, 573, 375, 1000], // 识别区域2
		// 	[center, 1280, 720, 679, 324, 841, 375, 1000], // 识别区域3
		// 	[center, 1280, 720, 170, 580, 270, 610, 1000], // 点击区域1
		// 	[center, 1280, 720, 440, 580, 540, 610, 1000], // 点击区域2
		// 	[center, 1280, 720, 710, 580, 820, 610, 1000], // 点击区域3
		// ],
	}, { // 8 六道觉 -> 选buff_选择第一个/跳过
		// TODO(六道觉): 取色
		// TODO(六道觉): 补充点击坐标（第一个buff的选中/跳过按钮）
	}, { // 9 六道觉 -> 选buff_低级buff（选择跳过，不浪费刷新）
		// TODO(六道觉): 取色
		// oper 可参考 316[25]/[26]
	}, { // 10 六道觉 -> 选buff_刷新
		// TODO(六道觉): 取色
		// oper 可参考 316[17]/[18]：右下角刷新按钮
		// [center, 1280, 720, 1191, 621, 1243, 676, 2000]
	}, { // 11 六道觉 -> 选buff_刷新确认
		// TODO(六道觉): 取色
		// oper 可参考 202[2]：刷新弹窗确认按钮
	}, { // 12 六道觉 -> 核心buff满层检测
		// TODO(六道觉): 取色（左侧buff栏满层标识）
		// 参考 316[35] 柔风满层
	}, { // 13 六道觉 -> 商店界面
		// 已取色：商店界面
		desc: [1280, 720,
			[
				[right, 1227, 154, 0xc6dfd4],
				[right, 1227, 637, 0xe9d3b1],
				[right, 1227, 286, 0x2e4550],
				[left, 111, 45, 0x57616e],
				[right, 1228, 335, 0x3c5265],
			]
		],
	}, { // 14 六道觉 -> 商店购买buff（动态位置，不参与状态判定）
		// 可购买buff图标通过 findMultiColor('六道觉_购买buff') 定位，
		// 取色数据填在 src/common/multiFindColors.ts
	}, { // 15 六道觉 -> 商店_确认购买
		// 按实机截图取色：米色弹窗背景 + 红色取消 + 金色确定
		desc: [1280, 720,
			[
				[left, 115, 37, 0x66645c],
				[left, 212, 30, 0x66645c],
				[center, 500, 300, 0xd9c5ae],
				[center, 800, 300, 0xd9c5ae],
				[center, 450, 430, 0xda624a],
				[center, 700, 430, 0xe9b05e],
			]
		],
		oper: [
			[center, 1280, 720, 678, 409, 837, 453, 500], // 确认购买
		],
	}, { // 16 六道觉 -> 商店_退出
		// TODO(六道觉): 取色
		// oper 可参考 316[7].oper[1]：[center, 1280, 720, 1174, 588, 1241, 649, 500]
	}, { // 17 六道觉 -> 神秘_转换
		// 已取色：神秘之屿-技能转换
		desc: [1280, 720,
			[
				[left, 122, 36, 0xf8f3e0],
				[left, 139, 35, 0xf8f3e0],
				[left, 122, 45, 0xf8f3e0],
				[left, 182, 671, 0x234862],
			]
		],
		oper: [
			[center, 1280, 720, 10, 20, 50, 65, 500], // 关闭/返回
		],
	}, { // 18 六道觉 -> 宝箱
		// TODO(六道觉): 取色
		// oper 可参考 316[5]：右下角宝箱
	}, { // 19 六道觉 -> 特殊事件（星之屿/鏖战等）
		// TODO(六道觉): 取色
		// oper 可参考 316[8]/[3]：中间事件图标
	}, { // 20 六道觉 -> 战斗_挑战
		// 已取色：挑战按钮
		desc: [1280, 720,
			[
				[right, 1156, 643, 0xd2e7ef],
				[right, 1172, 627, 0x2d2d2d],
				[right, 1128, 584, 0x2f2f2f],
				[right, 1197, 592, 0xb5bcd1],
				[left, 182, 671, 0x274962],
			]
		],
		oper: [
			[center, 1280, 720, 1125, 590, 1205, 665, 1500], // 挑战
		],
	}, { // 21 六道觉 -> 战斗_使用双倍
		// TODO(六道觉): 取色
		// oper 可参考 316[21]：[center, 1280, 720, 671, 419, 794, 467, 1000]
	}, { // 22 六道觉 -> 战斗_取消双倍
		// TODO(六道觉): 取色
		// oper 可参考 316[22]：[center, 1280, 720, 491, 419, 615, 471, 1000]
	}, { // 23 六道觉 -> 战斗_跳过
		// TODO(六道觉): 取色
		// oper 可参考 316[20]：[center, 1280, 720, 1140, 24, 1215, 40, 500]
	}, { // 24 六道觉 -> 战斗失败_放弃前行
		// 复用 316 的战斗失败界面取色；TODO(六道觉): 拿到六道觉失败截图后再校准
		desc: [1280, 720,
			[
				[center, 449, 224, 0x724d3c],
				[center, 442, 425, 0xdf6851],
				[center, 691, 415, 0xf3b25e],
				[center, 871, 223, 0x634334],
				[center, 836, 406, 0x983b2e],
				[center, 431, 371, 0xcbb59c],
				[center, 846, 379, 0xcbb59c],
			]
		],
		oper: [
			[center, 1280, 720, 673, 406, 844, 458, 1000],
		],
	}, { // 25 六道觉 -> 战斗失败_确定放弃
		// 复用 316 的战斗失败界面取色；TODO(六道觉): 拿到六道觉失败截图后再校准
		desc: [1280, 720,
			[
				[center, 442, 222, 0x644434],
				[center, 819, 222, 0x6a4737],
				[center, 475, 352, 0xcbb59c],
				[center, 692, 417, 0xf3b25e],
				[center, 575, 408, 0xdf6851],
				[center, 800, 397, 0x993b2f],
				[center, 795, 346, 0xcbb59c],
				[center, 478, 364, 0xcbb59c],
			]
		],
		oper: [
			[center, 1280, 720, 680, 397, 802, 448, 1000],
		],
	}, { // 26 六道觉 -> 结算_奖励弹窗
		// TODO(六道觉): 取色
		// oper 可参考 316[13]：[right, 1280, 720, 913, 129, 1245, 648, 500]
	}, { // 27 六道觉 -> 结算_御神经验
		// TODO(六道觉): 取色
		// oper 可参考 316[24]
	}, { // 28 六道觉 -> 结算_完成（统计、推送、切换方案）
		// 已取色：六道觉结算界面
		desc: [1280, 720,
			[
				[right, 1195, 639, 0xd3c5ab],
				[right, 1208, 631, 0x2d2c2b],
				[right, 1183, 684, 0x928a7a],
				[right, 1190, 670, 0x3e3b31],
				[right, 1160, 667, 0x646159],
			]
		],
		oper: [
			[center, 1280, 720, 394, 617, 903, 699, 1000], // 结算-继续
		],
	}, { // 29 六道觉 -> 双倍次数为0
		// TODO(六道觉): 取色（开始界面的双倍次数标识）
		// 参考 316[34]
	}, { // 30 六道觉 -> 继续
		// TODO(六道觉): 取色
		// oper 可参考 316[32]：继续/下一步按钮
	}, { // 31 六道觉 -> 确认-选择试炼式神
		// 已取色：确认-选择试炼式神
		desc: [1280, 720,
			[
				[right, 1128, 577, 0x2c2c2c],
				[right, 1186, 477, 0xceffff],
				[right, 1170, 647, 0xc3dce6],
				[right, 1126, 644, 0x376a92],
				[right, 1233, 643, 0x425d82],
			]
		],
		oper: [
			[right, 1280, 720, 1130, 590, 1210, 660, 1500], // 确认-选择试炼式神
		],
	}, { // 32 六道觉 -> 开启-上阵式神
		// 已取色：开启-上阵式神
		desc: [1280, 720,
			[
				[right, 1158, 576, 0x242424],
				[right, 1185, 478, 0xceffff],
				[right, 1184, 636, 0xc6e3eb],
				[right, 1240, 635, 0x476893],
				[right, 1156, 619, 0xcee4ec],
			]
		],
		oper: [
			[right, 1280, 720, 1140, 590, 1220, 660, 1500], // 开启-上阵式神
		],
	}, { // 33 六道觉 -> 选择舞技
		// 已取色：选择舞技界面
		desc: [1280, 720,
			[
				[right, 1044, 378, 0x762a05],
				[right, 1051, 559, 0x246aa0],
				[right, 1011, 619, 0x173d6b],
				[right, 1123, 619, 0x85b3b7],
			]
		],
		oper: [
			[right, 1280, 720, 1000, 610, 1090, 635, 500], // 选择舞技
		],
	}, { // 34 六道觉 -> 初始技能界面（三选一随机）
		// 已取色：初始技能界面
		desc: [1280, 720,
			[
				[left, 312, 186, 0xe0b8c1],
				[right, 645, 199, 0x317bde],
				[right, 960, 198, 0xba382d],
				[left, 184, 672, 0x204157],
			]
		],
	}, { // 35 初始技能_点击区域（仅坐标，不参与状态判定，由[34]随机选一个）
		oper: [
			[center, 1280, 720, 270, 555, 380, 590, 500], // 技能1
			[center, 1280, 720, 585, 555, 700, 590, 500], // 技能2
			[center, 1280, 720, 900, 555, 1010, 590, 500], // 技能3
		],
	}, { // 36 六道觉 -> 备战（事件界面左下角，仅保留取色，不再作为地图处理门禁）
		// 已取色：左下角备战
		desc: [1280, 720,
			[
				[left, 32, 680, 0x407a97],
				[left, 182, 672, 0x315169],
				[left, 136, 673, 0x2f5166],
				[left, 233, 681, 0x2e60a1],
			]
		],
		notForCnt: true,
	}, { // 37 六道觉 -> 唤息_暗（事件界面右下角，仅识别）
		// 已取色：右下角暗色唤息
		desc: [1280, 720,
			[
				[right, 1188, 619, 0x484848],
				[right, 1156, 601, 0x555555],
				[right, 1134, 606, 0x5d5d5d],
				[right, 1149, 591, 0x484848],
			]
		],
		notForCnt: true,
	}, { // 38 六道觉 -> 鏖战_选择怪物（进入鏖战之屿后的敌人选择界面）
		// 注意：这里不是主地图上的鏖战节点。
		// 主地图节点由小地图结构推断后点击 operator[53] 的固定选择位，不再单独取锚点；
		// 本状态对应进入鏖战后左右两个敌人的选择界面，点击右侧敌人 730,250-880,420。
		// 已取色：标题「鏖战之屿」+ 左右敌人区域
		desc: [1280, 720,
			[
				[left, 120, 40, 0xf7f2df],
				[left, 116, 48, 0xf8f3e0],
				[left, 138, 41, 0xf8f3e0],
				[left, 150, 35, 0xf7f2df],
				[center, 440, 264, 0x355080],
				[right, 738, 415, 0x6976a0],
				[left, 250, 40, 0x573514],
			]
		],
		oper: [
			[center, 1280, 720, 730, 250, 880, 420, 0], // 右侧怪物
		],
	}, { // 39 六道觉 -> 舞技强化_刷新（仅识别）
		// 已取色：buff选择/舞技强化界面右下角刷新
		desc: [1280, 720,
			[
				[right, 1216, 634, 0xa6fdff],
				[right, 1240, 647, 0x2b4569],
				[right, 1184, 647, 0x294366],
				[right, 1205, 657, 0xecfafe],
			]
		],
		notForCnt: true,
	}, { // 40 六道觉 -> 舞技强化
		// 已取色：舞技强化
		desc: [1280, 720,
			[
				[right, 1093, 184, 0xfbf9e4],
				[right, 1093, 176, 0xfaf8e7],
				[right, 1103, 203, 0xf7f1cb],
				[right, 1088, 483, 0x313a45],
			]
		],
		oper: [
			[center, 1280, 720, 1030, 555, 1150, 590, 500], // 舞技强化
		],
	}, { // 41 六道觉 -> 舞技强化-选择强化
		// 已取色：舞技强化-选择强化界面
		desc: [1280, 720,
			[
				[left, 280, 267, 0xffffea],
				[right, 642, 276, 0xffffff],
				[right, 1021, 255, 0x953e5b],
				[left, 295, 462, 0x2a6b9e],
				[right, 654, 454, 0x1e6297],
				[right, 1010, 458, 0x22669b],
			]
		],
		oper: [
			[center, 1280, 720, 245, 505, 335, 535, 500], // 选择强化
		],
	}, { // 42 六道觉 -> 获得奖励界面
		// 已取色：获得奖励
		desc: [1280, 720,
			[
				[center, 571, 165, 0xfce7a1],
				[center, 622, 146, 0xfbe392],
				[right, 672, 168, 0xffe8a6],
				[right, 720, 155, 0xfbe598],
				[right, 751, 159, 0xfbe69e],
			]
		],
		oper: [
			[center, 1280, 720, 388, 552, 897, 704, 500], // 获得奖励-继续
		],
	}, { // 43 六道觉 -> 神秘_仿造
		// 已取色：神秘_仿造
		desc: [1280, 720,
			[
				[right, 1185, 622, 0x958858],
				[right, 1221, 655, 0x968552],
				[right, 1221, 631, 0x2b2920],
				[right, 1171, 679, 0x1c1b1a],
				[right, 1148, 657, 0x101011],
			]
		],
		oper: [
			[center, 1280, 720, 10, 20, 50, 65, 500], // 关闭/返回
		],
	}, { // 44 六道觉 -> 唤息_亮/金
		// 已取色：右下角亮色唤息
		desc: [1280, 720,
			[
				[right, 1188, 619, 0x58452e],
				[right, 1156, 601, 0x69522e],
				[right, 1134, 606, 0x735b31],
				[right, 1149, 591, 0x59452d],
			]
		],
		notForCnt: true,
	}, { // 45 六道觉 -> 绽放_离开
		// 已取色：绽放之屿，右下角直接离开
		desc: [1280, 720,
			[
				[right, 1201, 657, 0xecdaba],
				[right, 1180, 658, 0xe9d4b1],
				[right, 1183, 629, 0x0e0b08],
				[right, 1182, 688, 0x282016],
				[right, 1073, 693, 0x7f99b7],
			]
		],
		oper: [
			[center, 1280, 720, 1160, 635, 1205, 680, 1500], // 绽放-离开
		],
	}, { // 46 六道觉 -> 混沌_精英
		// 只用左上角「混沌之屿」标题的 5 个取色点，不再绑定精英立绘/名字条。
		// 混沌秘宝由 operator[47] 先判断；47 判断不到时才按精英处理。
		desc: [1280, 720,
			[
				[left, 148, 29, 0xf8f3e0],
				[left, 159, 51, 0xf8f3e0],
				[left, 186, 50, 0xf8f3e0],
				[left, 211, 38, 0xf7f2df],
				[left, 128, 52, 0xf8f3e0],
			]
		],
		oper: [
			[center, 1280, 720, 625, 230, 760, 380, 500], // 混沌-精英
		],
	}, { // 47 六道觉 -> 混沌_幸运秘宝
		// 已取色：混沌之屿-幸运秘宝
		desc: [1280, 720,
			[
				[left, 128, 52, 0xf8f3e0],
				[left, 159, 51, 0xf8f3e0],
				[left, 184, 49, 0xf8f3e0],
				[left, 203, 43, 0xf8f3e0],
				// 只用右下角「离开」按钮做秘宝专属点。宝匣/横幅会随开箱动画变化，
				// 用其取色会在 46 反复点宝匣时永远匹配不到；离开按钮是静态的，
				// 且精英界面没有这个按钮（精英对应点为蓝色背景，diff 100+）。
				// 离开按钮上取 3 个点：外圈暗部、内圈金边、白色出口箭头。
				[right, 1168, 633, 0x090704],
				[right, 1185, 675, 0xdbbf92],
				[right, 1200, 658, 0xead5b4],
			]
		],
		oper: [
			[center, 1280, 720, 1160, 635, 1200, 685, 1500], // 混沌-幸运秘宝
		],
	}, { // 48 已废弃：只剩两个舞技选择
		// 力量满后不会再走这个界面；保留空位避免后续索引变化
	}, { // 49 六道觉 -> 舞技强化_刷新_暗（刷新次数用完）
		// 已取色：暗色刷新
		desc: [1280, 720,
			[
				[right, 1205, 658, 0xf7f7f7],
				[right, 1217, 634, 0xe3e3e3],
				[right, 1184, 648, 0x3f3f40],
				[right, 1240, 647, 0x414141],
			]
		],
		notForCnt: true,
	}, { // 50 六道觉 -> 首领挑战
		// 已取色：首领挑战界面
		desc: [1280, 720,
			[
				[right, 891, 642, 0x175c8f],
				[right, 1146, 647, 0xcde7ef],
				[right, 1117, 592, 0x2f2f2f],
				[right, 1162, 637, 0x2c2c2c],
				[right, 1187, 603, 0xb1b9ce],
			]
		],
		oper: [
			[center, 1280, 720, 1120, 600, 1200, 675, 1500], // 首领挑战
		],
	}, { // 51 六道觉 -> 万象赐福使用
		// 已取色：万象赐福使用界面
		desc: [1280, 720,
			[
				[center, 616, 336, 0x8b62a3],
				[right, 653, 336, 0x8d64a5],
				[center, 631, 349, 0x5a4273],
				[right, 662, 376, 0xf8e627],
				[right, 727, 443, 0xf3b25e],
			]
		],
		oper: [
			[center, 1280, 720, 670, 425, 783, 463, 1000], // 使用万象赐福
		],
	}, { // 52 六道觉 -> 商店_刷新（仅识别）
		// 已取色：商店刷新按钮
		desc: [1280, 720,
			[
				[center, 611, 632, 0xfff9df],
				[center, 622, 608, 0x79b6d3],
				[center, 620, 623, 0x273e62],
				[center, 611, 614, 0x24395a],
			]
		],
		notForCnt: true,
	}, { // 53 六道觉 -> 主地图固定选择位（只按小地图推断的数量/顺序点击，不做状态判定）
		// 下标与 d6jueMap.ts 的 D6_MAP_SLOTS 严格一致：
		// 0=单个(中)；1=两个(左)；2=两个(右)；3=三个(左)；4=三个(中)；5=三个(右)
		// 6~9=四个(从左到右)。
		// 实测：点岛屿平台/水面无效，必须点岛屿上方的竖排横幅/名称。以下区域都对准横幅。
		oper: [
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[0], 500], // single
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[1], 500], // two-left（实机横幅在 x≈390~415，原中心偏左）
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[2], 500], // two-right
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[3], 500], // three-left
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[4], 500], // three-center
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[5], 500], // three-right
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[6], 500], // four-1
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[7], 500], // four-2
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[8], 500], // four-3
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[9], 500], // four-4
		],
	}];
	operatorFunc(thisScript: Script, thisOperator: IFuncOperator[]): boolean {
		// Rhino 首次调用 analyzeD6Map 才编译其中的热点循环，导致进图后第一次识别明显变慢。
		// 这里在 323 首次执行时用合成图预热，把一次性成本提前到开局阶段。
		if (!mapWarmedUp) {
			mapWarmedUp = true;
			warmUpD6Map();
			let warmBmp: any = null;
			try {
				warmBmp = android.graphics.Bitmap.createBitmap(32, 32, android.graphics.Bitmap.Config.ARGB_8888);
				bitmapToImageData(warmBmp);
			} catch (e) {
				// 预热失败忽略
			} finally {
				try {
					if (warmBmp) warmBmp.recycle();
				} catch (e) {
					// 忽略回收异常
				}
			}
		}
		const thisConf = thisScript.scheme.config['323'] || {};
		const g = thisScript.global;
		const mapSettleMs = Math.max(0, parseInt(String(thisConf.mapSettleMs === undefined ? D6_MAP_SETTLE_MS : thisConf.mapSettleMs), 10) || 0);
		const mapRetryMs = Math.max(500, parseInt(String(thisConf.mapRetryMs === undefined ? D6_MAP_SIG_WAIT : thisConf.mapRetryMs), 10) || D6_MAP_SIG_WAIT);
		// 点击后多久没有离图/岛屿证据才允许重试。换行/入岛动画可能持续 3~4s，
		// 这里优先保证不多点，失败重试慢一点可以接受。
		const stepRetryMs = Math.max(2500, mapRetryMs, parseInt(String(thisConf.stepRetryMs === undefined ? 4500 : thisConf.stepRetryMs), 10) || 4500);
		const now = () => new Date().getTime();

		// 首领战超过 60 秒仍未结算，停止脚本，避免失败界面未识别时无限挂机
		if (g.d6jueBossStartTime && now() - g.d6jueBossStartTime > 60000) {
			const msg = '首领战超过60秒未结束，停止脚本';
			console.log('[d6jue] ' + msg);
			d6jueAnalysisLog('boss.timeout', {
				step: g.d6jueStepLeft || 0,
				power: g.d6juePowerLevel || 0,
				lei: g.d6jueLeiLevel || 0,
			});
			g.d6jueBossStartTime = 0;
			thisScript.myToast(msg);
			thisScript.rerun('__停止脚本__');
			return true;
		}
		const perfLogEnabled = !!thisConf.perfLog;
		const perfLog = (name: string, ms: number, detail = '', alwaysFile = false) => {
			const line = `[d6jue-perf] ${name} ${ms}ms${detail ? ' ' + detail : ''}`;
			if (perfLogEnabled || ms >= 120) console.log(line);
			if (alwaysFile || perfLogEnabled || ms >= 120) perfLogLine(line);
		};
		if (!mapSwitchLogged) {
			const orderText = (priority: { [key: string]: number }) => Object.keys(priority)
				.sort((a, b) => priority[b] - priority[a])
				.join(' > ');
			console.log(`[d6jue-map] switch=${!!thisConf.logMapNodes}`);
			console.log('[d6jue-map] 识别方式=图标模板+行列结构推断，主地图按可达节点顺序点固定选择位');
			console.log(`[d6jue-map] 岛屿顺序(未通关): ${orderText(MAP_PRIORITY)}`);
			console.log(`[d6jue-map] 岛屿顺序(通关后): ${orderText(MAP_PRIORITY_CLEARED)}`);
			mapSwitchLogged = true;
		}

		// 只使用已取色的状态，未填 desc 的 TODO 占位不会命中
		const isReady = (item?: IFuncOperator): item is IFuncOperator => !!(item && item.desc && item.desc.length);

		// 步数状态机：纯逻辑在 d6jueStepTracker.ts，这里只负责配置和同步到 g。
		const getStepTracker = (): D6StepTracker => {
			if (!stepTracker) {
				// 进程刚启动时无法确定是“新开局”还是“中途接手”：
				// 先按满步数、未初始化处理，由计数器连续两次一致后再校准到真实剩余步数。
				// 这样不会把上一次运行残留的 g.d6jueStepLeft 当成当前局的步数。
				stepTracker = new D6StepTracker({ totalSteps: D6_TOTAL_STEPS });
				stepTracker.reset(D6_TOTAL_STEPS, false, now());
				d6jueAnalysisLog('step.init', { left: D6_TOTAL_STEPS, mode: 'lazy' });
			}
			stepTracker.configure({
				totalSteps: D6_TOTAL_STEPS,
				settleMs: mapSettleMs,
				retryMinMs: stepRetryMs,
				retryHashChangedMs: Math.max(stepRetryMs, 8000),
				weakRowMs: 3500,
				counterMinConfidence: 0.55,
				bloomEvery: 5,
				bloomFixMaxGap: 2,
				counterConfirmGapMs: 2000,
			});
			return stepTracker;
		};
		const syncStepState = () => {
			const tracker = getStepTracker();
			g.d6jueStepLeft = tracker.left;
			g.d6jueStepPending = tracker.pending;
		};
		// 岛屿界面证据：只标记 committed，真正扣步等下一次稳定地图。
		const noteStepIsland = (source: string) => {
			if (!stepTracker || !stepTracker.pending) return;
			if (!stepTracker.noteIsland(now(), source)) return;
			d6jueAnalysisLog('step.island_seen', {
				source,
				left: stepTracker.left,
				step: stepTracker.stepNo,
				seq: stepTracker.islandSeq,
			});
		};
		getStepTracker();
		syncStepState();

		const oper = (indexes: number[], name: string, retest = 0): boolean => {
			const operator = indexes.map(index => thisOperator[index]).filter(isReady);
			if (operator.length === 0) return false;
			const t0 = now();
			const matched = !!thisScript.oper({ id: 323, name, operator }, retest);
			const dt = now() - t0;
			if (perfLogEnabled || dt >= 120) perfLog(`oper ${name}`, dt, `matched=${matched} retest=${retest}`);
			if (matched && stepTracker && stepTracker.pending) {
				for (let i = 0; i < indexes.length; i++) {
					if (!D6_STEP_MAP_OPERATORS[indexes[i]]) {
						noteStepIsland(name);
						break;
					}
				}
			}
			return matched;
		};

		// 选择 buff/舞技后锁住，直到选择界面消失。
		// 混沌精英第二轮选 buff 时选择界面不会消失，而是直接换成下一组卡；
		// 原来固定 8s 会把第二轮硬拖到 8s 后才处理（实测两次 buff.pick 间隔 9.1~9.5s）。
		// 2.5s 足够覆盖选卡/舞技强化的切换动画，又能让第二轮及时开始。
		const buffSelectLocked = () => buffSelectLockActive && now() < buffSelectLockUntil;
		const lockBuffSelect = () => {
			buffSelectLockActive = true;
			buffSelectLockUntil = now() + 2500;
		};

		// 选择锁：buff/舞技界面已经切走就解除，超时兜底，避免卡死
		if (buffSelectLockActive) {
			const selectOps = [39, 41, 49].map(index => thisOperator[index]).filter(isReady);
			const stillSelecting = selectOps.length > 0 && thisScript.desc({
				id: 323,
				name: '六道觉_选择界面锁检测',
				operator: selectOps,
			}, thisScript.scheme.commonConfig);
			if (!stillSelecting || now() >= buffSelectLockUntil) {
				// 锁到期时选择界面还在：多发生在混沌精英第二轮直接换卡，
				// 记录一次便于确认这次延迟是否由选择锁造成。
				if (stillSelecting) {
					d6jueAnalysisLog('buff.lock_timeout', { ms: 2500 });
				}
				buffSelectLockActive = false;
				buffSelectLockUntil = 0;
			}
		}
		// 选择动画期间不再执行任何点击（包括舞技强化的选择按钮），等界面切走
		if (buffSelectLocked()) return true;

		// 万相铃计算：进岛 +50 每岛一次；选buff +100 按界面计。
		const addWanxiangling = (amount: number, source: string) => {
			g.d6jueWanxiangling = (g.d6jueWanxiangling || 0) + amount;
			console.log(`[d6jue-wanxiangling] ${source}+${amount}，当前=${g.d6jueWanxiangling}`);
			d6jueAnalysisLog('wallet.gain', {
				amount,
				source,
				wallet: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				island: d6IslandKey,
			});
		};
		// 岛屿上下文：每次点击主地图节点时换 key；同一节点的重试沿用同一 key。
		const beginIsland = (key: string) => {
			if (key === d6IslandKey) return;
			d6IslandKey = key;
			d6IslandGainDone = false;
		};
		const ensureIsland = () => {
			if (!d6IslandKey) beginIsland(`mid:${g.d6jueStepLeft || 0}`);
		};
		// 每座岛 +50 只记一次；source 记录实际到账触发点
		const addIslandGainOnce = (source: string) => {
			ensureIsland();
			if (d6IslandGainDone) return;
			d6IslandGainDone = true;
			addWanxiangling(D6_ISLAND_GAIN, source);
		};
		// 刷新费用不盲目扣：OCR 可用时先挂起，等下一次 OCR 读数校验；
		// OCR 关闭时没有校验手段，退回点击即扣。
		const beginPendingRefreshCost = (cost: number, source: string, walletBefore: number) => {
			if (thisConf.walletOcr === false) {
				g.d6jueWanxiangling = Math.max(0, walletBefore - cost);
				return;
			}
			d6PendingRefreshCost = cost;
			d6PendingRefreshSource = source;
			d6PendingRefreshWalletBefore = walletBefore;
			d6PendingRefreshTime = now();
		};
		// OCR 用于校验/校准每岛固定收益计算：读到值后和计算值比较，差值合理才同步。
		const readWanxianglingOcr = (tag: string) => {
			if (thisConf.walletOcr === false) return;
			// 等待卡面动画期间已经并行跑过 buff OCR，调用方紧接着的那次直接跳过。
			// 只跳过一次：消费后立刻清零，避免影响下一次刷新的费用校验。
			if (tag === 'buff' && now() < d6BuffWalletOcrSkipUntil) {
				d6BuffWalletOcrSkipUntil = 0;
				return;
			}
			const t = now();
			if (t - lastWalletOcrTime < 1200) return;
			lastWalletOcrTime = t;
			try {
				const helper = thisScript.helperBridge.helper;
				const readRegion = (x1: number, y1: number, x2: number, y2: number) => {
					const sr = helper.GetPoint(x1, y1, right);
					const er = helper.GetPoint(x2, y2, right);
					const result = thisScript.findNum(0, [sr.x, sr.y, er.x, er.y]);
					const list = Array.isArray(result) ? result : [];
					const out: { text: string; value: number }[] = [];
					for (const item of list) {
						const text = item && item.label !== undefined ? String(item.label) : '';
						const value = parseInt(text.replace(/[^\d]/g, ''), 10);
						if (!isNaN(value)) out.push({ text, value });
					}
					return out;
				};
				const leadingZero = (text: string) => {
					const digits = text.replace(/[^\d]/g, '');
					return digits.length > 1 && digits.charAt(0) === '0';
				};
				const internal = g.d6jueWanxiangling || 0;
				const regions = [[1160, 8, 1275, 62], [1100, 0, 1270, 60]];
				let chosen: { text: string; value: number } | null = null;
				let first: { text: string; value: number } | null = null;
				const allText: string[] = [];
				for (const region of regions) {
					const candidates = readRegion(region[0], region[1], region[2], region[3]);
					for (const candidate of candidates) {
						if (leadingZero(candidate.text)) continue;
						allText.push(candidate.text);
						if (!first) first = candidate;
						if (Math.abs(candidate.value - internal) <= D6_WALLET_OCR_DIFF_MAX
							&& (!chosen || Math.abs(candidate.value - internal) < Math.abs(chosen.value - internal))) {
							chosen = candidate;
						}
					}
					// 第一个区域读数与计算值接近就直接用；差得较多时再读旧区域，防止少读前导数字
					if (chosen && Math.abs(chosen.value - internal) <= 200) break;
				}
				const picked = chosen || first;
				const value = picked ? picked.value : NaN;
				const valid = !isNaN(value) && value >= 0 && Math.abs(value - internal) <= D6_WALLET_OCR_DIFF_MAX;
				const pendingCost = d6PendingRefreshCost;
				const pendingSource = d6PendingRefreshSource;
				const pendingBefore = d6PendingRefreshWalletBefore;
				let calc = internal;
				let costVerified = 0;
				let costDrop: number | '' = '';
				if (valid && pendingCost > 0) {
					costDrop = pendingBefore - value;
					costVerified = Math.abs(costDrop - pendingCost) <= 20 ? 1 : 0;
					if (costVerified) calc = Math.max(0, internal - pendingCost);
					d6PendingRefreshCost = 0;
					d6PendingRefreshSource = '';
					d6PendingRefreshWalletBefore = 0;
					d6PendingRefreshTime = 0;
					d6jueAnalysisLog('wallet.cost_check', {
						source: pendingSource,
						cost: pendingCost,
						before: pendingBefore,
						ocr: value,
						drop: costDrop,
						verified: costVerified,
						applied: costVerified,
						step: g.d6jueStepLeft || 0,
					});
					console.log(`[d6jue-wallet] ${pendingSource}费用校验: 预期-${pendingCost} 实际-${costDrop} ${costVerified ? '✓' : '✗'}`);
				} else if (!valid && pendingCost > 0 && now() - d6PendingRefreshTime > 8000) {
					// 刷新后要等卡面稳定（buff 最长约 4s），再留给下一轮 OCR；超时放宽到 8s
					d6PendingRefreshCost = 0;
					d6PendingRefreshSource = '';
					d6PendingRefreshWalletBefore = 0;
					d6PendingRefreshTime = 0;
					d6jueAnalysisLog('wallet.cost_check', {
						source: pendingSource,
						cost: pendingCost,
						before: pendingBefore,
						verified: 0,
						applied: 0,
						reason: 'ocr_timeout',
						step: g.d6jueStepLeft || 0,
					});
					console.log(`[d6jue-wallet] ${pendingSource}费用OCR校验超时，未自动扣费`);
				}
				const rawDiff = valid ? value - calc : '';
				let synced = 0;
				let walletAfter = internal;
				if (valid) {
					walletAfter = calc;
					if (value !== calc) {
						walletAfter = value;
						synced = 1;
						d6jueAnalysisLog('wallet.sync', {
							tag,
							from: calc,
							to: value,
							delta: value - calc,
							ocr: value,
							rawDiff,
							step: g.d6jueStepLeft || 0,
						});
						console.log(`[d6jue-wallet] OCR校准(${tag}) 计算 ${calc} -> ${value}（差=${rawDiff}）`);
					}
					if (walletAfter !== internal) g.d6jueWanxiangling = walletAfter;
				}
				d6jueAnalysisLog('wallet.ocr', {
					tag,
					ocr: valid ? value : '?',
					text: picked ? picked.text : allText.join('|'),
					rawValue: picked ? picked.value : '',
					wallet: internal,
					walletAfter,
					diff: rawDiff,
					costVerified,
					readError: valid ? 0 : 1,
					synced,
					step: g.d6jueStepLeft || 0,
				});
				console.log(`[d6jue-wallet] OCR(${tag}) 游戏=${valid ? value : '?'}${valid ? '' : `（读取异常${allText.length ? ':' + allText.join('|') : ''}）`} 计算=${internal}${valid ? ` 校验后=${calc} 差=${rawDiff}` : ''}`);
			} catch (e) {
				console.log(`[d6jue-wallet] OCR(${tag}) 异常: ${e}`);
			}
		};
		// 离开当前 buff 界面/换下一组卡时重置入场与刷新计数
		const resetBuffScreenState = () => {
			d6BuffScreenSettled = false;
			d6BuffRefreshCount = 0;
			d6BuffLastRefreshTime = 0;
			d6BuffScreenLastSeen = 0;
			d6BuffWalletOcrSkipUntil = 0;
		};

		// 读取当前缓存帧的 buff 卡面哈希。
		// GetBitmap 读的是本轮 keepScreen 的缓存帧，轮询前必须先 keepScreen() 更新。
		const readBuffCardsHash = (): string => {
			try {
				const helper = thisScript.helperBridge.helper;
				const region = D6_BUFF_CARDS_DEV_REGION;
				const sr = helper.GetPoint(region.x0, region.y0, left);
				const er = helper.GetPoint(region.x1, region.y1, left);
				if (sr.x >= er.x || sr.y >= er.y) return '';
				const bitmap = helper.GetBitmap(sr.x, sr.y, er.x, er.y);
				if (!bitmap) return '';
				try {
					return d6BuffCardsImageHash(bitmapToImageData(bitmap));
				} finally {
					try {
						bitmap.recycle();
					} catch (e) {
						// 忽略回收异常
					}
				}
			} catch (e) {
				return '';
			}
		};

		/**
		 * 等 buff 卡面动画结束。
		 *
		 * 旧实现轮询“连续 N 次 hash 完全相同”，但卡面有持续闪光/粒子，实机日志里
		 * 几乎每次都会跑满 4500ms 超时；刷新超时后 settled=false 还会再补一次
		 * enter 等待，单次刷新约 9s。现在改成按实测动画时长固定等待：
		 * - enter 约 0.9s，覆盖入场淡入（视频实测卡面约 0.5~0.8s 已可读）；
		 * - refresh 约 2.7s，覆盖旧卡变暗 + 新卡落位（实测 2.2~2.6s）。
		 * duringWait 用于把钱包 OCR 并行到卡面动画里；等待总时长仍按 settleMs
		 * 计算（OCR 花掉的时间从 sleep 里扣掉），不会读到旧卡。
		 * 等待后只读一次 hash 用于日志/前后对比，不再用 hash 阻塞。
		 */
		const waitBuffCardsStable = (reason: string, minMs: number, prevHash = '', duringWait?: () => void): boolean => {
			const t0 = now();
			const settleMs = reason === 'refresh'
				? Math.max(minMs, D6_BUFF_REFRESH_SETTLE_MS)
				: Math.max(minMs, D6_BUFF_ENTER_SETTLE_MS);
			if (duringWait) {
				try {
					duringWait();
				} catch (e) {
					// 并行任务失败不影响卡面等待
				}
			}
			const remain = settleMs - (now() - t0);
			if (remain > 0) sleep(remain);
			// 更新缓存帧后再读一次卡面 hash；只用于日志，不参与“是否继续等待”的判断。
			thisScript.keepScreen();
			const hash = readBuffCardsHash();
			const changed = !!(prevHash && hash && hash !== prevHash);
			const waited = now() - t0;
			perfLog('buff.wait', waited, `reason=${reason} changed=${changed ? 1 : 0} timeout=0 refresh=${d6BuffRefreshCount}`, true);
			d6jueAnalysisLog('buff.wait', {
				reason,
				waited,
				changed: changed ? 1 : 0,
				timeout: 0,
				hash,
				refresh: d6BuffRefreshCount,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
			});
			console.log(`[d6jue-buff] 卡面等待(${reason}) ${waited}ms changed=${changed ? 'T' : 'F'} timeout=F hash=${hash || '?'}`);
			return true;
		};
		// 舞技强化/buff 界面右下角刷新：OCR 可用时等下一次读数校验费用
		const refreshBuffSelection = () => {
			const before = g.d6jueWanxiangling || 0;
			// 点击前记录卡面：刷新后必须看到卡面变化，不能只等“稳定”
			const prevHash = readBuffCardsHash();
			d6BuffRefreshCount++;
			d6BuffLastRefreshTime = now();
			// 费用挂起和日志都放在点击前：日志时间≈真实点击时间，便于和视频对齐
			beginPendingRefreshCost(D6_BUFF_REFRESH_COST, 'buff_refresh', before);
			console.log(`[d6jue-lei] 刷新buff -${D6_BUFF_REFRESH_COST}，当前计算余额=${g.d6jueWanxiangling}（等OCR校验）`);
			d6jueAnalysisLog('buff.refresh', {
				cost: D6_BUFF_REFRESH_COST,
				walletBefore: before,
				wallet: g.d6jueWanxiangling || 0,
				costPending: thisConf.walletOcr !== false ? 1 : 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				step: g.d6jueStepLeft || 0,
				refresh: d6BuffRefreshCount,
				prevHash,
			});
			thisScript.regionClick([[1180, 625, 1235, 675, 0]]);
			// 固定 1500ms 改成卡面稳定等待：旧卡会继续显示 1~2s，
			// 提前判定会读到上一组，并导致多刷一次/最后一次的卡从未被检查。
			// 点击后钱包已立刻扣费，OCR 放在卡面动画期间并行跑；调用方紧接着的
			// readWanxianglingOcr('buff') 用 skipUntil 跳过，避免重复读。
			waitBuffCardsStable('refresh', D6_BUFF_REFRESH_MIN_MS, prevHash, () => {
				// 点击后游戏钱包约 0.3s 才刷新；先等一小段再 OCR，避免读到扣费前的值。
				// 这段等待和 OCR 都发生在 2.7s 卡面动画内，不额外增加总时长。
				sleep(350);
				readWanxianglingOcr('buff');
				d6BuffWalletOcrSkipUntil = now() + 3000;
			});
			// 固定等待已覆盖新卡落位：保持 settled=true，下一轮不再重复 enter 等待。
			d6BuffScreenSettled = true;
			d6BuffScreenLastSeen = now();
		};

		// buff 黑名单：默认永不选择；所有名称都需在 multiFindColors.ts 配置 六道觉_buff_<名称>
		// 妖力化身/攻击加成无论旧配置是否写了，都强制加入黑名单
		const buffBlacklist = Array.from(new Set([
			...String(thisConf.buffBlacklist || DEFAULT_BUFF_BLACKLIST)
				.split(/[,，]/)
				.map(item => item.trim())
				.filter(item => item.length > 0),
			CAUTION_BUFF_YAO,
			CAUTION_BUFF_ATTACK,
			CAUTION_BUFF_BEISHUI,
		]));
		const knownBuffNames = Array.from(new Set([...buffBlacklist, ...KNOWN_BUFF_NAMES]));

		// 只提示一次缺失的图标配置
		if (!buffPatternWarned) {
			const missing = knownBuffNames.filter(name => {
				if (name.includes('轰雷')) return false;
				const conf = thisScript.multiFindColors[buffColorKey(name)];
				return !conf || !conf.desc || conf.desc.length === 0;
			});
			if (missing.length > 0) {
				console.log(`[d6jue-buff] 缺少图标取色: ${missing.join('、')}；未识别的卡仍可能被选中`);
			}
			buffPatternWarned = true;
		}

		const buffButtons = [
			[150, 555, 330, 590],
			[420, 555, 600, 590],
			[690, 555, 870, 590],
		];
		const cardIndexByX = (x: number): number => x < 350 ? 0 : x < 620 ? 1 : 2;

		const isBuffSelectable = (name: string): boolean => {
			if (buffBlacklist.includes(name)) return false;
			if (name === CAUTION_BUFF_YAO && (g.d6jueYaoLevel || 0) >= 1) return false;
			if (name === CAUTION_BUFF_BEISHUI && (g.d6jueBeishuiLevel || 0) >= 1) return false;
			if (name === CAUTION_BUFF_CHIFEN && (g.d6jueLeiLevel || 0) < 1) return false;
			if (name === '六道轰雷' && (g.d6jueLeiLevel || 0) >= 3) return false;
			return true;
		};

		// 识别三张卡片的图标；未识别的记为 null（按“黑名单外默认可选”处理）
		const scanBuffCards = (): { name: string | null; index: number }[] => {
			const t0 = now();
			let scans = 1;
			const cards = [
				{ name: null as string | null, index: 0 },
				{ name: null as string | null, index: 1 },
				{ name: null as string | null, index: 2 },
			];
			const lei = thisScript.findMultiColor('六道觉_六道轰雷');
			if (lei) {
				cards[cardIndexByX(lei.x)].name = '六道轰雷';
			}
			for (let i = 0; i < knownBuffNames.length; i++) {
				const name = knownBuffNames[i];
				if (name.includes('轰雷')) continue;
				const key = buffColorKey(name);
				const conf = thisScript.multiFindColors[key];
				if (!conf || !conf.desc || conf.desc.length === 0) continue;
				scans++;
				const point = thisScript.findMultiColor(key);
				if (point) {
					const index = cardIndexByX(point.x);
					if (!cards[index].name) cards[index].name = name;
				}
			}
			const dt = now() - t0;
			if (perfLogEnabled || dt >= 100) {
				perfLog('buff.scan', dt, `findMultiColor=${scans} cards=${cards.map(c => c.name || '?').join(',')}`, true);
			}
			d6jueAnalysisLog('buff.scan', {
				cards: cards.map(c => c.name || '?').join('/'),
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				pending: g.d6jueWanxianglingPending || 0,
				step: g.d6jueStepLeft || 0,
				refresh: d6BuffRefreshCount,
				sinceRefresh: d6BuffLastRefreshTime ? now() - d6BuffLastRefreshTime : -1,
			});
			return cards;
		};

		const clickBuffCard = (index: number, name: string | null): boolean => {
			if (buffSelectLocked()) return true;
			if (name && !isBuffSelectable(name)) {
				console.log(`[d6jue-buff] 拒绝选择不可用buff: ${name}`);
				return false;
			}
			const button = buffButtons[index];
			if (!button) return false;
			// TODO(六道觉): 未知卡截图仅用于补取色，黑名单识别稳定后移除
			if (!name && thisConf.walletOcr !== false) {
				try {
					const dir = context.getExternalFilesDir(null);
					if (dir) {
						const img = images.captureScreen();
						if (img) {
							const shot = `${dir.getAbsolutePath()}/d6jue_buff_${g.d6jueTimes || 0}_${g.d6jueStepLeft || 0}_${now()}.png`;
							images.save(img, shot);
							img.recycle();
							console.log(`[d6jue-buff] 未知卡截图: ${shot}`);
							d6jueAnalysisLog('buff.screenshot', {
								path: shot,
								step: g.d6jueStepLeft || 0,
								pos: index + 1,
								lei: g.d6jueLeiLevel || 0,
								power: g.d6juePowerLevel || 0,
							});
						}
					}
				} catch (e) {
					// 截图失败不影响选卡
				}
			}
			thisScript.regionClick([[button[0], button[1], button[2], button[3], 500]]);
			lockBuffSelect();
			// 选卡后界面会关闭或换下一组卡（混沌精英第二轮），下次命中按新界面重新等入场
			resetBuffScreenState();
			// 每个选buff界面 +100；同一屏的重复点击由选择锁挡住
			addWanxiangling(D6_ISLAND_BUFF_GAIN, `选buff:${name || '未知'}`);
			if (name === '六道轰雷') {
				g.d6jueLeiLevel = (g.d6jueLeiLevel || 0) + 1;
			} else {
				if (name === CAUTION_BUFF_YAO) g.d6jueYaoLevel = (g.d6jueYaoLevel || 0) + 1;
				else if (name === CAUTION_BUFF_BEISHUI) g.d6jueBeishuiLevel = (g.d6jueBeishuiLevel || 0) + 1;
				else if (name === CAUTION_BUFF_CHIFEN) g.d6jueChifenLevel = (g.d6jueChifenLevel || 0) + 1;
				g.d6jueOtherBuffSelected = true;
			}
			console.log(`[d6jue-buff] 选择buff: ${name || '未知'}，位置=${index + 1}`);
			d6jueAnalysisLog('buff.pick', {
				name: name || 'unknown',
				pos: index + 1,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				pending: g.d6jueWanxianglingPending || 0,
				island: d6IslandKey,
				step: g.d6jueStepLeft || 0,
			});
			return true;
		};

		const selectLei = (): boolean => {
			if ((g.d6jueLeiLevel || 0) >= 3) return false;
			const lei = thisScript.findMultiColor('六道觉_六道轰雷');
			d6jueAnalysisLog('buff.lei_check', {
				found: !!lei,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
				refresh: d6BuffRefreshCount,
				sinceRefresh: d6BuffLastRefreshTime ? now() - d6BuffLastRefreshTime : -1,
			});
			if (!lei) return false;
			return clickBuffCard(cardIndexByX(lei.x), '六道轰雷');
		};

		// 死局强制选择：跳过黑名单/等级限制，直接点一张，并把本局标记为无法通关
		const forceClickBuffCard = (index: number, name: string | null): boolean => {
			if (buffSelectLocked()) return true;
			const button = buffButtons[index];
			if (!button) return false;
			thisScript.regionClick([[button[0], button[1], button[2], button[3], 500]]);
			lockBuffSelect();
			resetBuffScreenState();
			addWanxiangling(D6_ISLAND_BUFF_GAIN, `死局选buff:${name || '未知'}`);
			g.d6jueCantClear = true;
			g.d6jueOtherBuffSelected = true;
			console.log(`[d6jue-buff] 死局强制选择 ${name || '未知'}（位置=${index + 1}），标记无法通关=T`);
			d6jueAnalysisLog('buff.force', {
				name: name || 'unknown',
				pos: index + 1,
				step: g.d6jueStepLeft || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				island: d6IslandKey,
			});
			return true;
		};

		// 选择一张可用的已知buff；优先已知可用，未知卡作为兜底
		const selectAllowedBuff = (): boolean => {
			const cards = scanBuffCards();
			for (let i = 0; i < cards.length; i++) {
				const name = cards[i].name;
				if (name && isBuffSelectable(name)) {
					return clickBuffCard(i, name);
				}
			}
			for (let i = 0; i < cards.length; i++) {
				if (!cards[i].name) {
					return clickBuffCard(i, null);
				}
			}
			return false;
		};

		// 兜底随机：只从已知可用或未知卡片中选，排除黑名单/受限/满级轰雷
		const selectRandomAllowedBuff = (): boolean => {
			const cards = scanBuffCards();
			const candidates = cards.filter(card => {
				if (!card.name) return true;
				return isBuffSelectable(card.name);
			});
			if (candidates.length === 0) return false;
			const pick = candidates[Math.floor(Math.random() * candidates.length)];
			return clickBuffCard(pick.index, pick.name);
		};

		const coreBuff = String(thisConf.coreBuff || '').trim();
		const coreBuffMax = Math.max(0, parseInt(String(thisConf.coreBuffMax || '0'), 10) || 0);
		if (!g.d6jueCoreBuff) g.d6jueCoreBuff = 0;

		// 右上角小地图结构识别 + 自动选择点击
		const readMapState = () => {
			const t0 = now();
			// 稳定地图行的短 TTL 复用：地图行没有点击/事件不会自己变，
			// 避免 handleMapNodes 每次轮询都对同一帧重跑 NCC（实机单次约 700~900ms）。
			if (mapStateCache && mapStateCache.state && mapStateCacheTime
				&& t0 - mapStateCacheTime <= D6_MAP_STATE_CACHE_TTL_MS
			) {
				lastMapHash = mapStateCache.hash;
				perfLog('map.ttl_cache', 0, `age=${t0 - mapStateCacheTime} nodes=${mapStateCache.state.nodes.length}`, true);
				return mapStateCache.state;
			}
			const readIndex = mapReadCount++;
			lastMapHash = '';
			try {
				const helper = thisScript.helperBridge.helper;
				const region = D6_MINIMAP_DEV_REGION;
				const sr = helper.GetPoint(region.x0, region.y0, right);
				const er = helper.GetPoint(region.x1, region.y1, right);
				if (sr.x >= er.x || sr.y >= er.y) {
					if (readIndex === 0) console.log('[d6jue-map] first read: invalid region');
					return null;
				}
				const bitmap = helper.GetBitmap(sr.x, sr.y, er.x, er.y);
				if (!bitmap) {
					if (readIndex === 0) console.log('[d6jue-map] first read: null bitmap');
					return null;
				}
				const t1 = now();
				try {
					const image = bitmapToImageData(bitmap);
					const t2 = now();
					const hash = d6MapImageHash(image);
					if (mapStateCache && mapStateCache.hash === hash) {
						const t3 = now();
						lastMapHash = hash;
						perfLog('map.cache', t3 - t0, `first=${readIndex === 0 ? 1 : 0} bitmap=${t1 - t0} pixels=${t2 - t1} hash=${t3 - t2} nodes=${mapStateCache.state ? mapStateCache.state.nodes.length : 0}`, true);
						return mapStateCache.state;
					}
					const state = analyzeD6Map(image);
					if (state) {
						const shenmi = state.reachable.filter(n => n.type === '神秘');
						const zhanfang = state.reachable.filter(n => n.type === '绽放');
						if (shenmi.length > 0 && zhanfang.length > 0) {
							// 按实际游戏规则，神秘和绽放不会同屏；出现即识别冲突。
							// 只记录/截图，不在这轮点击；后续用截图修模板。
							const detail = state.reachable
								.map(n => `${d6MapColName(n.col)}${n.type}@${n.x},${n.y}:${n.score.toFixed(2)}`)
								.join('|');
							d6jueAnalysisLog('map.type_conflict', {
								nodes: detail,
								pin: state.pin ? `${state.pin.x},${state.pin.y}` : '',
							});
							try {
								const shot = images.captureScreen();
								const dir = context.getExternalFilesDir(null);
								if (dir) {
									const shotPath = `${dir.getAbsolutePath()}/d6jue_conflict_${now()}.png`;
									images.save(shot, shotPath);
									d6jueAnalysisLog('map.type_conflict_shot', { path: shotPath });
								}
							} catch (e) {
								// 截图失败不影响主流程
							}
						}
					}
					mapStateCache = { hash, state };
					mapStateCacheTime = now();
					lastMapHash = hash;
					const t3 = now();
					perfLog('map.read', t3 - t0, `first=${readIndex === 0 ? 1 : 0} bitmap=${t1 - t0} pixels=${t2 - t1} analyze=${t3 - t2} nodes=${state ? state.nodes.length : 0}`, true);
					return state;
				} finally {
					try {
						bitmap.recycle();
					} catch (e) {
						// 忽略回收异常
					}
				}
			} catch (e) {
				console.log(`[d6jue-map] 小地图识别异常: ${e}`);
				return null;
			}
		};

		// 右上角「X回合后迎战迦摩天」：数字模板识别。
		// X 是“当前回合之后还剩多少回合”，所以剩余步数 = X + 1。
		// 换行/奖励弹窗期间会短暂读不到：同一行允许 300~500ms 后重读；
		// pending 期间持续重读，用于确认计数器是否已经下降。
		const readStepCounter = (rowKey: string, pending: boolean): { result: D6StepCounterResult | null; exhausted: boolean } => {
			const t = now();
			if (!stepCounterRead || stepCounterRead.rowKey !== rowKey) {
				stepCounterRead = {
					rowKey,
					result: null,
					attempts: 0,
					firstTime: t,
					lastTime: 0,
					exhausted: false,
					missLogged: false,
					rejectLogged: false,
					waitLogged: false,
					matchLogged: false,
				};
			}
			const state = stepCounterRead;
			if (!pending && state.result) return { result: state.result, exhausted: true };

			const maxAttempts = pending ? 8 : 3;
			const maxWait = pending ? 3500 : 3000;
			const interval = pending ? 500 : 700;
			const withinBudget = state.attempts < maxAttempts
				&& (state.attempts === 0 || t - state.firstTime <= maxWait);
			if (!withinBudget) {
				state.exhausted = true;
				if (!state.missLogged) {
					state.missLogged = true;
					d6jueAnalysisLog('map.counter_miss', {
						prev: g.d6jueStepLeft || 0,
						row: state.rowKey,
						attempts: state.attempts,
					});
				}
				return { result: state.result, exhausted: true };
			}
			if (state.attempts > 0 && t - state.lastTime < interval) {
				return { result: state.result, exhausted: !!state.result };
			}

			state.attempts++;
			state.lastTime = t;
			const t0 = now();
			let result: D6StepCounterResult | null = null;
			try {
				const helper = thisScript.helperBridge.helper;
				const sr = helper.GetPoint(1064, 234, right);
				const er = helper.GetPoint(1104, 264, right);
				if (sr.x < er.x && sr.y < er.y) {
					const bitmap = helper.GetBitmap(sr.x, sr.y, er.x, er.y);
					if (bitmap) {
						try {
							const image = bitmapToImageData(bitmap);
							result = recognizeD6StepCounter(image);
						} finally {
							try {
								bitmap.recycle();
							} catch (e) {
								// 忽略回收异常
							}
						}
					}
				}
			} catch (e) {
				result = null;
			}
			perfLog('map.counter_read', now() - t0, `ok=${result ? 1 : 0} row=${rowKey} try=${state.attempts}${result ? ` x=${result.value} digits=${result.digits} conf=${result.confidence.toFixed(2)}` : ''}`, true);
			if (result) {
				state.result = result;
				state.exhausted = true;
				return { result, exhausted: true };
			}
			state.result = null;
			if (state.attempts >= maxAttempts || now() - state.firstTime >= maxWait) {
				state.exhausted = true;
				if (!state.missLogged) {
					state.missLogged = true;
					d6jueAnalysisLog('map.counter_miss', {
						prev: g.d6jueStepLeft || 0,
						row: state.rowKey,
						attempts: state.attempts,
					});
				}
			}
			return { result: null, exhausted: state.exhausted };
		};

		// 回合数字读数只做校验/恢复：成功/校准/拒绝/等待分别记录，便于离线分析。
		const logStepCounterRead = (update: D6StepCounterUpdate, result: D6StepCounterResult): void => {
			const pending = update.reason.indexOf('pending') !== -1 || update.reason === 'counter_drop';
			if (update.accepted) {
				if (update.leftAfter === update.leftBefore && stepCounterRead && stepCounterRead.matchLogged) {
					return;
				}
				if (stepCounterRead) stepCounterRead.matchLogged = true;
				d6jueAnalysisLog('map.counter', {
					value: result.value,
					stepLeft: update.leftAfter,
					prev: update.leftBefore,
					digits: result.digits,
					conf: Number(result.confidence.toFixed(2)),
					mode: pending ? 'pending' : 'map',
					delta: update.leftAfter - update.leftBefore,
					reason: update.reason,
				});
				if (update.leftAfter !== update.leftBefore) {
					d6jueAnalysisLog('step.calibrate', {
						from: update.leftBefore,
						to: update.leftAfter,
						delta: update.leftAfter - update.leftBefore,
						counter: result.value,
						digits: result.digits,
						conf: Number(result.confidence.toFixed(2)),
						reason: update.reason,
						alerts: update.alerts.join(','),
						seq: update.islandSeq,
					});
					console.log(`[d6jue-map] 计数器校准（${update.reason}）：剩余${update.leftBefore} -> ${update.leftAfter}`);
				}
				return;
			}
			if (update.reason === 'bloom_conflict') {
				d6jueAnalysisLog('step.alert', {
					kind: 'bloom_conflict',
					counter: result.value,
					step: update.stepNo,
					left: update.leftBefore,
					digits: result.digits,
				});
				return;
			}
			if (
				update.reason === 'higher'
				|| update.reason === 'higher_pending'
				|| update.reason === 'low_confidence'
				|| update.reason === 'invalid'
			) {
				if (stepCounterRead && !stepCounterRead.rejectLogged) {
					stepCounterRead.rejectLogged = true;
					d6jueAnalysisLog('map.counter_reject', {
						value: result.value,
						next: result.value + 1,
						prev: update.leftBefore,
						conf: Number(result.confidence.toFixed(2)),
						digits: result.digits,
						reason: update.reason,
					});
				}
				return;
			}
			if (update.reason === 'lower_wait' || update.reason === 'resume_wait' || update.reason === 'restart_wait') {
				// 下一次必须真实重读，而不是把同一次缓存读数当成“第二次确认”。
				if (stepCounterRead) {
					stepCounterRead.result = null;
					stepCounterRead.exhausted = false;
				}
				if (stepCounterRead && !stepCounterRead.waitLogged) {
					stepCounterRead.waitLogged = true;
					d6jueAnalysisLog('map.counter_wait', {
						value: result.value,
						next: result.value + 1,
						prev: update.leftBefore,
						conf: Number(result.confidence.toFixed(2)),
						digits: result.digits,
						reason: update.reason,
					});
				}
			}
			if (update.reason === 'counter_drop_wait' && !update.committed && stepCounterRead) {
				// 单次下降还不算数，强制下一次真实重读。
				stepCounterRead.result = null;
				stepCounterRead.exhausted = false;
			}
		};

		// 唤息统一入口：点按钮，费用等地图刷新确认后再扣
		const clickHuanxi = (reason: string, time: number, mapSig: string): boolean => {
			if (d6HuanxiPending) {
				if (now() - d6HuanxiPendingTime <= 3000) {
					console.log('[d6jue-map] 上一次唤息还在确认中');
					return false;
				}
				d6HuanxiPending = false;
			}
			if (time - (g.d6jueMapClickTime || 0) < 3000) {
				console.log('[d6jue-map] 唤息点击冷却中');
				return false;
			}
			thisScript.regionClick([[1125, 585, 1210, 645, 500]]);
			g.d6jueMapClickTime = time;
			const before = g.d6jueWanxiangling || 0;
			d6HuanxiPending = true;
			d6HuanxiPendingTime = now();
			d6HuanxiPendingSig = mapSig;
			console.log(`[d6jue-map] ${reason}，唤息-${D6_HUANXI_COST}（等待地图刷新确认，当前=${before}）`);
			d6jueAnalysisLog('map.huanxi', {
				reason,
				step: g.d6jueStepLeft || 0,
				walletBefore: before,
				walletAfter: before,
				cost: D6_HUANXI_COST,
				deducted: 0,
				pending: 1,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
			if (before < D6_HUANXI_COST) {
				console.log(`[d6jue-map] OCR余额不足${D6_HUANXI_COST}，请检查最近一次OCR`);
			}
			return true;
		};

		const handleMapNodes = (doClick: boolean, huanxiBright = false): boolean => {
			const time = now();
			if (time - (g.d6jueMapLogTime || 0) < 700) return false;
			g.d6jueMapLogTime = time;
			// 唤息确认超时兜底：地图一直没刷新就不扣 300，避免卡住后续唤息
			if (d6HuanxiPending && now() - d6HuanxiPendingTime > 3000) {
				d6HuanxiPending = false;
				console.log('[d6jue-map] 唤息点击后地图未变化，不扣300');
				d6jueAnalysisLog('map.huanxi_unverified', {
					cost: D6_HUANXI_COST,
					reason: 'no_state_change',
					step: g.d6jueStepLeft || 0,
				});
			}

			const state = readMapState();
			if (!state) {
				const invalid = getStepTracker().observeMap({
					time,
					rowKey: '',
					valid: false,
					mapHash: lastMapHash,
				});
				syncStepState();
				if (invalid.pending && thisConf.logMapNodes) console.log('[d6jue-map] 小地图不可用，等待步数确认');
				if (thisConf.logMapNodes) console.log('[d6jue-map] 未识别到小地图节点，跳过');
				return false;
			}
			// 唤息专用签名：带上亮/暗，用于确认唤息后节点行确实刷新了
			const huanxiSig = state.nodes.map(n => `${n.type}${n.x}${n.bright ? 1 : 0}`).join('/')
				+ `|${state.nextRowY}|${state.pin ? `${state.pin.x},${state.pin.y}` : ''}`;
			// 唤息费用确认：节点行变化说明已进入唤息后的新地图，扣 300 一次
			if (d6HuanxiPending && huanxiSig !== d6HuanxiPendingSig) {
				d6HuanxiPending = false;
				const before = g.d6jueWanxiangling || 0;
				g.d6jueWanxiangling = Math.max(0, before - D6_HUANXI_COST);
				console.log(`[d6jue-map] 唤息已刷新地图，扣${D6_HUANXI_COST}，当前计算余额=${g.d6jueWanxiangling}`);
				d6jueAnalysisLog('map.huanxi_confirm', {
					cost: D6_HUANXI_COST,
					walletBefore: before,
					walletAfter: g.d6jueWanxiangling || 0,
					step: g.d6jueStepLeft || 0,
				});
			}

			// unknown 说明岛屿图标没有匹配到任何模板：无法判断目标，本回合不点击主地图，
			// 记录一次节点信息后继续运行，等小地图刷新或人工处理。
			const afterRead = now();
			const unknownNodes = state.nodes.filter(n => n.type === 'unknown');
			const typeConflict = state.reachable.some(n => n.type === '神秘')
				&& state.reachable.some(n => n.type === '绽放');
			const rowValid = !typeConflict
				&& unknownNodes.length === 0
				&& state.reachable.length >= 1
				&& state.reachable.length <= 4;
			const rowKey = d6StepRowKey(state);
			const bloom = state.reachable.some(n => n.type === '绽放');
			// boss 已把 left 置 0 后又出现完整地图：要么 boss 失败回到地图，要么新一局
			// 没有经过“开启”按钮。重新按未初始化状态接管，由计数器决定真实剩余步数。
			if (rowValid && getStepTracker().left <= 0 && getStepTracker().phase === 'map') {
				getStepTracker().reset(D6_TOTAL_STEPS, false, afterRead);
				syncStepState();
				d6jueAnalysisLog('step.init', { left: D6_TOTAL_STEPS, mode: 'map_after_zero' });
			}
			const mapUpdate = getStepTracker().observeMap({
				time: afterRead,
				rowKey: rowValid ? rowKey : '',
				valid: rowValid,
				mapHash: lastMapHash,
				bloom,
			});
			syncStepState();
			if (mapUpdate.alerts.length > 0) {
				d6jueAnalysisLog('step.alert', {
					kind: mapUpdate.alerts.join(','),
					step: mapUpdate.stepNo,
					left: mapUpdate.left,
					nodes: state.reachable.map(n => n.type).join('/'),
				});
				if (thisConf.logMapNodes) console.log(`[d6jue-map] 步数告警: ${mapUpdate.alerts.join(',')}`);
			}
			if (mapUpdate.confirmed) {
				// 新行确认后强制重新读一次计数器，避免把 pending 期间读到的旧值缓存到新行。
				stepCounterRead = null;
				d6jueAnalysisLog('map.step_confirm', {
					left: mapUpdate.left,
					leftBefore: mapUpdate.leftBefore,
					step: mapUpdate.stepNo,
					seq: mapUpdate.islandSeq,
					reason: mapUpdate.reason,
					evidence: mapUpdate.evidence || mapUpdate.reason,
					elapsed: mapUpdate.elapsed,
					nodes: state.reachable.map(n => n.type).join('/'),
				});
				console.log(`[d6jue-map] 步数确认 +1（${mapUpdate.reason}），剩余${mapUpdate.left}步`);
			}
			const retriedClick = mapUpdate.retry;
			if (mapUpdate.retry) {
				d6jueAnalysisLog('map.step_retry', {
					left: mapUpdate.left,
					step: mapUpdate.stepNo,
					seq: mapUpdate.islandSeq,
					nodes: state.reachable.map(n => n.type).join('/'),
					gap: mapUpdate.elapsed,
				});
				console.log('[d6jue-map] 点击未确认推进，重试同一行');
				stepCounterRead = null;
			}

			if (unknownNodes.length > 0) {
				if (!unknownMapNotified) {
					const nodeText = state.nodes.map(n => `${d6MapColName(n.col)}${n.type}(ncc${n.score.toFixed(2)}${n.shapeScore ? `/形${n.shapeScore.toFixed(2)}` : ''},亮${n.meanLum.toFixed(0)},金${n.gold})`).join(' | ');
					const pinText = state.pin ? `${state.pin.x},${state.pin.y}` : '未识别';
					const detail = `定位针=${pinText} 节点: ${nodeText}`;
					console.log(`[d6jue-map] 出现未知岛屿，暂停点击主地图；${detail}`);
					d6jueUnknownLog(`unknown-skip ${detail}`);
					d6jueAnalysisLog('map.unknown', {
						step: g.d6jueStepLeft || 0,
						nodes: state.nodes.map(n => `${d6MapColName(n.col)}${n.type}:${n.score.toFixed(2)}:${n.meanLum.toFixed(0)}:${n.gold}`).join('|'),
						pin: pinText,
						lei: g.d6jueLeiLevel || 0,
						power: g.d6juePowerLevel || 0,
					});
					thisScript.myToast('六道觉：小地图出现未知岛屿，暂不点击主地图（记录见 d6jue_unknown.log）', 3000);
					unknownMapNotified = true;
				}
				return false;
			}
			if (typeConflict) {
				if (thisConf.logMapNodes) console.log('[d6jue-map] 神秘/绽放同屏冲突，等待下一帧');
				return false;
			}
			unknownMapNotified = false;

			// 待确认期间：稳定地图上重读计数器，读数下降即可确认推进。
			if (getStepTracker().pending && rowValid && mapUpdate.settled) {
				const pendingRead = readStepCounter(rowKey, true);
				if (pendingRead.result) {
					const counterUpdate = getStepTracker().noteCounter(
						now(),
						pendingRead.result.value + 1,
						pendingRead.result.confidence,
						true,
					);
					syncStepState();
					logStepCounterRead(counterUpdate, pendingRead.result);
				}
			}
			if (getStepTracker().pending) {
				if (mapUpdate.committed && rowValid && mapUpdate.waitMs > 0) {
					// 已确认离图、正在等归图稳定：精确 sleep，避免 700ms 轮询把每步拖慢。
					const wait = Math.min(mapUpdate.waitMs, mapSettleMs);
					if (thisConf.logMapNodes) console.log(`[d6jue-map] 归图稳定等待 ${wait}ms`);
					sleep(wait);
					g.d6jueMapLogTime = 0;
				}
				if (thisConf.logMapNodes) {
					console.log(`[d6jue-map] 等待步数确认（${mapUpdate.reason}${mapUpdate.committed ? ',已离图' : ''}，${mapUpdate.elapsed}ms）`);
				}
				return false;
			}
			if (!mapUpdate.settled) {
				if (rowValid && mapUpdate.waitMs > 0) {
					const wait = Math.min(mapUpdate.waitMs, mapSettleMs);
					if (thisConf.logMapNodes) console.log(`[d6jue-map] 地图稳定等待 ${wait}ms`);
					sleep(wait);
					g.d6jueMapLogTime = 0;
				}
				if (thisConf.logMapNodes) console.log('[d6jue-map] 等待地图稳定');
				return false;
			}

			// 正常地图行：读计数器做校验/中途接手初始化；不阻塞步数推进。
			{
				const counterRead = readStepCounter(rowKey, false);
				if (counterRead.result) {
					const counterUpdate = getStepTracker().noteCounter(
						now(),
						counterRead.result.value + 1,
						counterRead.result.confidence,
						true,
					);
					syncStepState();
					logStepCounterRead(counterUpdate, counterRead.result);
				}
				if (getStepTracker().counterPending) {
					if (!counterRead.result && counterRead.exhausted) {
						// 重读预算用完仍没有第二个一致读数：放弃校准，回到地图推进为准。
						getStepTracker().cancelCounterCandidate();
						d6jueAnalysisLog('step.alert', {
							kind: 'counter_wait_exhausted',
							step: getStepTracker().stepNo,
							left: getStepTracker().left,
						});
					} else {
						// 偏低读数需要第二次确认；先不点击，避免用旧 stepLeft 给下一座岛分配 key。
						if (thisConf.logMapNodes) console.log('[d6jue-map] 计数器偏低待确认，暂缓点击');
						return false;
					}
				}
				if (!counterRead.result && !getStepTracker().initialized && !counterRead.exhausted) {
					// 中途接手：还不知道真实剩余步数，等计数器连续两次一致再点。
					if (thisConf.logMapNodes) console.log('[d6jue-map] 等待计数器初始化步数');
					return false;
				}
			}

			const powerLevel = g.d6juePowerLevel || 0;
			const leiLevel = g.d6jueLeiLevel || 0;
			// 万相铃按每岛固定收益计算，商店/选buff 的 OCR 在检查点校验并校准。
			// 这里的 wallet 用于实时唤息/找商店判断；同一座岛的重复命中不会重复加。
			const wallet = g.d6jueWanxiangling || 0;
			const powerReady = powerLevel > 2;
			const needLei = leiLevel === 0;
			const clearMet = powerReady && leiLevel > 0;
			// 只剩轰雷时，计算余额 >=300（买 200 + 至少刷 1 次 100）就把宁息提到最高，
			// 避免同行神秘把商店抢走；到店后按 OCR 精确值决定是否继续刷新/购买。
			const priority = needLei && powerReady && wallet >= D6_SHOP_LEI_PRICE + D6_SHOP_REFRESH_COST
				? MAP_PRIORITY_SHOP_HUNT
				: (clearMet ? MAP_PRIORITY_CLEARED : MAP_PRIORITY);
			const choice = pickD6MapChoice(state, priority);

			if (thisConf.logMapNodes) {
				const nodeText = state.nodes.length > 0
					? state.nodes.map(n => `${d6MapColName(n.col)}${n.type}${n.bright ? '亮' : '暗'}(ncc${n.score.toFixed(2)}${n.shapeScore ? `/形${n.shapeScore.toFixed(2)}` : ''},亮${n.meanLum.toFixed(0)},金${n.gold})`).join(' | ')
					: '未识别到';
				const reachText = state.reachable.map(n => `${n.type}@${n.x}`).join(' > ') || '无';
				const pinText = state.pin ? `${state.pin.x},${state.pin.y}` : '未识别';
				console.log(`[d6jue-map] 定位针=${pinText} 可选行y=${state.nextRowY} 节点: ${nodeText}`);
				console.log(`[d6jue-map] 可选(亮色): ${reachText}${choice ? `，目标=${choice.target.type}@${choice.target.x},${choice.target.y}，选择位=${choice.slot}(${choice.index + 1}/${choice.count})` : ''}`);
			}

			if (state.nodes.length === 0) {
				if (thisConf.logMapNodes) console.log('[d6jue-map] 未识别到小地图节点，等待下一轮');
				return false;
			}

			// 唤息规则：
			// 1. 轰雷已满足后，下一层仅 1 个可达节点且为混沌：能唤息就唤息；
			// 2. 只剩轰雷且临近迎战、当前行没有宁息：主动唤息找宁息商店（每局最多 1 次）。
			const singleChaos = state.reachable.length === 1 && state.reachable[0].type === '混沌';
			if (singleChaos && huanxiBright && leiLevel > 0 && wallet >= D6_HUANXI_COST) {
				return clickHuanxi('轰雷已满足，下一层仅混沌单节点', time, huanxiSig);
			}

			const stepLeft = g.d6jueStepLeft || 0;
			const hasNingxi = state.reachable.some(n => n.type === '宁息');
			// 剩余 <=3 步时只求买到（W>=500）；4~5 步时要求唤息后还能三刷（300+200+100×3=800）
			const huanxiShopWallet = stepLeft <= 3 ? 500 : 800;
			if (
				needLei && powerReady && !g.d6jueCantClear && huanxiBright && !hasNingxi
				&& state.reachable.length < 4
				&& stepLeft > 0 && stepLeft <= 5
				&& (g.d6jueWanxiangling || 0) >= D6_HUANXI_COST
				&& wallet >= huanxiShopWallet
				&& (g.d6jueHuanxiShop || 0) < 1
			) {
				if (clickHuanxi(`仅剩轰雷且无宁息(剩余${stepLeft}步)，主动唤息找商店`, time, huanxiSig)) {
					g.d6jueHuanxiShop = (g.d6jueHuanxiShop || 0) + 1;
					return true;
				}
				return false;
			}

			if (!choice) {
				if (thisConf.logMapNodes) console.log('[d6jue-map] 没有可达节点，跳过');
				return false;
			}

			if (doClick && getStepTracker().phase === 'map' && now() - (g.d6jueLastMapSigTime || 0) >= mapRetryMs) {
				const slotIndex = d6MapSlotIndex(choice.slot);
				const slotOper = slotIndex >= 0 && thisOperator[53] && thisOperator[53].oper
					? thisOperator[53].oper[slotIndex]
					: null;
				if (!slotOper) {
					console.log(`[d6jue-map] 未找到主地图选择位: ${choice.slot}`);
					return false;
				}

				// 主场景横幅锚点：小地图只负责类型/顺序。
				// 首点直接使用固定选择位——实测固定位首点成功率 97.4%，
				// 而横幅锚点只有 81.8%，且每次检测要 3s+；只在固定位点击
				// 未生效后的重试里才做横幅定位（找不到仍回退固定位）。
				// 绽放固定位首点成功率 100%，不参与横幅重试。
				let anchor: D6BannerAnchor | null = null;
				let anchorMs = 0;
				let anchorScale = 1;
				if (retriedClick && choice.target.type !== '绽放') {
					const devRect = D6_MAP_SLOT_DEV_RECTS[slotIndex];
					if (devRect) {
						const anchorStart = now();
						try {
							// slotOper 已经过 helperBridge.regionClickTrans，是屏幕坐标；
							// 用它的宽度 / 开发坐标宽度得到屏幕缩放比例。
							const scale = (slotOper[2] - slotOper[0]) / (devRect[2] - devRect[0]);
							if (scale > 0.5 && scale < 4) {
								anchorScale = scale;
								const padLeft = 70;
								const padTop = 95;
								const padRight = 70;
								const padBottom = 45;
								const dx0 = Math.max(0, devRect[0] - padLeft);
								const dy0 = Math.max(0, devRect[1] - padTop);
								const dx1 = Math.min(1279, devRect[2] + padRight);
								const dy1 = Math.min(719, devRect[3] + padBottom);
								const helper = thisScript.helperBridge.helper;
								const bannerSr = helper.GetPoint(dx0, dy0, center);
								const bannerEr = helper.GetPoint(dx1, dy1, center);
								if (bannerSr.x < bannerEr.x && bannerSr.y < bannerEr.y) {
									const bitmap = helper.GetBitmap(bannerSr.x, bannerSr.y, bannerEr.x, bannerEr.y);
									if (bitmap) {
										try {
											let image = bitmapToImageData(bitmap);
											if (anchorScale > 1.08) {
												image = downsampleD6BannerImage(image, anchorScale);
											}
											const localCx = (slotOper[0] + slotOper[2]) / 2 - bannerSr.x;
											const localCy = (slotOper[1] + slotOper[3]) / 2 - bannerSr.y;
											const det = detectD6BannerAnchor(image, [
												localCx / anchorScale,
												localCy / anchorScale,
											]);
											if (det) {
												anchor = {
													...det,
													x: bannerSr.x + det.x * anchorScale,
													y: bannerSr.y + det.y * anchorScale,
												};
											}
										} finally {
											try {
												bitmap.recycle();
											} catch (e) {
												// 忽略回收异常
											}
										}
									}
								}
							}
						} catch (e) {
							console.log(`[d6jue-map] 横幅锚点识别异常: ${e}`);
						}
						anchorMs = now() - anchorStart;
					}
				}

				// 点击策略：
				// - 首点/无锚点重试：从标定的截断正态分布随机取一个点；
				// - 横幅锚点命中：点文字附近的小块（仍由 regionClick 加随机抖动）；
				// - 没有标定分布的 slot：保留原固定窄条。
				// 每次只点一个点，不做固定连击；重试次数由步数状态机的时间门控决定。
				let clickOper: number[][];
				let clickSource = 'fixed';
				let clickDevPoint: { x: number; y: number; cx: number; cy: number } | null = null;
				let anchorDevX = 0;
				let anchorDevY = 0;
				if (anchor) {
					const halfW = Math.max(D6_MAP_CLICK_HALF_W, Math.round(6 * anchorScale));
					const halfH = Math.max(8, Math.round(8 * anchorScale));
					clickOper = [[
						Math.round(anchor.x) - halfW,
						Math.round(anchor.y) - halfH,
						Math.round(anchor.x) + halfW,
						Math.round(anchor.y) + halfH,
						slotOper[4] || 500,
					]];
					clickSource = 'anchor';
					// 把真实横幅 x 缓存为后续随机分布的中心；只缓存 x，y 仍靠分布覆盖。
					const cacheRect = D6_MAP_SLOT_DEV_RECTS[slotIndex];
					const dist = D6_MAP_CLICK_DIST[slotIndex];
					if (cacheRect && dist && anchorScale > 0) {
						const devCx = (cacheRect[0] + cacheRect[2]) / 2;
						const devCy = (cacheRect[1] + cacheRect[3]) / 2;
						const screenCx = (slotOper[0] + slotOper[2]) / 2;
						const screenCy = (slotOper[1] + slotOper[3]) / 2;
						anchorDevX = devCx + (anchor.x - screenCx) / anchorScale;
						anchorDevY = devCy + (anchor.y - screenCy) / anchorScale;
						// 只接受离标定中心不超过 35px 的锚点，避免把远处的 UI 文字当成横幅缓存进来。
						if (isFinite(anchorDevX) && Math.abs(anchorDevX - dist.cx) <= 35) {
							const prev = d6MapAnchorXCache[slotIndex];
							d6MapAnchorXCache[slotIndex] = prev === undefined
								? anchorDevX
								: prev * 0.5 + anchorDevX * 0.5;
						}
					}
				} else {
					clickDevPoint = pickD6MapClickPoint(slotIndex);
					if (clickDevPoint) {
						const screenPoint = thisScript.helperBridge.helper.GetPoint(clickDevPoint.x, clickDevPoint.y, center);
						clickOper = [[
							screenPoint.x - 1,
							screenPoint.y - 1,
							screenPoint.x + 1,
							screenPoint.y + 1,
							slotOper[4] || 500,
						]];
						clickSource = 'random';
					} else {
						// 没有标定分布的 slot（four-1/3/4）保留原固定窄条
						const clickCx = Math.round((slotOper[0] + slotOper[2]) / 2);
						clickOper = [[
							clickCx - D6_MAP_CLICK_HALF_W,
							slotOper[1],
							clickCx + D6_MAP_CLICK_HALF_W,
							slotOper[3],
							slotOper[4] || 500,
						]];
					}
				}
				const stepLeftBefore = g.d6jueStepLeft || 0;
				const stepNo = getStepTracker().stepNo;
				const islandSeq = getStepTracker().nextIslandSeq;
				// 岛屿 key 用独立自增序号：即使 stepLeft 短暂滞后/校正，同一座岛也不会复用旧 key。
				// 点击失败重试时 islandSeq 不变，本岛 +50 仍然只记一次。
				beginIsland(`step:${islandSeq}`);
				thisScript.regionClick(clickOper);
				getStepTracker().noteClick(now(), rowKey, lastMapHash);
				syncStepState();
				g.d6jueLastMapSig = rowKey;
				g.d6jueLastMapSigTime = now();
				// 新点击开始一轮 pending 重读预算
				stepCounterRead = null;
				d6jueAnalysisLog('map.step', {
					step: stepNo,
					left: stepLeftBefore,
					seq: islandSeq,
					nodes: state.reachable.map(n => n.type).join('/'),
					target: choice.target.type,
					slot: choice.slot,
					clickSource,
					clickRetry: retriedClick ? 1 : 0,
					clickPx: Math.round((clickOper[0][0] + clickOper[0][2]) / 2),
					clickPy: Math.round((clickOper[0][1] + clickOper[0][3]) / 2),
					clickDevX: clickDevPoint ? clickDevPoint.x : Math.round(anchorDevX),
					clickDevY: clickDevPoint ? clickDevPoint.y : Math.round(anchorDevY),
					clickDistCx: clickDevPoint ? clickDevPoint.cx : 0,
					clickDistCy: clickDevPoint ? clickDevPoint.cy : 0,
					clickX1: clickOper[0][0],
					clickY1: clickOper[0][1],
					clickX2: clickOper[0][2],
					clickY2: clickOper[0][3],
					anchor: anchor ? 'banner' : 'fixed',
					anchorMs,
					anchorX: anchor ? Math.round(anchor.x) : 0,
					anchorY: anchor ? Math.round(anchor.y) : 0,
					anchorW: anchor ? Math.round(anchor.w) : 0,
					anchorH: anchor ? Math.round(anchor.h) : 0,
					anchorScore: anchor ? Number(anchor.score.toFixed(3)) : 0,
					mode: priority === MAP_PRIORITY_SHOP_HUNT ? 'hunt' : (clearMet ? 'cleared' : 'normal'),
					wallet: g.d6jueWanxiangling || 0,
					pending: g.d6jueWanxianglingPending || 0,
					lei: leiLevel,
					power: powerLevel,
				});
				if (choice.target.type === '绽放' && stepLeftBefore > 0 && [5, 10, 15, 20].indexOf(stepNo) === -1) {
					console.log(`[d6jue-map] 绽放出现在第${stepNo}步（预期5/10/15/20），请检查步数记录`);
				}
				const clickText = clickSource === 'random' && clickDevPoint
					? `随机分布点=${clickDevPoint.x},${clickDevPoint.y}(中心${clickDevPoint.cx},${clickDevPoint.cy})`
					: (anchor
						? `横幅锚点=${Math.round(anchor.x)},${Math.round(anchor.y)}(${anchor.w}x${anchor.h},score=${anchor.score.toFixed(2)},${anchorMs}ms)`
						: `固定选择位(${anchorMs}ms)`);
				console.log(`[d6jue-map] 点击 ${choice.target.type}@${d6MapColName(choice.target.col)}，主地图选择位=${choice.slot}(${choice.index + 1}/${choice.count})，方式=${clickSource}${retriedClick ? '(重试)' : ''}，${clickText}，实际点=${Math.round((clickOper[0][0] + clickOper[0][2]) / 2)},${Math.round((clickOper[0][1] + clickOper[0][3]) / 2)}，剩余${stepLeftBefore}步（待确认）`);
				return true;
			}
			console.log('[d6jue-map] 点击冷却中');
			return false;
		};

		// 只有脚本点击「开启-六道觉」后才允许执行本局操作
		const startRun = () => {
			g.d6jueStarted = true;
			g.d6jueStartPrompted = false;
			unknownMapNotified = false;
			bossDetectLogged = false;
			shopGridMissLogged = false;
			shopEnterTime = 0;
			mapStateCache = null;
			mapStateCacheTime = 0;
			d6BuffScreenSettled = false;
			d6BuffRefreshCount = 0;
			d6BuffScreenLastSeen = 0;
			d6BuffWalletOcrSkipUntil = 0;
			g.d6jueLoop = 0;
			g.d6jueCoreBuff = 0;
			g.d6jueSkillCount = 0;
			g.d6jueLeiLevel = 0;
			g.d6jueOtherBuffSelected = false;
			g.d6juePowerLevel = 0;
			g.d6jueYaoLevel = 0;
			g.d6jueBeishuiLevel = 0;
			g.d6jueChifenLevel = 0;
			g.d6jueCantClear = false;
			g.d6jueShopRefresh = 0;
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			g.d6jueShopBuyTime = 0;
			g.d6jueWanxiangling = 0;
			g.d6jueWanxianglingPending = 0;
			lastWalletOcrTime = 0;
			d6IslandKey = '';
			d6IslandGainDone = false;
			d6PendingRefreshCost = 0;
			d6PendingRefreshSource = '';
			d6PendingRefreshWalletBefore = 0;
			d6PendingRefreshTime = 0;
			d6HuanxiPending = false;
			d6HuanxiPendingTime = 0;
			d6HuanxiPendingSig = '';
			g.d6jueStepLeft = D6_TOTAL_STEPS;
			g.d6jueHuanxiShop = 0;
			buffSelectLockActive = false;
			buffSelectLockUntil = 0;
			resetBuffScreenState();
			g.d6jueLastMapSig = '';
			g.d6jueLastMapSigTime = 0;
			g.d6jueStepPending = false;
			lastMapHash = '';
			stepCounterRead = null;
			stepTracker = new D6StepTracker({ totalSteps: D6_TOTAL_STEPS });
			stepTracker.reset(D6_TOTAL_STEPS, true, now());
			syncStepState();
			g.d6jueCurrentBegin = now();
			g.d6jueBossStartTime = 0;
			if (!g.d6jueBegin) {
				g.d6jueBegin = now();
			}
			g.d6jueTimes = (g.d6jueTimes || 0) + 1;
			d6jueAnalysisSetRun(now());
			d6jueAnalysisLog('step.init', { left: D6_TOTAL_STEPS, mode: 'run_reset' });
			d6jueAnalysisLog('run.start', {
				ver: D6_LOGIC_VERSION,
				times: g.d6jueTimes || 0,
				step: g.d6jueStepLeft || 0,
				wallet: 0,
				pending: 0,
				lei: 0,
				power: 0,
			});
			console.log(`[d6jue-analysis] 记录文件: ${d6jueAnalysisPath()}`);
		};
		const markNotStarted = () => {
			g.d6jueStarted = false;
		};

		// ---- 入口流程（未开启也允许，用于进入副本）----
		if (oper([0], '六道觉_进入六道之门', 500)) {
			markNotStarted();
			return true;
		}
		if (oper([1], '六道觉_选择觉', 500)) {
			markNotStarted();
			return true;
		}
		if (oper([2], '六道觉_进入副本', 500)) {
			markNotStarted();
			return true;
		}

		// ---- 暂时取消“必须由脚本点击开启”的限制 ----
		// TODO(六道觉): 后续把 REQUIRE_SCRIPT_START 改回 true，恢复未开启时的提示和拦截
		if (REQUIRE_SCRIPT_START && !g.d6jueStarted) {
			// 如果已经在开局流程（确认式神/上阵/选舞技/初始技能），说明不是脚本点的开启，不再接管
			const openingFlow = thisScript.desc({
				id: 323,
				name: '六道觉_开局流程检测',
				operator: [thisOperator[31], thisOperator[32], thisOperator[33], thisOperator[34]],
			}, thisScript.scheme.commonConfig);
			if (!openingFlow && oper([3], '六道觉_开启-六道觉')) {
				startRun();
				return true;
			}
			if (!g.d6jueStartPrompted) {
				thisScript.myToast('六道觉未开启：请先进入六道之门·觉并由脚本点击「开启」', 3000);
				console.log('[d6jue] 未点击开启，跳过六道觉操作');
				g.d6jueStartPrompted = true;
			}
			return false;
		}

		// ---- 已开启：确认-选择试炼式神 / 开启-上阵式神（放在开启前，避免同时命中时重复计数）----
		if (oper([31], '六道觉_确认-选择试炼式神', 500)) return true;
		if (oper([32], '六道觉_开启-上阵式神', 500)) return true;

		// ---- 兼容已开启状态下再次点到「开启」：重置本局统计 ----
		if (oper([3], '六道觉_开启-六道觉')) {
			startRun();
			return true;
		}

		// ---- 选择舞技 ----
		if (oper([33], '六道觉_选择舞技', 500)) return true;

		// ---- 初始技能：三个区域随机选一个 ----
		if (oper([34], '六道觉_初始技能界面')) {
			const regions = thisOperator[35] && thisOperator[35].oper;
			if (regions && regions.length > 0) {
				const index = Math.floor(Math.random() * regions.length);
				thisScript.regionClick([regions[index]]);
			}
			return true;
		}

		// ---- 获得奖励界面：优先点掉，避免奖励弹窗遮挡后续判定 ----
		// 首领结算的「获得奖励」由退出结算流程处理；这里不加 54，避免重复维护两套标题取色。
		if (oper([42], '六道觉_获得奖励界面')) return true;

		// ---- 绽放之屿：右下角直接离开，不进入战斗 ----
		if (oper([45], '六道觉_绽放_离开', 500)) {
			console.log('[d6jue] 绽放离开按钮命中');
			addIslandGainOnce('绽放岛');
			return true;
		}

		// ---- 神秘之屿：退出后 +50 ----
		if (oper([17], '六道觉_神秘_转换')) {
			addIslandGainOnce('神秘岛');
			return true;
		}
		if (oper([43], '六道觉_神秘_仿造')) {
			addIslandGainOnce('神秘岛');
			return true;
		}

		// ---- 万象赐福使用 ----
		if (oper([51], '六道觉_万象赐福使用')) return true;

		// ---- 混沌之屿-幸运秘宝：优先于精英判定 ----
		// 47 的秘宝专属点是宝匣/离开按钮的渐变色，不是纯色；运行时全局
		// colorSimilar 可能设得很高（例如 100），用 thisScript.oper 会把
		// 2~4 的通道差也判失败，导致 47 漏判、46 按标题命中后反复点宝匣。
		// 这里固定用 88（与事件用例一致）直接比较，命中后点「离开」。
		{
			const chestOp = thisOperator[47];
			if (chestOp && chestOp.desc && chestOp.oper) {
				const chestStart = now();
				const chestMatched = thisScript.helperBridge.helper.CompareColorEx(
					chestOp.desc,
					D6_CHEST_SIMILAR,
					false,
				);
				perfLog('oper 六道觉_混沌_幸运秘宝', now() - chestStart, `matched=${chestMatched} similar=${D6_CHEST_SIMILAR}`);
				if (chestMatched) {
					noteStepIsland('chest');
					thisScript.regionClick(chestOp.oper);
					addIslandGainOnce('混沌岛');
					d6jueAnalysisLog('map.chest_exit', {
						step: D6_TOTAL_STEPS - (g.d6jueStepLeft || 0) + 1,
						wallet: g.d6jueWanxiangling || 0,
						lei: g.d6jueLeiLevel || 0,
						power: g.d6juePowerLevel || 0,
					});
					console.log('[d6jue] 混沌秘宝命中，点击离开');
					return true;
				}
			}
		}

		// ---- 通用挑战按钮：必须放在混沌精英 46 之前 ----
		// 混沌精英选中后左上角「混沌之屿」标题仍然匹配 46；如果先走 46，
		// 会反复点精英，永远点不到右下角「挑战」。
		// 最后 1~2 步留给下面的首领专用 50/条件检查，避免绕过通关条件。
		if ((g.d6jueStepLeft || 0) > 2 && oper([20], '六道觉_挑战')) {
			d6jueAnalysisLog('map.challenge_early', {
				step: D6_TOTAL_STEPS - (g.d6jueStepLeft || 0) + 1,
				left: g.d6jueStepLeft || 0,
				wallet: g.d6jueWanxiangling || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
			console.log('[d6jue] 通用挑战按钮命中，点击挑战');
			addIslandGainOnce('鏖战岛');
			return true;
		}

		// ---- 混沌之屿-精英：优先点击 ----
		if (oper([46], '六道觉_混沌_精英')) {
			// 精英选择后还会经过通用挑战按钮，每岛 +50 只记一次
			addIslandGainOnce('混沌精英岛');
			return true;
		}

		// ---- 商店购买确认：点击购买后必须确认成功，不能提前标记轰雷已获得 ----
		const completeShopBuy = (how: string) => {
			g.d6jueLeiLevel = 1;
			g.d6jueWanxiangling = Math.max(0, (g.d6jueWanxiangling || 0) - D6_SHOP_LEI_PRICE);
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			console.log(`[d6jue-shop] 购买轰雷成功(${how})，当前计算余额=${g.d6jueWanxiangling}（等下一次OCR校验）`);
			d6jueAnalysisLog('shop.buy_success', {
				how,
				stock: (g.d6jueShopRefresh || 0) + 1,
				wallet: g.d6jueWanxiangling || 0,
				cost: D6_SHOP_LEI_PRICE,
				step: g.d6jueStepLeft || 0,
				lei: 1,
				power: g.d6juePowerLevel || 0,
			});
		};
		const failShopBuy = (reason: string) => {
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			console.log(`[d6jue-shop] 购买轰雷失败(${reason})，退出商店且不标记轰雷`);
			d6jueAnalysisLog('shop.buy_failed', {
				reason,
				stock: (g.d6jueShopRefresh || 0) + 1,
				wallet: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
			thisScript.regionClick([[1200, 610, 1245, 660, 1500]]);
			addIslandGainOnce('宁息岛');
			g.d6jueShopRefresh = 0;
			shopGridMissLogged = false;
		};
		if (g.d6jueShopBuyPending) {
			const stage = g.d6jueShopBuyStage || 1;
			const elapsed = now() - (g.d6jueShopBuyTime || 0);
			if (stage === 1) {
				if (elapsed >= 500) {
					const confirmDetected = thisScript.desc({
						id: 323,
						name: '六道觉_商店确认购买检测',
						operator: [thisOperator[15]],
					}, thisScript.scheme.commonConfig);
					if (confirmDetected && thisOperator[15] && thisOperator[15].oper) {
						thisScript.regionClick(thisOperator[15].oper);
						g.d6jueShopBuyStage = 2;
						g.d6jueShopBuyTime = now();
						console.log('[d6jue-shop] 已点击确认购买，等待校验');
						return true;
					}
					// 没有确认弹窗的自动购买：图标消失视为成功
					if (!thisScript.findMultiColor('六道觉_商店_轰雷')) {
						completeShopBuy('auto');
						return true;
					}
				}
				if (elapsed > 5000) {
					failShopBuy('confirm_timeout');
					return true;
				}
				return false;
			}
			// stage 2：已点确认，图标消失/商店关闭才判定成功
			if (elapsed >= 800) {
				if (!thisScript.findMultiColor('六道觉_商店_轰雷')) {
					completeShopBuy('confirm');
					return true;
				}
				if (elapsed > 3000) {
					failShopBuy('confirm_unverified');
					return true;
				}
			}
			return false;
		}

		// ---- 商店：找轰雷；找不到按万相铃/刷新次数刷新，否则退出 ----
		const shopDetected = thisScript.desc({
			id: 323,
			name: '六道觉_商店界面',
			operator: [thisOperator[13]],
		}, thisScript.scheme.commonConfig);
		if (shopDetected) {
			noteStepIsland('shop');
			if (!shopEnterTime) {
				shopEnterTime = now();
				console.log('[d6jue-shop] 进入商店');
				d6jueAnalysisLog('shop.enter', {
					step: g.d6jueStepLeft || 0,
					wallet: g.d6jueWanxiangling || 0,
					pending: g.d6jueWanxianglingPending || 0,
					lei: g.d6jueLeiLevel || 0,
					power: g.d6juePowerLevel || 0,
				});
			}
			readWanxianglingOcr('shop');
			const leiLevel = g.d6jueLeiLevel || 0;
			if (leiLevel < 1) {
				const wanxiangling = g.d6jueWanxiangling || 0;
				const lei = thisScript.findMultiColor('六道觉_商店_轰雷');
				if (lei) {
					// findMultiColor 返回设备坐标，先换算回 1280x720 开发坐标再套九宫格
					const screenBR = thisScript.helperBridge.helper.GetPoint(1280, 720, right);
					const devX = lei.x * 1280 / Math.max(1, screenBR.x);
					const devY = lei.y * 720 / Math.max(1, screenBR.y);
					const gridIndex = d6ShopGridIndex(devX, devY);
					if (wanxiangling >= D6_SHOP_LEI_PRICE && gridIndex >= 0) {
						const grid = D6_SHOP_BUY_GRID[gridIndex];
						const buyOper = thisScript.helperBridge.regionClickTrans([[
							grid[0], grid[1], grid[2], grid[3], grid[4], grid[5], grid[6], grid[7],
						]]);
						const buyRect = buyOper[0];
						const x1 = buyRect[0];
						const y1 = buyRect[1];
						const x2 = buyRect[2];
						const y2 = buyRect[3];
						// 购买前留一张商店截图，便于核对卡片/购买按钮位置
						try {
							const dir = context.getExternalFilesDir(null);
							if (dir) {
								const img = images.captureScreen();
								if (img) {
									const shot = `${dir.getAbsolutePath()}/d6jue_shop_${g.d6jueTimes || 0}_${g.d6jueStepLeft || 0}_${now()}.png`;
									images.save(img, shot);
									img.recycle();
									console.log(`[d6jue-shop] 商店截图: ${shot}`);
									d6jueAnalysisLog('shop.screenshot', { path: shot, step: g.d6jueStepLeft || 0, x: lei.x, y: lei.y, grid: gridIndex + 1 });
								}
							}
						} catch (e) {
							// 截图失败不影响购买
						}
						// 九宫格购买区：只点图标下方名称/价格区，不点图标
						thisScript.regionClick(buyOper);
						g.d6jueShopBuyPending = true;
						g.d6jueShopBuyStage = 1;
						g.d6jueShopBuyTime = now();
						console.log(`[d6jue-shop] 点击购买轰雷 九宫格${gridIndex + 1}(${Math.floor(gridIndex / 3) + 1}行${gridIndex % 3 + 1}列) ${x1},${y1},${x2},${y2}，等待确认，万相铃=${wanxiangling}`);
						d6jueAnalysisLog('shop.buy_click', {
							stock: (g.d6jueShopRefresh || 0) + 1,
							grid: gridIndex + 1,
							row: Math.floor(gridIndex / 3) + 1,
							col: gridIndex % 3 + 1,
							x: lei.x,
							y: lei.y,
							devX: devX.toFixed(1),
							devY: devY.toFixed(1),
							x1,
							y1,
							x2,
							y2,
							wallet: wanxiangling,
							step: g.d6jueStepLeft || 0,
							lei: g.d6jueLeiLevel || 0,
							power: g.d6juePowerLevel || 0,
						});
						return true;
					}
					if (wanxiangling < D6_SHOP_LEI_PRICE) {
						console.log(`[d6jue-shop] 找到轰雷但万相铃不足(${wanxiangling}<${D6_SHOP_LEI_PRICE})`);
						d6jueAnalysisLog('shop.hit_no_money', {
							stock: (g.d6jueShopRefresh || 0) + 1,
							wallet: wanxiangling,
							step: g.d6jueStepLeft || 0,
							lei: g.d6jueLeiLevel || 0,
						});
					} else if (!shopGridMissLogged) {
						shopGridMissLogged = true;
						console.log(`[d6jue-shop] 轰雷图标不在九宫格内(${devX.toFixed(1)},${devY.toFixed(1)})，跳过购买`);
						d6jueAnalysisLog('shop.buy_grid_miss', {
							x: lei.x,
							y: lei.y,
							devX: devX.toFixed(1),
							devY: devY.toFixed(1),
							grid: gridIndex,
							stock: (g.d6jueShopRefresh || 0) + 1,
							wallet: wanxiangling,
							step: g.d6jueStepLeft || 0,
							lei: g.d6jueLeiLevel || 0,
						});
					}
				}

				const refreshAvailable = thisScript.desc({
					id: 323,
					name: '六道觉_商店刷新检测',
					operator: [thisOperator[52]],
				}, thisScript.scheme.commonConfig);
				// 刷新后仍要保留 200 买轰雷：商店刷新 100/次
				const canKeepLeiPrice = wanxiangling - D6_SHOP_REFRESH_COST >= D6_SHOP_LEI_PRICE;
				if (refreshAvailable && canKeepLeiPrice && (g.d6jueShopRefresh || 0) < D6_SHOP_REFRESH_MAX) {
					thisScript.regionClick([[595, 600, 640, 645, 1500]]);
					g.d6jueShopRefresh = (g.d6jueShopRefresh || 0) + 1;
					// 刷新费等下一次 OCR 校验；OCR 关闭时才直接扣
					beginPendingRefreshCost(D6_SHOP_REFRESH_COST, 'shop_refresh', wanxiangling);
					console.log(`[d6jue-shop] 未见轰雷，万相铃=${wanxiangling}，刷新第${g.d6jueShopRefresh}次(-${D6_SHOP_REFRESH_COST}，保留${D6_SHOP_LEI_PRICE}购买)，当前=${g.d6jueWanxiangling}（等OCR校验）`);
					d6jueAnalysisLog('shop.refresh', {
						stock: g.d6jueShopRefresh,
						walletBefore: wanxiangling,
						walletAfter: g.d6jueWanxiangling || 0,
						cost: D6_SHOP_REFRESH_COST,
						costPending: thisConf.walletOcr !== false ? 1 : 0,
						step: g.d6jueStepLeft || 0,
						lei: g.d6jueLeiLevel || 0,
					});
					return true;
				}
				// 刚进店时刷新按钮可能还没稳定渲染，给一次重试，避免误判为无法刷新
				if (!refreshAvailable && now() - shopEnterTime < 900) {
					console.log('[d6jue-shop] 刷新按钮未识别，等待界面稳定后重试');
					return false;
				}
				// 诊断：钱够、没轰雷且没有刷新按钮时留一张商店截图
				if (thisConf.walletOcr !== false && wanxiangling >= D6_SHOP_LEI_PRICE) {
					try {
						const dir = context.getExternalFilesDir(null);
						if (dir) {
							const img = images.captureScreen();
							if (img) {
								const shot = `${dir.getAbsolutePath()}/d6jue_shop_nohit_${g.d6jueTimes || 0}_${g.d6jueStepLeft || 0}_${now()}.png`;
								images.save(img, shot);
								img.recycle();
								console.log(`[d6jue-shop] 无货退出截图: ${shot}`);
								d6jueAnalysisLog('shop.nohit_shot', {
									path: shot,
									step: g.d6jueStepLeft || 0,
									wallet: wanxiangling,
									refresh: refreshAvailable ? 1 : 0,
									refreshCount: g.d6jueShopRefresh || 0,
									canKeep: canKeepLeiPrice ? 1 : 0,
								});
							}
						}
					} catch (e) {
						// 截图失败不影响退出
					}
				}
				console.log(`[d6jue-shop] 未见轰雷且无法刷新(万相铃=${wanxiangling}，刷新${g.d6jueShopRefresh || 0}次，刷新识别=${refreshAvailable ? 1 : 0})，退出商店`);
				d6jueAnalysisLog('shop.exit', {
					reason: 'no_hit',
					stock: (g.d6jueShopRefresh || 0) + 1,
					wallet: wanxiangling,
					step: g.d6jueStepLeft || 0,
					lei: g.d6jueLeiLevel || 0,
					power: g.d6juePowerLevel || 0,
					refresh: refreshAvailable ? 1 : 0,
					refreshCount: g.d6jueShopRefresh || 0,
					canKeep: canKeepLeiPrice ? 1 : 0,
				});
			} else {
				console.log('[d6jue-shop] 轰雷已满足，退出商店');
				d6jueAnalysisLog('shop.exit', {
					reason: 'lei_done',
					stock: (g.d6jueShopRefresh || 0) + 1,
					wallet: g.d6jueWanxiangling || 0,
					step: g.d6jueStepLeft || 0,
					lei: leiLevel,
					power: g.d6juePowerLevel || 0,
				});
			}
			thisScript.regionClick([[1200, 610, 1245, 660, 1500]]);
			addIslandGainOnce('宁息岛');
			g.d6jueShopRefresh = 0;
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			shopGridMissLogged = false;
			shopEnterTime = 0;
			return true;
		}

		// ---- 只打双倍：次数用完停止 ----
		if (thisConf.onlyDouble && oper([29], '六道觉_双倍次数为0')) {
			thisScript.myToast('双倍次数已用完，停止运行');
			console.log('双倍次数已用完，停止运行');
			d6jueAnalysisLog('run.end', { result: 'stop_double', step: g.d6jueStepLeft || 0, wallet: g.d6jueWanxiangling || 0, lei: g.d6jueLeiLevel || 0, power: g.d6juePowerLevel || 0 });
			thisScript.rerun('__停止脚本__');
			return true;
		}

		// ---- 选事件：识别到唤息即处理，目标完全由小地图决定 ----
		// 唤息只在“选择下一层节点”阶段出现（暗=不可刷新，亮=可刷新），是阶段指示器；
		// 备战与节点选择无关且可能被其他 UI 遮挡，不再作为门禁。
		// 是否真的有可选节点仍由 handleMapNodes 的小地图识别做最终判定。
		const huanxiDark = oper([37], '六道觉_唤息_暗');
		const huanxiBright = !huanxiDark && oper([44], '六道觉_唤息_亮');
		if (huanxiDark || huanxiBright) {
			// 小地图无法确定目标时不点任何其他节点
			return handleMapNodes(true, huanxiBright);
		}

		// TODO(六道觉): 若 g.d6jueOtherBuffSelected 为 true，boss 战开打前需要先卸载其他 buff
		// ---- 首领挑战：条件不足时结束脚本（TODO: 改为直接退出 boss 挑战）----
		const bossDetected = thisScript.desc({
			id: 323,
			name: '六道觉_首领挑战检测',
			operator: [thisOperator[50]],
		}, thisScript.scheme.commonConfig);
		if (bossDetected) {
			// 首领是最后一回合：直接置 0，不依赖点击确认。
			const bossHadPending = !!g.d6jueStepPending;
			if (stepTracker) {
				stepTracker.noteBoss();
				syncStepState();
			}
			g.d6jueStepLeft = 0;
			g.d6jueStepPending = false;
			if (bossHadPending) {
				d6jueAnalysisLog('map.step_confirm', { left: g.d6jueStepLeft, nodes: 'boss', reason: 'boss' });
			}
			const powerLevel = g.d6juePowerLevel || 0;
			const leiLevel = g.d6jueLeiLevel || 0;
			d6jueAnalysisLog('boss.enter', {
				step: g.d6jueStepLeft || 0,
				power: powerLevel,
				lei: leiLevel,
				wallet: g.d6jueWanxiangling || 0,
				cantClear: !!g.d6jueCantClear,
			});
			if (powerLevel <= 2 || leiLevel <= 0 || g.d6jueCantClear) {
				// TODO(六道觉): 通关条件不足时直接退出 boss 挑战；当前先结束脚本
				const flag = g.d6jueCantClear ? '（无法通关标记=T）' : '';
				const msg = `通关条件不足${flag}：力量等级=${powerLevel} 轰雷等级=${leiLevel}，结束脚本`;
				console.log('[d6jue] ' + msg);
				d6jueAnalysisLog('run.end', {
					result: 'boss_fail',
					reason: g.d6jueCantClear ? 'cant_clear' : 'condition',
					step: g.d6jueStepLeft || 0,
					power: powerLevel,
					lei: leiLevel,
					wallet: g.d6jueWanxiangling || 0,
				});
				thisScript.myToast(msg);
				thisScript.rerun('__停止脚本__');
				return true;
			}
			if (!g.d6jueBossStartTime) g.d6jueBossStartTime = now();
			thisScript.oper({ id: 323, name: '六道觉_首领挑战', operator: [thisOperator[50]] });
			return true;
		}

		// ---- 挑战按钮：放在鏖战前，避免挑战界面仍带着地图点位时误点怪物 ----
		// 首领专用 operator[50] 未命中时，用通用挑战按钮兜底：
		// 1. 挑战界面出现只作为“已进岛”证据，步数仍由下一次稳定地图/计数器下降确认；
		// 2. 最后一步且条件不足时，不再点通用挑战，直接停止。
		if ((g.d6jueStepLeft || 0) <= 2) {
			const challengeDetected = thisScript.desc({
				id: 323,
				name: '六道觉_挑战检测',
				operator: [thisOperator[20]],
			}, thisScript.scheme.commonConfig);
			if (challengeDetected) {
				noteStepIsland('challenge_detect');
				const power = g.d6juePowerLevel || 0;
				const lei = g.d6jueLeiLevel || 0;
				const cantClear = !!g.d6jueCantClear;
				if (!bossDetectLogged) {
					bossDetectLogged = true;
					d6jueAnalysisLog('boss.detect', {
						step: g.d6jueStepLeft || 0,
						power,
						lei,
						cantClear,
						boss50: 0,
						challenge20: 1,
					});
					console.log(`[d6jue-boss] 首领专用desc未命中，但通用挑战按钮命中(剩余${g.d6jueStepLeft || 0}步，力量=${power} 轰雷=${lei} 无法通关=${cantClear})`);
				}
				if ((g.d6jueStepLeft || 0) <= 0 && (power <= 2 || lei <= 0 || cantClear)) {
					const flag = cantClear ? '（无法通关标记=T）' : '';
					const msg = `已到首领且通关条件不足${flag}：力量=${power} 轰雷=${lei}，结束脚本`;
					console.log('[d6jue] ' + msg);
					d6jueAnalysisLog('boss.guard', {
						step: g.d6jueStepLeft || 0,
						power,
						lei,
						cantClear,
					});
					thisScript.myToast(msg);
					thisScript.rerun('__停止脚本__');
					return true;
				}
				// 通用挑战 20 在最后一行可能只是普通战斗（本局 0 步时出现过），
				// 不能在这里启动首领 60 秒计时；计时只在真正命中 operator[50] 时启动。
			}
		}
		if (oper([20], '六道觉_挑战')) {
			addIslandGainOnce('鏖战岛');
			return true;
		}

		// ---- 鏖战-选择怪物：进入鏖战之屿后点右侧敌人；主地图节点由 operator[53] 固定选择位处理 ----
		if (oper([38], '六道觉_鏖战_选择怪物')) {
			addIslandGainOnce('鏖战岛');
			return true;
		}

		// ---- 舞技强化-选择强化：优先于刷新门禁，避免选强化界面被当成舞技强化入口 ----
		if (oper([41], '六道觉_舞技强化-选择强化')) {
			if (buffSelectLocked()) return true;
			const powerBefore = g.d6juePowerLevel || 0;
			g.d6juePowerLevel = powerBefore + 1;
			lockBuffSelect();
			resetBuffScreenState();
			addWanxiangling(D6_ISLAND_BUFF_GAIN, '舞技强化选择');
			d6jueAnalysisLog('skill.pick', {
				powerBefore,
				powerAfter: g.d6juePowerLevel,
				wallet: g.d6jueWanxiangling || 0,
				lei: g.d6jueLeiLevel || 0,
				island: d6IslandKey,
				step: g.d6jueStepLeft || 0,
			});
			return true;
		}

		// ---- 舞技强化/buff选择：右下角「刷新」表示该界面（亮/暗都识别）----
		const refreshDark = oper([49], '六道觉_舞技强化_刷新_暗');
		if (oper([39], '六道觉_舞技强化_刷新') || refreshDark) {
			addIslandGainOnce('战斗岛');
			// 新 buff 界面先等入场动画结束；同一界面的后续轮次（刷新后）不重复等
			const buffScreenGap = d6BuffScreenLastSeen ? now() - d6BuffScreenLastSeen : Infinity;
			const isNewBuffScreen = buffScreenGap > D6_BUFF_SCREEN_GAP_MS;
			if (isNewBuffScreen) resetBuffScreenState();
			d6BuffScreenLastSeen = now();
			if (!d6BuffScreenSettled) {
				if (isNewBuffScreen) {
					d6BuffRefreshCount = 0;
					d6BuffLastRefreshTime = 0;
				}
				waitBuffCardsStable('enter', D6_BUFF_ENTER_MIN_MS, '', () => {
					readWanxianglingOcr('buff');
					d6BuffWalletOcrSkipUntil = now() + 3000;
				});
				d6BuffScreenSettled = true;
				thisScript.keepScreen(); // 让下面的 selectLei 用稳定后的卡面帧
			}
			readWanxianglingOcr('buff');
			const powerLevel = g.d6juePowerLevel || 0;
			const leiLevel = g.d6jueLeiLevel || 0;
			const powerSelectable = powerLevel < 10;

			if (powerLevel <= 2) {
				// 优先满足通关：力量≤2，轰雷=0时优先轰雷，否则力量；力量卡不可用时再选其他可用buff
				if (leiLevel === 0 && selectLei()) return true;
				if (powerSelectable && oper([40], '六道觉_舞技强化')) {
					g.d6jueSkillCount = (g.d6jueSkillCount || 0) + 1;
					resetBuffScreenState();
					console.log(`[d6jue] 力量等级=${powerLevel}，继续舞技强化`);
					return true;
				}
				if (selectAllowedBuff()) return true;
			} else if (powerSelectable) {
				if (leiLevel === 0) {
					// 力量3~9、轰雷0：轰雷卡 → 刷新找轰雷 → 舞技强化 → 其他可用buff
					if (selectLei()) return true;
					if (!refreshDark) {
						refreshBuffSelection();
						return true;
					}
					if (oper([40], '六道觉_舞技强化')) {
						g.d6jueSkillCount = (g.d6jueSkillCount || 0) + 1;
						resetBuffScreenState();
						console.log(`[d6jue] 力量等级=${powerLevel}，无轰雷且刷新不可用，选择舞技强化`);
						return true;
					}
					if (selectAllowedBuff()) return true;
				} else {
					// 力量3~9、轰雷>=1：可用buff（轰雷与普通buff同优先级） → 力量 → 亮色刷新
					if (selectAllowedBuff()) return true;
					if (oper([40], '六道觉_舞技强化')) {
						g.d6jueSkillCount = (g.d6jueSkillCount || 0) + 1;
						resetBuffScreenState();
						console.log(`[d6jue] 力量等级=${powerLevel}，继续舞技强化`);
						return true;
					}
					if (!refreshDark) {
						refreshBuffSelection();
						return true;
					}
				}
			} else {
				// 力量已满（>=10）
				if (leiLevel === 0) {
					// 还缺轰雷：轰雷优先；没有则亮色刷新；暗色选可用buff
					if (selectLei()) return true;
					if (!refreshDark) {
						refreshBuffSelection();
						return true;
					}
					if (selectAllowedBuff()) return true;
				} else {
					// 力量与轰雷都不能再选：可用buff → 亮色刷新
					if (selectAllowedBuff()) return true;
					if (!refreshDark) {
						refreshBuffSelection();
						return true;
					}
				}
			}

			console.log('[d6jue-buff] 无可用buff，随机选择');

			// 死局：力量满、轰雷满、无法刷新，且三张全是已知黑名单
			// 此时没有能通关的选择，随机强制拿一张，并标记本局无法通关
			if (powerLevel >= 10 && leiLevel >= 3 && refreshDark) {
				const cards = scanBuffCards();
				const onlyBlacklist = cards.length === 3
					&& cards.every(card => !!card.name && buffBlacklist.includes(card.name));
				if (onlyBlacklist) {
					const pick = cards[Math.floor(Math.random() * cards.length)];
					return forceClickBuffCard(pick.index, pick.name);
				}
			}

			if (selectRandomAllowedBuff()) return true;
			return false;
		}

		// ---- 核心buff满层检测，便于接手打到一半的局 ----
		if (coreBuffMax > 0 && g.d6jueCoreBuff < coreBuffMax && oper([12], '六道觉_核心buff满层检测')) {
			g.d6jueCoreBuff = coreBuffMax;
			thisScript.myToast(`${coreBuff}已满，进入速通模式`);
			console.log(`检测到${coreBuff}满层，进入速通模式`);
			return true;
		}

		// ---- 商店：可购买buff位置不固定，走多点找色 ----
		if (oper([13], '六道觉_商店界面')) {
			const point = thisScript.findMultiColor('六道觉_购买buff');
			if (point) {
				thisScript.regionClick([[point.x - 10, point.y + 50, point.x + 10, point.y + 140, 500]]);
			}
			if (oper([15], '六道觉_商店_确认购买', 500)) return true;
			if (oper([16], '六道觉_商店_退出', 500)) return true;
			return false;
		}

		// ---- 战斗失败：放弃前行 / 确定放弃 ----
		if (oper([24], '六道觉_战斗失败_放弃前行')) {
			d6jueAnalysisLog('battle.fail', {
				stage: 'giveup',
				step: g.d6jueStepLeft || 0,
				power: g.d6juePowerLevel || 0,
				lei: g.d6jueLeiLevel || 0,
			});
			return true;
		}
		if (oper([25], '六道觉_战斗失败_确定放弃')) {
			d6jueAnalysisLog('battle.fail', {
				stage: 'confirm',
				step: g.d6jueStepLeft || 0,
			});
			return true;
		}

		// ---- 其余单步操作：已取色的状态统一执行 ----
		// 21/22 为双倍确认弹窗的两个按钮，默认都启用（与 316 一致），可按需删减
		if (oper([
			8, 9, 10, 11, 12, 16, 18, 19,
			21, 22, 23, 24, 25, 26, 27, 30,
		], '六道觉_执行个别事件')) {
			return true;
		}

		// ---- 结算：统计、推送、切换方案（放在最后，先关掉奖励弹窗再统计）----
		if (oper([28], '六道觉_结算_完成')) {
			// 一轮已经跑完：清空首领计时，避免结算/奖励界面停留时被 60 秒超时误停。
			g.d6jueBossStartTime = 0;
			thisConf.overTimes = Math.floor(Number(thisConf.overTimes) || 0);
			const time = now();
			const currentCost = Math.floor((time - (g.d6jueCurrentBegin || time)) / 1000); // 秒
			d6jueAnalysisLog('run.end', {
				result: 'clear',
				step: g.d6jueStepLeft || 0,
				wallet: g.d6jueWanxiangling || 0,
				pending: 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				seconds: currentCost,
				huanxiShop: g.d6jueHuanxiShop || 0,
			});
			const cost = ((time - (g.d6jueBegin || time)) / 1000 / 60).toFixed(2); // 分
			const costAvg = Math.floor((time - (g.d6jueBegin || time)) / 1000 / (g.d6jueTimes || 1)); // 秒
			const bufLog = coreBuff && coreBuffMax > 0 ? `本局${coreBuff}：${g.d6jueCoreBuff}。` : '';
			let toLog = `${bufLog}通关次数: ${g.d6jueTimes || 0}次, 本次通关时间: ${currentCost}秒, 平均通关时间: ${costAvg}秒, 总通关时间: ${cost}分`;
			if (thisConf.overTimes && g.d6jueTimes >= thisConf.overTimes) {
				toLog = `[${thisScript.schemeHistory.map(item => item.schemeName).join('、')}]已够次数，请查看。` + toLog;
			}
			thisScript.myToast(toLog);
			if (thisConf.pushResult) {
				thisScript.doPush(thisScript, {
					text: toLog,
					before() {
						thisScript.myToast('正在上传数据');
					}
				});
				sleep(2000);
			}
			if (thisConf.overTimes && g.d6jueTimes >= thisConf.overTimes) {
				g.d6jueStarted = false;
				g.d6jueStartPrompted = false;
				thisScript.rerun(thisConf.next_scheme);
				sleep(3000);
				return true;
			}
			// 本局结束：下一次必须由脚本重新点击「开启」才继续执行
			g.d6jueStarted = false;
			g.d6jueStartPrompted = false;
			return true;
		}

		return false;
	}
}
