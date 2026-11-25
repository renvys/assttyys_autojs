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
import { d6juePruneArtifacts } from '@/common/d6jueArtifacts';
import { D6_LOGIC_VERSION, isD6DebugMode } from '@/common/d6jueVersion';

// const normal = -1; //定义常量
const left = 0;
const center = 1;
const right = 2;

let mapSwitchLogged = false;
let unknownMapNotified = false;
// 未知节点连续计时：退岛回图首帧偶发单帧半亮残影（下帧即恢复），连续持续满 10s 才写告警与弹提示；
// 期间照旧暂停点击主地图，避免误点。
let d6UnknownFirstTime = 0;
let d6UnknownLastTime = 0;
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
let buffSelectLockStart = 0;
let buffSelectLockUntil = 0;
let buffSelectLockMs = 0;
let buffSelectLockSample: D6RegionSample | null = null;
// buff 界面卡面稳定状态：入场/刷新动画结束前读卡会一直读到上一组，
// 必须等三张卡真正换完（卡面 hash 连续稳定）再扫描/决定下一次刷新。
let d6BuffScreenSettled = false;
let d6BuffRefreshCount = 0;
let d6BuffRefreshFailCount = 0;
let d6BuffLastRefreshTime = 0;
let d6BuffScreenLastSeen = 0;
// 最近一次选 buff 的时间：混沌精英第二组卡会沿用同一个 buff 界面（只换卡不换屏），
// 命中时据此跳过入场等待；普通战斗的下一组 buff 界面间隔远大于 8s，不会误判。
let d6BuffLastPickTime = 0;
// 六道觉每座岛的进岛 +50、选 buff +100 各只记一次（混沌精英第 2/2 轮先回退第 1 轮预加）。
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
// 唤息后新地图行的候选签名：必须连续稳定一段时间才确认扣款，
// 只有单帧变化（换图动画/淡入淡出）不算。
let d6HuanxiCandidateSig = '';
let d6HuanxiCandidateTime = 0;
// 最近一次点掉「获得奖励」弹窗的完成时刻：战后退回地图存在约 1.25s 镜头下拉停稳/输入锁，
// 而非战后（神秘/宁息/绽放/秘宝）退回地图无此长动画；据此区分两类回图的稳定等待。
let d6LastRewardDismissTime = 0;
// 最近一次点击右下角「离开」（绽放 / 混沌秘宝）的时刻：
// 右下角「离开」与主地图右下角「唤息」位置完全重合，退出动画未播完前若二次命中会误点唤息并被 func 2 确认扣 300。
let d6LastRightLeaveClickTime = 0;
// 最近一次点击退出宁息商店的时刻与上一步点击的主地图槽位：
// 实机 341 次样本显示：从最右侧 four-4（唤息宁息）退出后点击左侧槽位（three-left 等）时，
// 3D 镜头向左回正在退店后 1.5~1.62s 尚未结束，会导致 80%+ 吞点击（step=17 8/8）；
// 据此在点击前精准补等镜头回正，不拖慢其他岛屿和普通槽位。
let d6LastShopExitTime = 0;
let d6LastMapClickSlot = '';
// 开局选完初始技能后的首次进图保护：首次见到主地图唤息时启动与战后一致的镜头解锁等待。
let d6OpeningMapIntroPending = false;
// 商店点击购买轰雷的最近一次点击区域与补点标记：首点未弹出确认框且轰雷仍在时补点 1 次，避免超时弃买。
let d6ShopBuyLastOper: number[][] | null = null;
let d6ShopBuyRetried = false;
// 当前岛屿是否已计入一次选 buff +100（混沌精英第 2/2 轮触发 buff.continuation 时先回退第 1 轮预加，整岛只计一次）
let d6IslandBuffGainDone = false;
// 进入「舞技强化」前记录的 buff 卡面采样，供混沌精英第 1 轮选强化后复用提前解锁
let d6PreSkillBuffSample: D6RegionSample | null = null;
// 记录最近一次主动唤息对应的岛屿序号，防止同一行异常重复唤息
let d6HuanxiUsedSeq = -1;
// 按小地图画面哈希缓存识别结果，避免对像素未变化的同一帧重复跑 NCC
let mapStateCache: { hash: string; state: D6MapState | null } | null = null;
// 最近一次成功读取的小地图画面哈希：给步数状态机判断“点击后是否发生转场/动画”
let lastMapHash = '';
// 步数状态机：地图推进为主，右上角回合数字只做校验/恢复
let stepTracker: D6StepTracker | null = null;
// 同一次开局内重复命中「开启」只写一条分析日志
let startRepeatIgnored = false;
// 战斗失败收尾只做一次：弹窗可能有“放弃前行→确定放弃”两步
let d6BattleFailHandled = false;
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
	pendingTimeoutLogged: boolean;
} | null = null;

interface D6RegionSample {
	hash: string;
	rgb: Uint8Array;
	count: number;
}

/**
 * 直接从 Android Bitmap 抽样 cols×rows 个像素，生成 16 级量化 FNV 哈希与 RGB 采样数组。
 * 相比 bitmapToImageData 解包整块 5~10 万像素（50~100ms），只采样 144~384 个点仅约 1~2ms。
 */
function d6BitmapSample(bitmap: any, cols: number, rows: number): D6RegionSample | null {
	const width = bitmap.getWidth();
	const height = bitmap.getHeight();
	if (width <= 0 || height <= 0) return null;
	const stepX = Math.max(1, Math.floor(width / cols));
	const stepY = Math.max(1, Math.floor(height / rows));
	const countX = Math.floor((width - 1) / stepX) + 1;
	const countY = Math.floor((height - 1) / stepY) + 1;
	const total = countX * countY;
	const rgb = new Uint8Array(total * 3);
	let h = 2166136261;
	let idx = 0;
	for (let y = 0; y < height; y += stepY) {
		for (let x = 0; x < width; x += stepX) {
			const color = bitmap.getPixel(x, y);
			const r = (color >> 16) & 0xff;
			const g = (color >> 8) & 0xff;
			const b = color & 0xff;
			rgb[idx++] = r;
			rgb[idx++] = g;
			rgb[idx++] = b;
			h = (((h ^ (r >> 4)) * 16777619) >>> 0);
			h = (((h ^ (g >> 4)) * 16777619) >>> 0);
			h = (((h ^ (b >> 4)) * 16777619) >>> 0);
		}
	}
	return { hash: String(h), rgb, count: total };
}

/** 比较两次同尺寸采样的像素差异：avgL1 为单点 RGB 绝对差之和均值，ratio30 为差>=30 的点占比 */
function d6SampleDiff(a: D6RegionSample | null, b: D6RegionSample | null): { avgL1: number; ratio30: number } {
	if (!a || !b || a.count <= 0 || a.count !== b.count) return { avgL1: 0, ratio30: 0 };
	const ra = a.rgb;
	const rb = b.rgb;
	const n = a.count;
	const len = n * 3;
	let sum = 0;
	let big = 0;
	for (let i = 0; i < len; i += 3) {
		const d = Math.abs(ra[i] - rb[i]) + Math.abs(ra[i + 1] - rb[i + 1]) + Math.abs(ra[i + 2] - rb[i + 2]);
		sum += d;
		if (d >= 30) big++;
	}
	return { avgL1: sum / n, ratio30: big / n };
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

/**
 * 本局是否已有实际步数进展。
 * 只认已确认步数/岛屿序号，不认 pending：pending 只表示“点击已发出、等确认”，
 * 用它判断会让开局过渡帧（还没进地图）和真正的新一局混在一起。
 */
function d6RunHasProgress(): boolean {
	if (!stepTracker) return false;
	return stepTracker.consumed > 0 || stepTracker.islandSeq > 0;
}
const MAP_PRIORITY: { [key: string]: number } = {
	神秘: 4,
	宁息: 3,
	鏖战: 2,
	混沌: 1,
	绽放: 0,
};
// 满足通关条件后：优先非战斗/可跳过节点，最后才打鏖战。
// 混沌排鏖战之前：普通混沌是宝匣（实测约 5s，点离开即可），
// 混沌精英约 12s（两次选 buff，通关后不刷新），都不慢于鏖战（约 11.5s）。
const MAP_PRIORITY_CLEARED: { [key: string]: number } = {
	神秘: 6,
	宁息: 5,
	绽放: 4,
	混沌: 3,
	鏖战: 2,
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
// 非战后回图稳定校验等待（神秘/宁息/绽放/秘宝/唤息）：5 轮实测 44/44 零重试，350ms 足够跨帧校验 rowKey。
const D6_MAP_SETTLE_MS = 350;
// 战后「获得奖励」退回地图保护窗口：
// - 前 650ms 为地图淡入期，推迟首读避开淡入帧 unknown；
// - 主地图镜头下拉停稳/输入锁在 oper 结束后约 1.25s 解除（实测 6/6 次被吞点击全落在 1.04~1.20s），
//   保证最终点击落在 >= 1400ms，兼顾零吞点击与非战后加速。
const D6_POST_REWARD_MAP_READ_MIN_MS = 650;
const D6_POST_REWARD_MAP_CLICK_MIN_MS = 1400;
const D6_POST_REWARD_WINDOW_MS = 4000;
// 宁息商店退回主地图后的点击下限保护（从点击退店按钮起算）：
// - 普通商店退场：保底 1850ms，覆盖唤息右侧商店（two-right/three-right）偶发 1.5s 极快退场吞点击；
// - 最右位 four-4（唤息宁息）退场：无论跳向何槽位（three-left/center/right 均有重试记录），统一保底 2150ms 让 3D 镜头回正。
const D6_SHOP_EXIT_WINDOW_MS = 4500;
const D6_SHOP_EXIT_CLICK_MIN_MS = 1850;
const D6_SHOP_EXIT_FOUR4_CLICK_MIN_MS = 2150;
// 小地图连续识别到 unknown 满 10s 才弹提示/写告警，过滤退岛首帧淡入残影；
// 两次观测间隔超过 4s 视为全新一次出现并重新计时（常规轮询间隔 700ms）。
const D6_UNKNOWN_NOTIFY_MS = 10000;
const D6_UNKNOWN_CONT_GAP_MS = 4000;
// 点击岛屿后未观测到离图/岛屿证据时的内部重试等待（不再暴露为界面配置，避免旧方案配置覆盖调优值）。
// 实机有效入岛约 0.6~1.4s，3000ms/3500ms 兼顾防重点击与偶发吞点击快速补点。
const D6_STEP_RETRY_MS = 3000;
const D6_STEP_RETRY_HASH_CHANGED_MS = 3500;
const D6_MAP_CLICK_HALF_W = 6;
// Func323.operator 状态索引，与数组顺序严格一一对应
const OP = {
	START: 0,
	CONFIRM_SHIKIGAMI: 1,
	START_DEPLOY: 2,
	SELECT_DANCE: 3,
	INIT_SKILL: 4,
	HUANXI_DARK: 5,
	HUANXI_BRIGHT: 6,
	HUANXI_CONFIRM: 7,
	MAP_SLOTS: 8,
	REWARD: 9,
	BLOOM_LEAVE: 10,
	MYSTERY_CONVERT: 11,
	MYSTERY_FORGE: 12,
	BLESSING_USE: 13,
	CHAOS_CHEST: 14,
	CHAOS_ELITE: 15,
	BATTLE_CHALLENGE: 16,
	BATTLE_SELECT_MONSTER: 17,
	SHOP_SCREEN: 18,
	SHOP_CONFIRM_BUY: 19,
	SHOP_REFRESH: 20,
	BUFF_REFRESH: 21,
	BUFF_REFRESH_DARK: 22,
	SKILL_UPGRADE: 23,
	SKILL_UPGRADE_PICK: 24,
	BOSS_CHALLENGE: 25,
	BATTLE_FAIL_GIVEUP: 26,
	BATTLE_FAIL_CONFIRM: 27,
	SETTLE_DONE: 28,
} as const;
// 这些 operator 属于开局或地图选择阶段，命中时不能当作“已进入岛屿”的证据；
// 其余 operator 在 stepPending 期间命中都说明已经离开地图、进入岛屿事件/战斗/商店/buff 等界面。
const D6_STEP_MAP_OPERATORS: { [key: number]: boolean } = {
	[OP.START]: true,
	[OP.HUANXI_DARK]: true,
	[OP.HUANXI_BRIGHT]: true,
	[OP.HUANXI_CONFIRM]: true,
};
const D6_HUANXI_COST = 300;
// 唤息点击后，新地图行签名要连续稳定这么久才确认扣款：
// 换图动画/节点淡入淡出的中间帧也会让签名变化，按单帧扣款会把一次唤息扣两次。
const D6_HUANXI_CONFIRM_STABLE_MS = 1200;
// 点击后等待地图变化的最长时间；超时视为点击没生效，不扣款。
const D6_HUANXI_TIMEOUT_MS = 6000;
const D6_SHOP_LEI_PRICE = 200;
// 实机商店截图刷新按钮为「100(剩N次)」，每次 100，不是 50
const D6_SHOP_REFRESH_COST = 100;
const D6_SHOP_REFRESH_MAX = 3;
const D6_BUFF_REFRESH_COST = 50;
// buff 三张卡的图标区（开发坐标 1280x720）：入场/刷新动画期间会整体变化。
// refresh 前后读这个区域的哈希，用于确认旧卡确实换成了新一组。
const D6_BUFF_CARDS_DEV_REGION = { x0: 60, y0: 140, x1: 900, y1: 260 } as const;
// 入场/刷新等待：
// 视频 4fps 实测：
// - 入场切到 buff 界面后约 0.25~0.50s 卡面即完全稳定（相邻帧 L1 < 1），450ms 与并行钱包 OCR 重叠；
// - 刷新点击后 0.25s 新卡已出现、0.75s 完全落位（相对刷新前 L1=41~47、相邻帧 L1<1），
//   不再固定等满 2.7s，改为 700ms 起按 32×12 采样 L1 变化 + 短稳定确认早退，上限 2500ms 兜底慢设备。
const D6_BUFF_ENTER_MIN_MS = 450;
const D6_BUFF_ENTER_SETTLE_MS = 450;
const D6_BUFF_REFRESH_MIN_MS = 700;
// 实机 96/96 次正常刷新早退均在 857~968ms 落位；
// 若新旧三卡配色接近未触发 L1/RATIO 阈值，只要 OCR 已确认本次扣费且满 1050ms + hash 变化 + 相邻帧稳定，即可安全早退。
const D6_BUFF_REFRESH_OCR_SETTLE_MS = 1050;
const D6_BUFF_REFRESH_MAX_MS = 2500;
const D6_BUFF_REFRESH_POLL_MS = 120;
const D6_BUFF_REFRESH_CONFIRM_MS = 150;
// 采样差异阈值（基于 4fps 实测：同组卡闪光 L1=0~9/占比<=4%，真实换卡 L1=40~67/占比20~35%，换卡后静止 L1<1）
const D6_BUFF_SWAP_L1 = 15;
const D6_BUFF_SWAP_RATIO = 0.12;
const D6_BUFF_STABLE_L1 = 10;
const D6_BUFF_STABLE_RATIO = 0.08;
// 超过这个间隔再次命中 buff 界面，视为新界面
const D6_BUFF_SCREEN_GAP_MS = 8000;
// 选卡后的点击锁：覆盖选卡/换卡动画，防止同一屏被重复点击。
// 普通界面选完会消失，锁会由“选择界面消失”立即解除；
// 混沌精英换第二组卡时界面一直存在，视频实测 0.5s 出新卡、0.85~1.0s 提示淡出完毕：
// 满 MIN_MS(700ms) 后若采样确认卡面已换新且相邻帧稳定，立即提前解锁；否则保留 1800ms 超时兜底。
const D6_BUFF_SELECT_LOCK_MIN_MS = 700;
const D6_BUFF_SELECT_LOCK_MS = 1800;
// 舞技强化选择界面的点击锁仍用 2000ms（它的点击在 oper 内部，锁起点无法提前）
const D6_SKILL_SELECT_LOCK_MS = 2000;
// 选卡后多久内再次命中 buff 界面，仍视为同一个界面的第二组卡（混沌精英）。
// 选卡锁 1.8s + 轮询间隔留余量；普通战斗的下一组 buff 界面间隔远大于 8s。
const D6_BUFF_CONTINUATION_MS = 6000;
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
// buff 黑名单：永不选择（所有名称均需在 multiFindColors.ts 配置 六道觉_buff_<名称>）
const D6_BUFF_BLACKLIST = ['六道·混沌', '六道·偶戏', '妖力化身', '攻击加成', '背水一战'];
// buff 名称 -> multiFindColors 的 key（去掉 Rhino 不认的间隔号 ·）
const buffColorKey = (name: string) => `六道觉_buff_${name.replace(/\u00b7/g, '')}`;
// 炽焚天火需在拿到轰雷后才能选
const CAUTION_BUFF_CHIFEN = '炽焚天火';
// 已取色的已知 buff（含黑名单）
const D6_KNOWN_BUFF_NAMES = [...D6_BUFF_BLACKLIST, CAUTION_BUFF_CHIFEN, '六道化身', '洞察之力', '极道轰炸'];
let buffPatternWarned = false;

/**
 * 六道之门·觉完整挂机
 *
 * 右上角小地图识别逻辑在 src/common/d6jueMap.ts：
 * - 按金色像素密度找出岛屿图标并分类（鏖战/混沌/神秘/宁息/绽放），
 *   取当前可进入的一排亮色节点，按从左到右对应主地图固定选择位（OP.MAP_SLOTS）。
 * - 步数推进由 src/common/d6jueStepTracker.ts 结合地图切换、岛屿证据与回合数字校验。
 *
 * 建议方案顺序：
 * [690, 509, 510, 0, 1, 323, 2, 3, 24, 29, 503]
 * 注意：本功能应排在[2退出结算]前。
 */
// 主地图固定选择位（1280x720 开发坐标），下标与 d6jueMap.ts 的 D6_MAP_SLOTS 一致。
// 运行时用于两件事：OP.MAP_SLOTS 的固定点击区；横幅锚点检测时反推截图缩放比例。
// 混沌秘宝/绽放离开按钮均含渐变背景点，固定用 88 的相似度检查（容差 31）：
// - 绽放点 (1073,693) 在绽放实机帧上通道差约 1~15（<=31），而在混沌秘宝截图中差 53（>31），
//   因此 OP.BLOOM_LEAVE 用 88 先判不会误伤 OP.CHAOS_CHEST，又能彻底杜绝全局高 colorSimilar 漏判绽放后落入秘宝误抢。
const D6_CHEST_SIMILAR = 88;
const D6_BLOOM_SIMILAR = 88;
// 绽放(OP.BLOOM_LEAVE)/混沌秘宝(OP.CHAOS_CHEST) 点击右下角「离开」后的防连点冷却（接在 afterSleep=1000ms 之后，总计 2000ms），
// 既让回图后可立即读小地图，又彻底防止退场过渡期二次点击误触主地图同位置的「唤息」。
const D6_RIGHT_LEAVE_COOLDOWN_MS = 1000;
// 单次 buff 界面最多允许刷新次数兜底，防止任何异常下无限刷新。
const D6_BUFF_REFRESH_MAX_PER_SCREEN = 8;

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
	// two-right：264 张实机截图的横幅锚点 x 中位数 925、y 中位数 467（90% 落在 y 440~504），
	// 原分布中心 (910,450) 偏左上，18 次首次点击失败全部集中在这里；收窄到横幅实际范围。
	{ cx: 923, cy: 468, sx: 6, sy: 14, xMin: 908, xMax: 938, yMin: 426, yMax: 505 }, // two-right
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
	desc = '六道之门·觉完整挂机；应排在[2退出结算]前';
	config = [{
		desc: '配置',
		config: [{
			name: 'pushResult',
			desc: '结束时使用ospPush推送结果',
			type: 'switch',
			default: false,
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
		}],
	}];
	// 数组索引与顶部 OP 常量严格一一对应
	operator: IFuncOperatorOrigin[] = [{ // 0 START: 开启-六道觉（开新局，重置本局统计）
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
			[right, 1280, 720, 1120, 600, 1210, 680, 800], // 开启-六道觉
		],
	}, { // 1 CONFIRM_SHIKIGAMI: 确认-选择试炼式神
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
			[right, 1280, 720, 1130, 590, 1210, 660, 700], // 确认-选择试炼式神
		],
	}, { // 2 START_DEPLOY: 开启-上阵式神
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
			[right, 1280, 720, 1140, 590, 1220, 660, 600], // 开启-上阵式神
		],
	}, { // 3 SELECT_DANCE: 选择舞技
		desc: [1280, 720,
			[
				[right, 1044, 378, 0x762a05],
				[right, 1051, 559, 0x246aa0],
				[right, 1011, 619, 0x173d6b],
				[right, 1123, 619, 0x85b3b7],
			]
		],
		oper: [
			[right, 1280, 720, 1000, 610, 1090, 635, 400], // 选择舞技
		],
	}, { // 4 INIT_SKILL: 初始技能界面（固定选最右侧技能）
		desc: [1280, 720,
			[
				[left, 312, 186, 0xe0b8c1],
				[right, 645, 199, 0x317bde],
				[right, 960, 198, 0xba382d],
				[left, 184, 672, 0x204157],
			]
		],
		oper: [
			[center, 1280, 720, 900, 555, 1010, 590, 500], // 技能3（固定选）
		],
	}, { // 5 HUANXI_DARK: 唤息_暗（事件界面右下角，仅识别）
		desc: [1280, 720,
			[
				[right, 1188, 619, 0x484848],
				[right, 1156, 601, 0x555555],
				[right, 1134, 606, 0x5d5d5d],
				[right, 1149, 591, 0x484848],
			]
		],
		notForCnt: true,
	}, { // 6 HUANXI_BRIGHT: 唤息_亮/金（事件界面右下角，仅识别）
		desc: [1280, 720,
			[
				[right, 1188, 619, 0x58452e],
				[right, 1156, 601, 0x69522e],
				[right, 1134, 606, 0x735b31],
				[right, 1149, 591, 0x59452d],
			]
		],
		notForCnt: true,
	}, { // 7 HUANXI_CONFIRM: 唤息_确认框（仅在 d6HuanxiPending 期间主动确认，减少依赖外部 func 2 并压缩等待）
		desc: '退出结算_取消确认框',
		oper: [
			[center, 1280, 720, 680, 411, 838, 452, 200],
		],
		notForCnt: true,
	}, { // 8 MAP_SLOTS: 主地图固定选择位（只按小地图推断的数量/顺序点击，不做状态判定）
		// 下标与 d6jueMap.ts 的 D6_MAP_SLOTS 严格一致：
		// 0=单个(中)；1=两个(左)；2=两个(右)；3=三个(左)；4=三个(中)；5=三个(右)；6~9=四个(从左到右)。
		// 实测：点岛屿平台/水面无效，必须点岛屿上方的竖排横幅/名称。以下区域都对准横幅。
		oper: [
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[0], 500], // single
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[1], 500], // two-left
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[2], 500], // two-right
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[3], 500], // three-left
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[4], 500], // three-center
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[5], 500], // three-right
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[6], 500], // four-1
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[7], 500], // four-2
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[8], 500], // four-3
			[center, 1280, 720, ...D6_MAP_SLOT_DEV_RECTS[9], 500], // four-4
		],
	}, { // 9 REWARD: 获得奖励界面
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
	}, { // 10 BLOOM_LEAVE: 绽放_离开（绽放之屿右下角直接离开）
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
			[center, 1280, 720, 1160, 635, 1205, 680, 1000], // 绽放-离开
		],
	}, { // 11 MYSTERY_CONVERT: 神秘_转换（神秘之屿-技能转换）
		desc: [1280, 720,
			[
				[left, 122, 36, 0xf8f3e0],
				[left, 139, 35, 0xf8f3e0],
				[left, 122, 45, 0xf8f3e0],
				[left, 182, 671, 0x234862],
			]
		],
		oper: [
			[center, 1280, 720, 10, 20, 50, 65, 350], // 关闭/返回
		],
	}, { // 12 MYSTERY_FORGE: 神秘_仿造
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
			[center, 1280, 720, 10, 20, 50, 65, 350], // 关闭/返回
		],
	}, { // 13 BLESSING_USE: 万象赐福使用
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
	}, { // 14 CHAOS_CHEST: 混沌_幸运秘宝
		desc: [1280, 720,
			[
				[left, 128, 52, 0xf8f3e0],
				[left, 159, 51, 0xf8f3e0],
				[left, 184, 49, 0xf8f3e0],
				[left, 203, 43, 0xf8f3e0],
				// 只用右下角「离开」按钮做秘宝专属点。宝匣/横幅会随开箱动画变化，
				// 离开按钮是静态的，且精英界面没有这个按钮（精英对应点为蓝色背景，diff 100+）。
				// 离开按钮上取 3 个点：外圈暗部、内圈金边、白色出口箭头。
				[right, 1168, 633, 0x090704],
				[right, 1185, 675, 0xdbbf92],
				[right, 1200, 658, 0xead5b4],
			]
		],
		oper: [
			[center, 1280, 720, 1160, 635, 1200, 685, 1000], // 混沌-幸运秘宝
		],
	}, { // 15 CHAOS_ELITE: 混沌_精英
		// 只用左上角「混沌之屿」标题的 5 个取色点，不再绑定精英立绘/名字条。
		// 混沌秘宝由 OP.CHAOS_CHEST 先判断；判断不到时才按精英处理。
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
	}, { // 16 BATTLE_CHALLENGE: 战斗_挑战
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
			[center, 1280, 720, 1125, 590, 1205, 665, 1000], // 挑战
		],
	}, { // 17 BATTLE_SELECT_MONSTER: 鏖战_选择怪物（进入鏖战之屿后的敌人选择界面）
		// 本状态对应进入鏖战后左右两个敌人的选择界面，点击右侧敌人 730,250-880,420。
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
	}, { // 18 SHOP_SCREEN: 商店界面（仅识别）
		desc: [1280, 720,
			[
				[right, 1227, 154, 0xc6dfd4],
				[right, 1227, 637, 0xe9d3b1],
				[right, 1227, 286, 0x2e4550],
				[left, 111, 45, 0x57616e],
				[right, 1228, 335, 0x3c5265],
			]
		],
	}, { // 19 SHOP_CONFIRM_BUY: 商店_确认购买（米色弹窗背景 + 红色取消 + 金色确定）
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
	}, { // 20 SHOP_REFRESH: 商店_刷新（仅识别）
		desc: [1280, 720,
			[
				[center, 611, 632, 0xfff9df],
				[center, 622, 608, 0x79b6d3],
				[center, 620, 623, 0x273e62],
				[center, 611, 614, 0x24395a],
			]
		],
		notForCnt: true,
	}, { // 21 BUFF_REFRESH: 舞技强化_刷新（仅识别）
		desc: [1280, 720,
			[
				[right, 1216, 634, 0xa6fdff],
				[right, 1240, 647, 0x2b4569],
				[right, 1184, 647, 0x294366],
				[right, 1205, 657, 0xecfafe],
			]
		],
		notForCnt: true,
	}, { // 22 BUFF_REFRESH_DARK: 舞技强化_刷新_暗（刷新次数用完，仅识别）
		desc: [1280, 720,
			[
				[right, 1205, 658, 0xf7f7f7],
				[right, 1217, 634, 0xe3e3e3],
				[right, 1184, 648, 0x3f3f40],
				[right, 1240, 647, 0x414141],
			]
		],
		notForCnt: true,
	}, { // 23 SKILL_UPGRADE: 舞技强化
		desc: [1280, 720,
			[
				[right, 1093, 184, 0xfbf9e4],
				[right, 1093, 176, 0xfaf8e7],
				[right, 1103, 203, 0xf7f1cb],
				[right, 1088, 483, 0x313a45],
			]
		],
		oper: [
			[center, 1280, 720, 1030, 555, 1150, 590, 350], // 舞技强化
		],
	}, { // 24 SKILL_UPGRADE_PICK: 舞技强化-选择强化
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
			[center, 1280, 720, 245, 505, 335, 535, 350], // 选择强化
		],
	}, { // 25 BOSS_CHALLENGE: 首领挑战
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
	}, { // 26 BATTLE_FAIL_GIVEUP: 战斗失败_放弃前行
		desc: [1280, 720,
			[
				[center, 460, 450, 0xdf684f],
				[center, 580, 450, 0xdf6850],
				[center, 700, 450, 0xc99954],
				[center, 820, 450, 0xe9b05e],
				[center, 600, 350, 0xd9c5ae],
				[center, 405, 490, 0xbba791],
				[center, 600, 490, 0xbaa690],
			]
		],
		oper: [
			[center, 1280, 720, 670, 412, 845, 468, 1000],
		],
	}, { // 27 BATTLE_FAIL_CONFIRM: 战斗失败_确定放弃
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
	}, { // 28 SETTLE_DONE: 结算_完成（统计、推送、切换方案）
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
			[center, 1280, 720, 394, 617, 903, 699, 500], // 结算-继续
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
		const debugMode = isD6DebugMode();
		const mapSettleMs = D6_MAP_SETTLE_MS;
		const mapRetryMs = D6_MAP_SIG_WAIT;
		// 点击后多久没有离图/岛屿证据才允许重试（固定使用内部调优常量）。
		const stepRetryMs = D6_STEP_RETRY_MS;
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
		const perfLog = (name: string, ms: number, detail = '', alwaysFile = false) => {
			if (!debugMode) return;
			const line = `[d6jue-perf] ${name} ${ms}ms${detail ? ' ' + detail : ''}`;
			if (ms >= 120) console.log(line);
			if (alwaysFile || ms >= 120) perfLogLine(line);
		};
		if (!mapSwitchLogged) {
			const orderText = (priority: { [key: string]: number }) => Object.keys(priority)
				.sort((a, b) => priority[b] - priority[a])
				.join(' > ');
			console.log('[d6jue-map] 识别方式=图标模板+行列结构推断，主地图按可达节点顺序点固定选择位');
			console.log(`[d6jue-map] 岛屿顺序(未通关): ${orderText(MAP_PRIORITY)}`);
			console.log(`[d6jue-map] 岛屿顺序(通关后): ${orderText(MAP_PRIORITY_CLEARED)}`);
			mapSwitchLogged = true;
		}

		// 过滤没有 desc 的 operator（如仅含点击坐标的 OP.MAP_SLOTS）
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
				// 半透明小地图背景飘云会导致吞点击后 mapHash 仍变化；实机有效进岛 0.6~1.4s 即离图，
				// 3500ms 足以避开入岛过渡，同时将偶发吞点击的补点惩罚从 8s 降到 3.5s。
				retryHashChangedMs: Math.max(stepRetryMs, D6_STEP_RETRY_HASH_CHANGED_MS),
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
			if (debugMode && dt >= 120) perfLog(`oper ${name}`, dt, `matched=${matched} retest=${retest}`);
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

		// 读取当前缓存帧的 buff 卡面采样（32×12 直接 getPixel，约 1~2ms；轮询前需先 keepScreen）
		const readBuffCardsSample = (): D6RegionSample | null => {
			try {
				const helper = thisScript.helperBridge.helper;
				const region = D6_BUFF_CARDS_DEV_REGION;
				const sr = helper.GetPoint(region.x0, region.y0, left);
				const er = helper.GetPoint(region.x1, region.y1, left);
				if (sr.x >= er.x || sr.y >= er.y) return null;
				const bitmap = helper.GetBitmap(sr.x, sr.y, er.x, er.y);
				if (!bitmap) return null;
				try {
					return d6BitmapSample(bitmap, 32, 12);
				} finally {
					try {
						bitmap.recycle();
					} catch (e) {
						// 忽略回收异常
					}
				}
			} catch (e) {
				return null;
			}
		};
		const isBuffCardsSwapped = (before: D6RegionSample | null, cur: D6RegionSample | null): { swapped: boolean; avgL1: number; ratio30: number } => {
			const diff = d6SampleDiff(before, cur);
			return {
				swapped: diff.avgL1 >= D6_BUFF_SWAP_L1 || diff.ratio30 >= D6_BUFF_SWAP_RATIO,
				avgL1: diff.avgL1,
				ratio30: diff.ratio30,
			};
		};
		const isBuffCardsSettled = (prev: D6RegionSample | null, cur: D6RegionSample | null): boolean => {
			if (!prev || !cur) return false;
			const diff = d6SampleDiff(prev, cur);
			return diff.avgL1 < D6_BUFF_STABLE_L1 && diff.ratio30 < D6_BUFF_STABLE_RATIO;
		};

		// 选择 buff/舞技后锁住，直到选择界面消失或混沌精英确认换出稳定的新一组卡。
		// 普通界面靠“界面消失”立即解锁；混沌精英第二轮界面不会消失，
		// 满 D6_BUFF_SELECT_LOCK_MIN_MS 后若采样确认卡面已换新且相邻帧稳定，提前解锁，
		// 避免每次都等满 1.8s 超时；未检测到换卡时保留 1.8s 超时兜底，防重复点击旧卡。
		const buffSelectLocked = () => buffSelectLockActive && now() < buffSelectLockUntil;
		const clearBuffSelectLock = () => {
			buffSelectLockActive = false;
			buffSelectLockStart = 0;
			buffSelectLockUntil = 0;
			buffSelectLockMs = 0;
			buffSelectLockSample = null;
		};
		const lockBuffSelect = (ms = D6_BUFF_SELECT_LOCK_MS, sample: D6RegionSample | null = null) => {
			const t = now();
			buffSelectLockActive = true;
			buffSelectLockStart = t;
			buffSelectLockMs = ms;
			buffSelectLockUntil = t + ms;
			buffSelectLockSample = sample;
		};

		// 选择锁：buff/舞技界面已经切走就解除；混沌精英确认换卡稳定可提前解除；超时兜底，避免卡死
		if (buffSelectLockActive) {
			const selectOps = [OP.BUFF_REFRESH, OP.SKILL_UPGRADE_PICK, OP.BUFF_REFRESH_DARK].map(index => thisOperator[index]).filter(isReady);
			const buffCardOps = [OP.BUFF_REFRESH, OP.BUFF_REFRESH_DARK].map(index => thisOperator[index]).filter(isReady);
			const skillModalOps = [OP.SKILL_UPGRADE_PICK].map(index => thisOperator[index]).filter(isReady);
			const checkStillSelecting = () => selectOps.length > 0 && thisScript.desc({
				id: 323,
				name: '六道觉_选择界面锁检测',
				operator: selectOps,
			}, thisScript.scheme.commonConfig);
			const checkBuffCardsVisible = () => buffCardOps.length > 0 && thisScript.desc({
				id: 323,
				name: '六道觉_卡面界面锁检测',
				operator: buffCardOps,
			}, thisScript.scheme.commonConfig);
			const checkSkillModalVisible = () => skillModalOps.length > 0 && thisScript.desc({
				id: 323,
				name: '六道觉_舞技弹窗锁检测',
				operator: skillModalOps,
			}, thisScript.scheme.commonConfig);
			const stillSelecting = checkStillSelecting();
			if (!stillSelecting || now() >= buffSelectLockUntil) {
				// 锁到期时选择界面还在：记录一次便于确认是否由选择锁超时解除。
				if (stillSelecting) {
					d6jueAnalysisLog('buff.lock_timeout', { ms: buffSelectLockMs || D6_BUFF_SELECT_LOCK_MS });
				}
				clearBuffSelectLock();
			} else if (
				buffSelectLockSample
					&& now() - buffSelectLockStart >= D6_BUFF_SELECT_LOCK_MIN_MS
					&& checkBuffCardsVisible()
					&& !checkSkillModalVisible()
			) {
				const curSample = readBuffCardsSample();
				const swap = isBuffCardsSwapped(buffSelectLockSample, curSample);
				if (swap.swapped) {
					// 确认到新一组卡出现后，隔 150ms 再验一帧稳定，避开获得技能横幅淡出期
					sleep(D6_BUFF_REFRESH_CONFIRM_MS);
					thisScript.keepScreen();
					if (!checkStillSelecting()) {
						clearBuffSelectLock();
					} else if (checkBuffCardsVisible() && !checkSkillModalVisible()) {
						const nextSample = readBuffCardsSample();
						const swap2 = isBuffCardsSwapped(buffSelectLockSample, nextSample);
						if (swap2.swapped && isBuffCardsSettled(curSample, nextSample)) {
							const elapsed = now() - buffSelectLockStart;
							d6jueAnalysisLog('buff.lock_early_unlock', {
								elapsed,
								avgL1: Number(swap2.avgL1.toFixed(1)),
								ratio: Number(swap2.ratio30.toFixed(2)),
							});
							clearBuffSelectLock();
						}
					}
				}
			}
		}
		// 选择动画期间不再执行任何点击（包括舞技强化的选择按钮），等界面切走或换卡完成
		if (buffSelectLocked()) return true;

		// 万相铃计算：进岛 +50 每岛一次；选buff +100 每岛一次（混沌精英第 2/2 轮回退第 1 轮预加后再结算）。
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
			d6IslandBuffGainDone = false;
			d6PreSkillBuffSample = null;
			d6UnknownFirstTime = 0;
			d6UnknownLastTime = 0;
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
		// 每座岛选 buff/舞技 +100 只计一次；混沌精英进入第 2/2 轮时先回退第 1 轮预加，待第 2 轮结算。
		const addBuffGainOnce = (source: string) => {
			ensureIsland();
			if (d6IslandBuffGainDone) return;
			d6IslandBuffGainDone = true;
			addWanxiangling(D6_ISLAND_BUFF_GAIN, source);
		};
		// 刷新费用不盲目扣：先挂起，等下一次 OCR 读数校验。
		const beginPendingRefreshCost = (cost: number, source: string, walletBefore: number) => {
			d6PendingRefreshCost = cost;
			d6PendingRefreshSource = source;
			d6PendingRefreshWalletBefore = walletBefore;
			d6PendingRefreshTime = now();
		};
		// OCR 用于校验/校准每岛固定收益计算：读到值后和计算值比较，差值合理才同步。
		// 返回 true 表示本次 OCR 已校验通过一笔挂起的刷新扣费（costVerified=1）。
		const readWanxianglingOcr = (tag: string): boolean => {
			// 等待卡面动画期间已经并行跑过 buff OCR，调用方紧接着的那次直接跳过。
			// 只跳过一次：消费后立刻清零，避免影响下一次刷新的费用校验。
			// 若当前有待校验的刷新扣费（d6PendingRefreshCost > 0），不跳过也不受 1200ms 节流限制，
			// 避免快速 enter/refresh 间隔缩短后漏掉首轮刷新费用校验。
			if (d6PendingRefreshCost <= 0 && tag === 'buff' && now() < d6BuffWalletOcrSkipUntil) {
				d6BuffWalletOcrSkipUntil = 0;
				return false;
			}
			const t = now();
			if (d6PendingRefreshCost <= 0 && t - lastWalletOcrTime < 1200) return false;
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
					if (pendingSource === 'buff_refresh') {
						if (costVerified) {
							d6BuffRefreshFailCount = 0;
						} else if (costDrop <= 0) {
							// 刷新按钮在余额不足但仍有剩余次数时保持亮蓝色，点击只弹“万相铃不足”不会扣费；
							// 观测到未扣费立即熔断本屏刷新，防止死循环点击。
							d6BuffRefreshFailCount++;
							console.log(`[d6jue-buff] 刷新未扣费(drop=${costDrop}, ocr=${value})，熔断本屏继续刷新`);
						}
					}
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
				return costVerified === 1;
			} catch (e) {
				console.log(`[d6jue-wallet] OCR(${tag}) 异常: ${e}`);
				return false;
			}
		};
		// 离开当前 buff 界面/换下一组卡时重置入场与刷新计数
		const resetBuffScreenState = () => {
			d6BuffScreenSettled = false;
			d6BuffRefreshCount = 0;
			d6BuffRefreshFailCount = 0;
			d6BuffLastRefreshTime = 0;
			d6BuffScreenLastSeen = 0;
			d6BuffWalletOcrSkipUntil = 0;
		};

		/**
			 * 等 buff 卡面动画结束。
			 *
			 * - enter：固定等 D6_BUFF_ENTER_SETTLE_MS（450ms，视频 4fps 实测 0.25~0.50s 已清晰落位），
			 *   期间并行跑钱包 OCR（约 350ms），不额外多读 hash；
			 * - refresh：点击后先执行 duringWait（350ms + 钱包 OCR 约 700ms），
			 *   随后轮询 32×12 卡面采样 L1 差异（相对点击前 >=15 或差异点 >=12%）且相邻 150ms 稳定（L1<10）即早退，
			 *   常规约 0.85~0.95s（旧固定 2.8s），慢设备兜底到 D6_BUFF_REFRESH_MAX_MS（2.5s）。
			 */
		const waitBuffCardsStable = (
			reason: string,
			minMs: number,
			prevSample: D6RegionSample | null = null,
			duringWait?: () => boolean | void,
		): boolean => {
			const t0 = now();
			let costVerified = false;
			if (duringWait) {
				try {
					costVerified = !!duringWait();
				} catch (e) {
					// 并行任务失败不影响卡面等待
				}
			}
			let hash = '';
			let changed = false;
			let ocrEarly = false;
			let timeout = false;
			if (reason !== 'refresh' || !prevSample) {
				const settleMs = reason === 'refresh'
					? Math.max(minMs, D6_BUFF_REFRESH_MAX_MS)
					: Math.max(minMs, D6_BUFF_ENTER_SETTLE_MS);
				const remain = settleMs - (now() - t0);
				if (remain > 0) sleep(remain);
			} else {
				const remainMin = Math.max(minMs, D6_BUFF_REFRESH_MIN_MS) - (now() - t0);
				if (remainMin > 0) sleep(remainMin);
				let lastPoll: D6RegionSample | null = null;
				while (now() - t0 < D6_BUFF_REFRESH_MAX_MS) {
					thisScript.keepScreen();
					const cur = readBuffCardsSample();
					if (cur) hash = cur.hash;
					const swap = isBuffCardsSwapped(prevSample, cur);
					if (swap.swapped) {
						changed = true;
						if (lastPoll && isBuffCardsSettled(lastPoll, cur)) {
							break;
						}
						// 首次看到换卡：短等 150ms 复核相邻帧稳定，避免在淡入过渡帧读错卡
						const confirmWait = Math.min(D6_BUFF_REFRESH_CONFIRM_MS, Math.max(0, D6_BUFF_REFRESH_MAX_MS - (now() - t0)));
						if (confirmWait <= 0) break;
						sleep(confirmWait);
						thisScript.keepScreen();
						const next = readBuffCardsSample();
						if (next) hash = next.hash;
						if (isBuffCardsSettled(cur, next)) {
							break;
						}
						lastPoll = next;
						continue;
					}
					// 新旧三张卡配色较接近时，avgL1/ratio30 可能未达换卡阈值；
					// 若 OCR 已确认本次刷新真实扣费且已过正常换卡动画时长，结合 hash 变化 + 相邻帧稳定提前早退，
					// 避免白等满 2500ms 并防止误触发 d6BuffRefreshFailCount++ 熔断本屏剩余刷新。
					if (
						costVerified
							&& now() - t0 >= D6_BUFF_REFRESH_OCR_SETTLE_MS
							&& cur
							&& cur.hash !== prevSample.hash
							&& lastPoll
							&& isBuffCardsSettled(lastPoll, cur)
					) {
						changed = true;
						ocrEarly = true;
						break;
					}
					lastPoll = cur;
					const leftMs = D6_BUFF_REFRESH_MAX_MS - (now() - t0);
					if (leftMs <= 0) break;
					sleep(Math.min(D6_BUFF_REFRESH_POLL_MS, leftMs));
				}
				if (!changed) {
					timeout = true;
					// 刷新后卡面 2.5s 仍无变化且未确认扣费（如余额不足/按钮无效），熔断本屏继续刷新；
					// 若 OCR 已确认本次扣费，不误熔断剩余刷新次数。
					if (!costVerified) {
						d6BuffRefreshFailCount++;
					}
				}
			}
			const waited = now() - t0;
			perfLog('buff.wait', waited, `reason=${reason} changed=${changed ? 1 : 0} ocrEarly=${ocrEarly ? 1 : 0} timeout=${timeout ? 1 : 0} refresh=${d6BuffRefreshCount}`, true);
			d6jueAnalysisLog('buff.wait', {
				reason,
				waited,
				changed: changed ? 1 : 0,
				ocrEarly: ocrEarly ? 1 : 0,
				timeout: timeout ? 1 : 0,
				hash,
				refresh: d6BuffRefreshCount,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
			});
			console.log(`[d6jue-buff] 卡面等待(${reason}) ${waited}ms changed=${changed ? 'T' : 'F'}${ocrEarly ? '(ocr)' : ''} timeout=${timeout ? 'T' : 'F'} hash=${hash || (prevSample ? '?' : '-')}`);
			return true;
		};
		// 舞技强化/buff 界面右下角刷新：OCR 可用时等下一次读数校验费用
		const refreshBuffSelection = () => {
			const before = g.d6jueWanxiangling || 0;
			// 点击前采样卡面：刷新后按 L1 差异确认换卡 + 稳定早退
			const prevSample = readBuffCardsSample();
			const prevHash = prevSample ? prevSample.hash : '';
			d6BuffRefreshCount++;
			d6BuffLastRefreshTime = now();
			// 费用挂起和日志都放在点击前：日志时间≈真实点击时间，便于和视频对齐
			beginPendingRefreshCost(D6_BUFF_REFRESH_COST, 'buff_refresh', before);
			console.log(`[d6jue-lei] 刷新buff -${D6_BUFF_REFRESH_COST}，当前计算余额=${g.d6jueWanxiangling}（等OCR校验）`);
			d6jueAnalysisLog('buff.refresh', {
				cost: D6_BUFF_REFRESH_COST,
				walletBefore: before,
				wallet: g.d6jueWanxiangling || 0,
				costPending: 1,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				step: g.d6jueStepLeft || 0,
				refresh: d6BuffRefreshCount,
				prevHash,
			});
			thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
				[right, 1280, 720, 1180, 625, 1235, 675, 0],
			]));
			// 点击后钱包很快扣费，OCR 放在换卡等待期间并行跑；调用方紧接着的
			// readWanxianglingOcr('buff') 用 skipUntil 跳过，避免重复读。
			waitBuffCardsStable('refresh', D6_BUFF_REFRESH_MIN_MS, prevSample, () => {
				// 点击后游戏钱包约 0.3s 才刷新；先等一小段再 OCR，避免读到扣费前的值。
				sleep(350);
				const verified = readWanxianglingOcr('buff');
				d6BuffWalletOcrSkipUntil = now() + 3000;
				return verified;
			});
			// 换卡稳定后保持 settled=true，下一轮不再重复 enter 等待。
			d6BuffScreenSettled = true;
			d6BuffScreenLastSeen = now();
		};

		// 只提示一次缺失的图标配置
		if (!buffPatternWarned) {
			const missing = D6_KNOWN_BUFF_NAMES.filter(name => {
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
		const buffCardSplit1 = thisScript.helperBridge.helper.GetPoint(350, 0, left).x;
		const buffCardSplit2 = thisScript.helperBridge.helper.GetPoint(620, 0, left).x;
		const cardIndexByX = (x: number): number => x < buffCardSplit1 ? 0 : x < buffCardSplit2 ? 1 : 2;

		const isBuffSelectable = (name: string): boolean => {
			if (D6_BUFF_BLACKLIST.includes(name)) return false;
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
			for (let i = 0; i < D6_KNOWN_BUFF_NAMES.length; i++) {
				const name = D6_KNOWN_BUFF_NAMES[i];
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
			if (debugMode && dt >= 100) {
				perfLog('buff.scan', dt, `findMultiColor=${scans} cards=${cards.map(c => c.name || '?').join(',')}`, true);
			}
			d6jueAnalysisLog('buff.scan', {
				cards: cards.map(c => c.name || '?').join('/'),
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
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
			// 锁从真实点击时刻开始计，不能等 regionClick 内部的 500ms 点击后 sleep 结束；
			// 附带点击前卡面采样，便于混沌精英换出第二组卡后提前解锁。
			const pickSample = readBuffCardsSample();
			d6PreSkillBuffSample = null;
			d6BuffLastPickTime = now();
			lockBuffSelect(D6_BUFF_SELECT_LOCK_MS, pickSample);
			thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
				[left, 1280, 720, button[0], button[1], button[2], button[3], 500],
			]));
			// 选卡后界面会关闭或换下一组卡（混沌精英第二轮），下次命中按新界面重新等入场
			resetBuffScreenState();
			// 每座岛选 buff +100 只计一次；混沌精英第 2/2 轮会在 buff.continuation 先回退第 1 轮预加
			addBuffGainOnce(`选buff:${name || '未知'}`);
			if (name === '六道轰雷') {
				g.d6jueLeiLevel = (g.d6jueLeiLevel || 0) + 1;
			}
			console.log(`[d6jue-buff] 选择buff: ${name || '未知'}，位置=${index + 1}`);
			d6jueAnalysisLog('buff.pick', {
				name: name || 'unknown',
				pos: index + 1,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
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
			// 锁从真实点击时刻开始计，不能等 regionClick 内部的 500ms 点击后 sleep 结束；
			// 附带点击前卡面采样，便于混沌精英换出第二组卡后提前解锁。
			const pickSample = readBuffCardsSample();
			d6PreSkillBuffSample = null;
			d6BuffLastPickTime = now();
			lockBuffSelect(D6_BUFF_SELECT_LOCK_MS, pickSample);
			thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
				[left, 1280, 720, button[0], button[1], button[2], button[3], 500],
			]));
			resetBuffScreenState();
			addBuffGainOnce(`死局选buff:${name || '未知'}`);
			g.d6jueCantClear = true;
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

		// 右上角小地图结构识别 + 自动选择点击
		// 每次均基于当前新帧的 12×12 快速像素采样（约 1~2ms）命中哈希缓存，
		// 不再使用会绕过新帧校验的纯时间 TTL 缓存；像素变化时才解包并运行 analyzeD6Map。
		const readMapState = () => {
			const t0 = now();
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
					const sample = d6BitmapSample(bitmap, 12, 12);
					const hash = sample ? sample.hash : '';
					const tHash = now();
					if (hash && mapStateCache && mapStateCache.hash === hash) {
						lastMapHash = hash;
						perfLog('map.cache', tHash - t0, `first=${readIndex === 0 ? 1 : 0} bitmap=${t1 - t0} hash=${tHash - t1} nodes=${mapStateCache.state ? mapStateCache.state.nodes.length : 0}`, true);
						return mapStateCache.state;
					}
					const image = bitmapToImageData(bitmap);
					const t2 = now();
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
							if (debugMode) {
								try {
									const shot = images.captureScreen();
									const dir = context.getExternalFilesDir(null);
									if (dir) {
										const shotPath = `${dir.getAbsolutePath()}/d6jue_conflict_${now()}.png`;
										images.save(shot, shotPath);
										d6jueAnalysisLog('map.type_conflict_shot', { path: shotPath });
									}
									// 截图是整屏 bitmap，保存后必须回收，避免反复冲突时堆内存
									try {
										shot.recycle();
									} catch (e) {
										// 忽略回收异常
									}
								} catch (e) {
									// 截图失败不影响主流程
								}
							}
						}
					}
					mapStateCache = { hash, state };
					lastMapHash = hash;
					const t3 = now();
					perfLog('map.read', t3 - t0, `first=${readIndex === 0 ? 1 : 0} bitmap=${t1 - t0} pixels=${t2 - tHash} analyze=${t3 - t2} nodes=${state ? state.nodes.length : 0}`, true);
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
					pendingTimeoutLogged: false,
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
				if (state.result) {
					// pending 重读预算到期，但最后一次读取是成功的：这是“读到了但没变化”，
					// 不是识别失败。单独记事件，避免污染 map.counter_miss 统计。
					if (pending && !state.pendingTimeoutLogged) {
						state.pendingTimeoutLogged = true;
						d6jueAnalysisLog('map.counter_pending_timeout', {
							prev: g.d6jueStepLeft || 0,
							row: state.rowKey,
							attempts: state.attempts,
							value: state.result.value,
							digits: state.result.digits,
							conf: Number(state.result.confidence.toFixed(2)),
						});
					}
				} else if (!state.missLogged) {
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
				|| update.reason === 'higher_wait'
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

		// 唤息专用签名：量化坐标，避免 NCC ±1~2px 抖动让同一行看起来一直在变；
		// 保留亮/暗，换图时节点行内容和亮暗都会变。不含定位针：唤息只刷新下一行，
		// 定位针不随换图移动，带上它只会增加抖动导致稳定判定失败。
		const huanxiSigOf = (state: D6MapState): string => {
			const nodes = state.nodes.map(n => `${n.type}${Math.round(n.x / 8) * 8}${n.bright ? 1 : 0}`).join('/');
			return `${nodes}|${Math.round(state.nextRowY / 8) * 8}`;
		};
		// 确认一次唤息扣款。只有签名已经离开点击前的行才允许扣；
		// stable/before_click 两种触发方式最终都走这里，保证一次点击只扣一次。
		const confirmHuanxiDeduction = (sig: string, how: string): boolean => {
			if (!d6HuanxiPending || !sig || sig === d6HuanxiPendingSig) return false;
			d6HuanxiPending = false;
			d6HuanxiCandidateSig = '';
			d6HuanxiCandidateTime = 0;
			const before = g.d6jueWanxiangling || 0;
			const elapsed = now() - d6HuanxiPendingTime;
			g.d6jueWanxiangling = Math.max(0, before - D6_HUANXI_COST);
			console.log(`[d6jue-map] 唤息已刷新地图(${how})，扣${D6_HUANXI_COST}，当前计算余额=${g.d6jueWanxiangling}`);
			d6jueAnalysisLog('map.huanxi_confirm', {
				cost: D6_HUANXI_COST,
				walletBefore: before,
				walletAfter: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
				how,
				elapsed,
			});
			return true;
		};

		// 唤息统一入口：点按钮，费用等地图刷新确认后再扣
		const clickHuanxi = (reason: string, time: number, mapSig: string): boolean => {
			if (d6HuanxiPending) {
				// 确认超时由 handleMapNodes 统一处理；确认期间不再点第二次，
				// 否则换图动画里重复点击会重复扣费。
				console.log('[d6jue-map] 上一次唤息还在确认中');
				return false;
			}
			if (time - (g.d6jueMapClickTime || 0) < 3000) {
				console.log('[d6jue-map] 唤息点击冷却中');
				return false;
			}
			thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
				[right, 1280, 720, 1125, 585, 1210, 645, 250],
			]));
			g.d6jueMapClickTime = time;
			const before = g.d6jueWanxiangling || 0;
			d6HuanxiPending = true;
			d6HuanxiPendingTime = now();
			d6HuanxiPendingSig = mapSig;
			d6HuanxiUsedSeq = getStepTracker().islandSeq;
			d6LastShopExitTime = 0;
			// 点唤息后约 200~350ms 弹出确认框：本轮直接短轮询确认，省掉回主循环等 func 2 的 ~0.7s。
			for (let confirmTry = 0; confirmTry < 4; confirmTry++) {
				thisScript.keepScreen();
				if (oper([OP.HUANXI_CONFIRM], '六道觉_唤息_确认')) break;
				if (confirmTry < 3) sleep(100);
			}
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

		const handleMapNodes = (doClick: boolean, initialHuanxiBright = false): boolean => {
			let time = now();
			let huanxiBright = initialHuanxiBright;
			// 平时 700ms 轮询即可；唤息确认期间缩短到 250ms，让新行更早被看到。
			// 未变化帧会命中地图帧哈希缓存（约 1~2ms），不会每次都跑完整 NCC。
			const minPollGap = d6HuanxiPending ? 250 : 700;
			if (time - (g.d6jueMapLogTime || 0) < minPollGap) return false;
			g.d6jueMapLogTime = time;
			// 唤息确认超时兜底：地图一直没刷新就不扣 300，避免卡住后续唤息。
			// 6s 覆盖换图动画；超时后候选签名一并清空，下一次唤息重新计时。
			if (d6HuanxiPending && now() - d6HuanxiPendingTime > D6_HUANXI_TIMEOUT_MS) {
				const elapsed = now() - d6HuanxiPendingTime;
				d6HuanxiPending = false;
				d6HuanxiCandidateSig = '';
				d6HuanxiCandidateTime = 0;
				console.log('[d6jue-map] 唤息点击后地图未变化，不扣300');
				d6jueAnalysisLog('map.huanxi_unverified', {
					cost: D6_HUANXI_COST,
					reason: 'no_state_change',
					step: g.d6jueStepLeft || 0,
					elapsed,
				});
			}

			// 开局选完初始技能后首次进图也有镜头缩放动画：以首次见到地图唤息的时刻为起点复用进图保护。
			if (d6OpeningMapIntroPending) {
				d6OpeningMapIntroPending = false;
				d6LastRewardDismissTime = now();
			}
			// 战后「获得奖励」/开局首次进图保护：淡入前 0.65s 先短等再首读，避开淡入帧 unknown。
			const postRewardAge0 = d6LastRewardDismissTime > 0 ? now() - d6LastRewardDismissTime : -1;
			const inPostReward = postRewardAge0 >= 0 && postRewardAge0 < D6_POST_REWARD_WINDOW_MS;
			if (!inPostReward && d6LastRewardDismissTime > 0) {
				d6LastRewardDismissTime = 0;
			}
			if (inPostReward && postRewardAge0 < D6_POST_REWARD_MAP_READ_MIN_MS) {
				sleep(D6_POST_REWARD_MAP_READ_MIN_MS - postRewardAge0);
				thisScript.keepScreen();
				const stillDarkPre = oper([OP.HUANXI_DARK], '六道觉_唤息_暗');
				const stillBrightPre = !stillDarkPre && oper([OP.HUANXI_BRIGHT], '六道觉_唤息_亮');
				if (!stillDarkPre && !stillBrightPre) {
					g.d6jueMapLogTime = 0;
					return false;
				}
				huanxiBright = stillBrightPre;
			}

			// 最多在同轮内做 1 次“短等待 + 真实跨帧重读”复核：
			// 去掉旧的 1800ms 盲 TTL 缓存后，sleep(wait) 之后立刻 keepScreen() 重读小地图校验 rowKey，
			// 既真正防抖（过渡帧行号变化会重新计时），又省掉 return false 额外白等的 200ms loopDelay。
			let state: D6MapState | null = null;
			let huanxiSig = '';
			let rowKey = '';
			let retriedClick = false;
			for (let settleTry = 0; settleTry < 2; settleTry++) {
				time = now();
				state = readMapState();
				if (!state) {
					getStepTracker().observeMap({
						time,
						rowKey: '',
						valid: false,
						mapHash: lastMapHash,
					});
					syncStepState();
					return false;
				}
				// 游戏规则：孔雀国「绽放」只在第 5/10/15 关以单节点行出现，绝不会与其它节点同行。
				// 历史日志中多节点行的「绽放」（如 混沌/绽放）全部是把「宁息」误认所致，还会触发错误的 bloom_fix 步数跳变。
				if (state.reachable.length >= 2) {
					let remapped = false;
					for (let ri = 0; ri < state.reachable.length; ri++) {
						if (state.reachable[ri].type === '绽放') {
							state.reachable[ri].type = '宁息';
							remapped = true;
						}
					}
					if (remapped) {
						d6jueAnalysisLog('map.bloom_remap', {
							step: g.d6jueStepLeft || 0,
							nodes: state.reachable.map(n => n.type).join('/'),
						});
					}
				}
				// 唤息确认：新行签名要连续稳定才扣款。只看单帧变化会在换图动画的
				// 中间帧提前确认，导致一次唤息扣两次；具体判定放在 rowValid 计算之后。
				huanxiSig = huanxiSigOf(state);

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
				// 唤息确认：新行必须是有效行（无 unknown/冲突、1~4 个可达节点），
				// 且签名连续稳定 D6_HUANXI_CONFIRM_STABLE_MS 才扣款。
				// 过渡帧/识别不完整的帧不推进候选，避免换图动画中间帧被当成新行。
				if (d6HuanxiPending) {
					if (huanxiSig === d6HuanxiPendingSig) {
						// 还是点击前那一行：中间帧回跳/点击未生效，候选作废
						d6HuanxiCandidateSig = '';
						d6HuanxiCandidateTime = 0;
					} else if (!rowValid) {
						d6HuanxiCandidateSig = '';
						d6HuanxiCandidateTime = 0;
					} else if (huanxiSig !== d6HuanxiCandidateSig) {
						d6HuanxiCandidateSig = huanxiSig;
						d6HuanxiCandidateTime = now();
					} else if (now() - d6HuanxiCandidateTime >= D6_HUANXI_CONFIRM_STABLE_MS) {
						confirmHuanxiDeduction(huanxiSig, 'stable');
					}
				}
				rowKey = d6StepRowKey(state);
				const bloom = state.reachable.length === 1 && state.reachable[0].type === '绽放';
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

				// weak_row 只是”画面行变了、没有岛屿证据”的兜底。先用计数器确认：
				// 计数器没下降说明这次点击没有消耗一步，必须回滚，按点击失败重试当前行。
				let weakReverted = false;
				if (mapUpdate.confirmed && mapUpdate.reason === 'weak_row') {
					// weak 行已经稳定，强制做一次新的计数器读取，不能沿用 pending 期间耗尽的缓存。
					stepCounterRead = null;
					const weakRead = readStepCounter(rowKey, false);
					if (weakRead.result && weakRead.result.confidence >= 0.8) {
						const weakCounterLeft = weakRead.result.value + 1;
						if (weakCounterLeft >= mapUpdate.leftBefore && getStepTracker().revertLastWeakStep()) {
							weakReverted = true;
							syncStepState();
							d6jueAnalysisLog('step.revert_weak', {
								leftBefore: mapUpdate.leftBefore,
								left: getStepTracker().left,
								step: getStepTracker().stepNo,
								seq: getStepTracker().islandSeq,
								counter: weakRead.result.value,
								digits: weakRead.result.digits,
								conf: Number(weakRead.result.confidence.toFixed(2)),
								elapsed: mapUpdate.elapsed,
								nodes: state.reachable.map(n => n.type).join('/'),
							});
							d6jueAnalysisLog('map.step_retry', {
								left: getStepTracker().left,
								step: getStepTracker().stepNo,
								seq: getStepTracker().islandSeq,
								nodes: state.reachable.map(n => n.type).join('/'),
								gap: mapUpdate.elapsed,
								reason: 'weak_counter_unchanged',
							});
						}
					} else {
						d6jueAnalysisLog('step.alert', {
							kind: 'weak_row_unverified',
							step: mapUpdate.stepNo,
							left: mapUpdate.left,
							elapsed: mapUpdate.elapsed,
						});
					}
				}

				if (mapUpdate.alerts.length > 0 && !weakReverted) {
					d6jueAnalysisLog('step.alert', {
						kind: mapUpdate.alerts.join(','),
						step: mapUpdate.stepNo,
						left: mapUpdate.left,
						nodes: state.reachable.map(n => n.type).join('/'),
					});
				}
				if (mapUpdate.confirmed && !weakReverted) {
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
				retriedClick = mapUpdate.retry || weakReverted;
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
					// 主动唤息换图动画过渡帧常出现短暂 unknown，期间静默跳过等待下一帧，不弹 toast/写告警。
					if (d6HuanxiPending) {
						d6UnknownFirstTime = 0;
						d6UnknownLastTime = 0;
						return false;
					}
					const unknownNow = now();
					if (d6UnknownFirstTime === 0 || unknownNow - d6UnknownLastTime > D6_UNKNOWN_CONT_GAP_MS) {
						d6UnknownFirstTime = unknownNow;
						unknownMapNotified = false;
					}
					d6UnknownLastTime = unknownNow;
					const unknownDuration = unknownNow - d6UnknownFirstTime;
					if (!unknownMapNotified && unknownDuration >= D6_UNKNOWN_NOTIFY_MS) {
						const nodeText = state.nodes.map(n => `${d6MapColName(n.col)}${n.type}(ncc${n.score.toFixed(2)}${n.shapeScore ? `/形${n.shapeScore.toFixed(2)}` : ''},亮${n.meanLum.toFixed(0)},金${n.gold})`).join(' | ');
						const pinText = state.pin ? `${state.pin.x},${state.pin.y}` : '未识别';
						const detail = `持续${unknownDuration}ms 定位针=${pinText} 节点: ${nodeText}`;
						console.log(`[d6jue-map] 出现未知岛屿，暂停点击主地图；${detail}`);
						d6jueUnknownLog(`unknown-skip ${detail}`);
						d6jueAnalysisLog('map.unknown', {
							step: g.d6jueStepLeft || 0,
							duration: unknownDuration,
							nodes: state.nodes.map(n => `${d6MapColName(n.col)}${n.type}:${n.score.toFixed(2)}:${n.meanLum.toFixed(0)}:${n.gold}`).join('|'),
							pin: pinText,
							lei: g.d6jueLeiLevel || 0,
							power: g.d6juePowerLevel || 0,
						});
						thisScript.myToast(debugMode ? '六道觉：小地图出现未知岛屿，暂不点击主地图（记录见 d6jue_unknown.log）' : '六道觉：小地图出现未知岛屿，暂不点击主地图', 3000);
						unknownMapNotified = true;
					}
					return false;
				}
				if (typeConflict) {
					return false;
				}
				unknownMapNotified = false;
				d6UnknownFirstTime = 0;
				d6UnknownLastTime = 0;

				// 待确认期间：稳定地图上重读计数器，读数下降即可确认推进。
				if (getStepTracker().pending && rowValid && mapUpdate.settled) {
					const pendingRead = readStepCounter(rowKey, true);
					if (pendingRead.result) {
						const counterUpdate = getStepTracker().noteCounter(
							now(),
							pendingRead.result.value + 1,
							pendingRead.result.confidence,
							true,
							rowKey,
						);
						syncStepState();
						logStepCounterRead(counterUpdate, pendingRead.result);
					}
				}
				const needReturnSettle = getStepTracker().pending && mapUpdate.committed && rowValid && mapUpdate.waitMs > 0;
				const needRowSettle = !getStepTracker().pending && !mapUpdate.settled && rowValid && mapUpdate.waitMs > 0;
				if (needReturnSettle || needRowSettle) {
					let wait = Math.min(mapUpdate.waitMs, mapSettleMs);
					if (d6LastRewardDismissTime > 0) {
						const rewardElapsed = now() - d6LastRewardDismissTime;
						if (rewardElapsed >= 0 && rewardElapsed < D6_POST_REWARD_WINDOW_MS) {
							// 预留约 150ms 给随后的跨帧 map.read，使最终点击落在距获得奖励结束 >= 1400ms。
							const needPostRewardWait = (D6_POST_REWARD_MAP_CLICK_MIN_MS - 150) - rewardElapsed;
							if (needPostRewardWait > wait) {
								wait = Math.min(800, needPostRewardWait);
							}
						}
					}
					sleep(wait);
					if (settleTry === 0) {
						thisScript.keepScreen();
						const stillDark = oper([OP.HUANXI_DARK], '六道觉_唤息_暗');
						const stillBright = !stillDark && oper([OP.HUANXI_BRIGHT], '六道觉_唤息_亮');
						if (stillDark || stillBright) {
							huanxiBright = stillBright;
							continue;
						}
					}
					g.d6jueMapLogTime = 0;
					return false;
				}
				if (getStepTracker().pending) return false;
				if (!mapUpdate.settled) return false;
				break;
			}
			if (!state) return false;

			// 正常地图行：读计数器做校验/中途接手初始化；不阻塞步数推进。
			{
				const counterRead = readStepCounter(rowKey, false);
				if (counterRead.result) {
					const counterUpdate = getStepTracker().noteCounter(
						now(),
						counterRead.result.value + 1,
						counterRead.result.confidence,
						true,
						rowKey,
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
						return false;
					}
				}
				if (!counterRead.result && !getStepTracker().initialized && !counterRead.exhausted) {
					// 中途接手：还不知道真实剩余步数，等计数器连续两次一致再点。
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

			if (state.nodes.length === 0) {
				return false;
			}

			// 唤息规则：
			// 1. 通关条件已满足（力量>=3 且 轰雷>=1）时，当前行全是战斗节点（鏖战/混沌）且节点数<4：
			//    用富余万相铃主动唤息追加宁息商店秒退（唤息+宁息秒退 ~6.5s，显著快于打鏖战 ~11s / 混沌精英 ~12~23s）；
			//    同一岛屿序号最多唤息一次，防止异常重复唤息。
			// 2. 尚未凑齐力量但轰雷已满足时，单节点混沌依然唤息避开高风险精英；
			// 3. 只剩轰雷且临近迎战、当前行没有宁息：主动唤息找宁息商店（每局最多 1 次）。
			const currentSeq = getStepTracker().islandSeq;
			const canHuanxiThisRow = huanxiBright
				&& state.reachable.length >= 1
				&& state.reachable.length < 4
				&& wallet >= D6_HUANXI_COST
				&& d6HuanxiUsedSeq !== currentSeq;
			const allCombatRow = state.reachable.every(n => n.type === '鏖战' || n.type === '混沌');
			const singleChaos = state.reachable.length === 1 && state.reachable[0].type === '混沌';
			if (canHuanxiThisRow && clearMet && allCombatRow) {
				return clickHuanxi('通关已满足，全战斗行唤息换宁息', time, huanxiSig);
			}
			if (canHuanxiThisRow && !clearMet && singleChaos && leiLevel > 0) {
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
				return false;
			}

			// 唤息还没生效时不要点旧行：否则会白白消耗一步，新行随后才刷出来。
			if (doClick && d6HuanxiPending) {
				if (huanxiSig === d6HuanxiPendingSig) {
					return false;
				}
				// 即将点击新行，离开地图前完成扣款（稳定性检查可能赶不上这次点击）
				confirmHuanxiDeduction(huanxiSig, 'before_click');
			}

			if (doClick && getStepTracker().phase === 'map' && now() - (g.d6jueLastMapSigTime || 0) >= mapRetryMs) {
				const slotIndex = d6MapSlotIndex(choice.slot);
				const slotOper = slotIndex >= 0 && thisOperator[OP.MAP_SLOTS] && thisOperator[OP.MAP_SLOTS].oper
					? thisOperator[OP.MAP_SLOTS].oper[slotIndex]
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
				if (d6LastRewardDismissTime > 0) {
					const rewardRemain = D6_POST_REWARD_MAP_CLICK_MIN_MS - (now() - d6LastRewardDismissTime);
					if (rewardRemain > 0 && rewardRemain <= 600) {
						sleep(rewardRemain);
					}
					d6LastRewardDismissTime = 0;
				}
				if (d6LastShopExitTime > 0) {
					const shopAge = now() - d6LastShopExitTime;
					if (shopAge >= 0 && shopAge < D6_SHOP_EXIT_WINDOW_MS) {
						const targetMinMs = d6LastMapClickSlot === 'four-4'
							? D6_SHOP_EXIT_FOUR4_CLICK_MIN_MS
							: D6_SHOP_EXIT_CLICK_MIN_MS;
						const shopRemain = targetMinMs - shopAge;
						if (shopRemain > 0 && shopRemain <= 1200) {
							sleep(shopRemain);
							perfLog('map.shop_settle', shopRemain, `prev=${d6LastMapClickSlot || '-'} cur=${choice.slot} age=${shopAge}`, true);
						}
					}
					d6LastShopExitTime = 0;
				}
				thisScript.regionClick(clickOper);
				d6LastMapClickSlot = choice.slot;
				getStepTracker().noteClick(now(), rowKey, lastMapHash);
				syncStepState();
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

		// 唤息确认期间优先处理确认弹窗与地图轮询：跳过前面的界面识别链，少绕 0.3~0.7s，
		// 让新行更早被看到、扣款确认更早完成。正常地图流程不受影响。
		if (d6HuanxiPending) {
			if (oper([OP.HUANXI_CONFIRM], '六道觉_唤息_确认')) return true;
			const pendingDark = oper([OP.HUANXI_DARK], '六道觉_唤息_暗');
			const pendingBright = !pendingDark && oper([OP.HUANXI_BRIGHT], '六道觉_唤息_亮');
			if (pendingDark || pendingBright) {
				return handleMapNodes(true, pendingBright);
			}
		}

		// 重置本局统计与状态
		const startRun = () => {
			// 从点「开启」到本局出现第一个步数进展之间，都属于同一次开局：
			// 过渡帧/点击重试再次命中「开启」时只点击、不重复统计。
			// run.end 会把 d6jueStarted 置 false；已有进展时也允许重置，
			// 兼容漏掉结算后直接重新开局的场景。
			if (g.d6jueStarted && !d6RunHasProgress()) {
				if (!startRepeatIgnored) {
					startRepeatIgnored = true;
					d6jueAnalysisLog('start.repeat_ignore', {
						times: g.d6jueTimes || 0,
						step: g.d6jueStepLeft || 0,
					});
				}
				return;
			}
			startRepeatIgnored = false;
			d6BattleFailHandled = false;
			g.d6jueStarted = true;
			unknownMapNotified = false;
			d6UnknownFirstTime = 0;
			d6UnknownLastTime = 0;
			bossDetectLogged = false;
			shopGridMissLogged = false;
			shopEnterTime = 0;
			mapStateCache = null;
			d6BuffScreenSettled = false;
			d6BuffRefreshCount = 0;
			d6BuffScreenLastSeen = 0;
			d6BuffWalletOcrSkipUntil = 0;
			d6BuffLastPickTime = 0;
			g.d6jueLeiLevel = 0;
			g.d6juePowerLevel = 0;
			g.d6jueCantClear = false;
			g.d6jueShopRefresh = 0;
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			g.d6jueShopBuyTime = 0;
			g.d6jueWanxiangling = 0;
			lastWalletOcrTime = 0;
			d6IslandKey = '';
			d6IslandGainDone = false;
			d6IslandBuffGainDone = false;
			d6PreSkillBuffSample = null;
			d6HuanxiUsedSeq = -1;
			d6PendingRefreshCost = 0;
			d6PendingRefreshSource = '';
			d6PendingRefreshWalletBefore = 0;
			d6PendingRefreshTime = 0;
			d6HuanxiPending = false;
			d6HuanxiPendingTime = 0;
			d6HuanxiPendingSig = '';
			d6HuanxiCandidateSig = '';
			d6HuanxiCandidateTime = 0;
			d6LastRewardDismissTime = 0;
			d6LastRightLeaveClickTime = 0;
			d6LastShopExitTime = 0;
			d6LastMapClickSlot = '';
			d6OpeningMapIntroPending = false;
			d6ShopBuyLastOper = null;
			d6ShopBuyRetried = false;
			d6BuffRefreshFailCount = 0;
			g.d6jueStepLeft = D6_TOTAL_STEPS;
			g.d6jueHuanxiShop = 0;
			clearBuffSelectLock();
			resetBuffScreenState();
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
			d6juePruneArtifacts();
			d6jueAnalysisSetRun(now());
			d6jueAnalysisLog('step.init', { left: D6_TOTAL_STEPS, mode: 'run_reset' });
			d6jueAnalysisLog('run.start', {
				ver: D6_LOGIC_VERSION,
				times: g.d6jueTimes || 0,
				step: g.d6jueStepLeft || 0,
				wallet: 0,
				lei: 0,
				power: 0,
			});
			if (debugMode) console.log(`[d6jue-analysis] 记录文件: ${d6jueAnalysisPath()}`);
		};

		// ---- 开局流程：确认-选择试炼式神 / 开启-上阵式神（放在开启前，避免同时命中时重复计数）----
		// 弹窗滑入动画期按钮提前变亮（实测 +2.27s 抢点易被吞、+2.48s 稳定生效），加 300ms retest 一次命中。
		if (oper([OP.CONFIRM_SHIKIGAMI], '六道觉_确认-选择试炼式神', 300)) return true;
		if (oper([OP.START_DEPLOY], '六道觉_开启-上阵式神')) return true;

		// ---- 开启-六道觉：重置本局统计 ----
		// 是否重置由 startRun 判断：开局后到第一个步数进展之间重复命中只算一次。
		if (oper([OP.START], '六道觉_开启-六道觉')) {
			startRun();
			return true;
		}

		// ---- 选择舞技 ----
		if (oper([OP.SELECT_DANCE], '六道觉_选择舞技')) return true;

		// ---- 初始技能（开局 buff）：固定选最右侧 ----
		if (oper([OP.INIT_SKILL], '六道觉_初始技能界面')) {
			d6OpeningMapIntroPending = true;
			return true;
		}

		// ---- 获得奖励界面：优先点掉，避免奖励弹窗遮挡后续判定 ----
		if (oper([OP.REWARD], '六道觉_获得奖励界面')) {
			d6LastRewardDismissTime = now();
			return true;
		}

		// 右下角「离开」（绽放 / 混沌秘宝）与主地图「唤息」位置重合：
		// 点击离开后冷却期内跳过绽放/秘宝/精英，防止退场动画期间二次点击误触唤息扣 300，
		// 同时允许主地图恢复后立即进入 handleMapNodes 读图。
		const rightLeaveCoolingDown = d6LastRightLeaveClickTime > 0
			&& now() - d6LastRightLeaveClickTime < D6_RIGHT_LEAVE_COOLDOWN_MS;

		// ---- 绽放之屿：右下角直接离开，不进入战斗 ----
		// 固定用 D6_BLOOM_SIMILAR（88）且去掉旧 retest=500：实机绽放点 (1073,693) 漂移 8~15，
		// 过去受高 colorSimilar 影响漏判并落入秘宝误抢；放宽到 88 后在秘宝图 diff=53 仍不误伤秘宝。
		if (!rightLeaveCoolingDown) {
			const bloomOp = thisOperator[OP.BLOOM_LEAVE];
			if (bloomOp && bloomOp.desc && bloomOp.oper) {
				const bloomStart = now();
				const bloomMatched = thisScript.helperBridge.helper.CompareColorEx(
					bloomOp.desc,
					D6_BLOOM_SIMILAR,
					false,
				);
				if (bloomMatched) {
					noteStepIsland('六道觉_绽放_离开');
					thisScript.regionClick(bloomOp.oper);
					d6LastRightLeaveClickTime = now();
					perfLog('oper 六道觉_绽放_离开', now() - bloomStart, `matched=true retest=0 similar=${D6_BLOOM_SIMILAR}`);
					console.log('[d6jue] 绽放离开按钮命中');
					addIslandGainOnce('绽放岛');
					return true;
				}
			}
		}

		// ---- 神秘之屿：退出后 +50 ----
		if (oper([OP.MYSTERY_CONVERT], '六道觉_神秘_转换')) {
			addIslandGainOnce('神秘岛');
			return true;
		}
		if (oper([OP.MYSTERY_FORGE], '六道觉_神秘_仿造')) {
			addIslandGainOnce('神秘岛');
			return true;
		}

		// ---- 万象赐福使用 ----
		if (oper([OP.BLESSING_USE], '六道觉_万象赐福使用')) return true;

		// ---- 混沌之屿-幸运秘宝：优先于精英判定 ----
		// 秘宝专属点是离开按钮的渐变色，不是纯色；运行时全局 colorSimilar 可能设得很高（例如 100），
		// 用 thisScript.oper 会把 2~4 的通道差也判失败，导致秘宝漏判、精英按标题命中后反复点宝匣。
		// 这里固定用 88（与事件用例一致）直接比较，命中后点「离开」。
		if (!rightLeaveCoolingDown) {
			const chestOp = thisOperator[OP.CHAOS_CHEST];
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
					d6LastRightLeaveClickTime = now();
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

		// ---- 通用挑战按钮：必须放在混沌精英之前 ----
		// 混沌精英选中后左上角「混沌之屿」标题仍然匹配 OP.CHAOS_ELITE；如果先走精英，
		// 会反复点精英，永远点不到右下角「挑战」。
		// 最后 1~2 步留给下面的首领专用 OP.BOSS_CHALLENGE/条件检查，避免绕过通关条件。
		if ((g.d6jueStepLeft || 0) > 2 && oper([OP.BATTLE_CHALLENGE], '六道觉_挑战')) {
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
		if (!rightLeaveCoolingDown && oper([OP.CHAOS_ELITE], '六道觉_混沌_精英')) {
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
			d6ShopBuyLastOper = null;
			d6ShopBuyRetried = false;
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
			d6ShopBuyLastOper = null;
			d6ShopBuyRetried = false;
			console.log(`[d6jue-shop] 购买轰雷失败(${reason})，退出商店且不标记轰雷`);
			d6jueAnalysisLog('shop.buy_failed', {
				reason,
				stock: (g.d6jueShopRefresh || 0) + 1,
				wallet: g.d6jueWanxiangling || 0,
				step: g.d6jueStepLeft || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
			d6LastShopExitTime = now();
			thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
				[right, 1280, 720, 1200, 610, 1245, 660, 500],
			]));
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
						operator: [thisOperator[OP.SHOP_CONFIRM_BUY]],
					}, thisScript.scheme.commonConfig);
					if (confirmDetected && thisOperator[OP.SHOP_CONFIRM_BUY] && thisOperator[OP.SHOP_CONFIRM_BUY].oper) {
						thisScript.regionClick(thisOperator[OP.SHOP_CONFIRM_BUY].oper);
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
					// 首点可能被开店过渡吞掉：1.5s 后仍未出确认框且轰雷图标还在，补点一次购买，避免直接超时弃买。
					if (elapsed >= 1500 && !d6ShopBuyRetried && d6ShopBuyLastOper) {
						d6ShopBuyRetried = true;
						thisScript.regionClick(d6ShopBuyLastOper);
						g.d6jueShopBuyTime = now();
						console.log('[d6jue-shop] 未见购买确认弹窗且轰雷仍在，补点一次购买');
						d6jueAnalysisLog('shop.buy_retry', {
							stock: (g.d6jueShopRefresh || 0) + 1,
							wallet: g.d6jueWanxiangling || 0,
							step: g.d6jueStepLeft || 0,
							lei: g.d6jueLeiLevel || 0,
						});
						return true;
					}
				}
				if (elapsed > 4000) {
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
			operator: [thisOperator[OP.SHOP_SCREEN]],
		}, thisScript.scheme.commonConfig);
		if (shopDetected) {
			noteStepIsland('shop');
			if (!shopEnterTime) {
				shopEnterTime = now();
				console.log('[d6jue-shop] 进入商店');
				d6jueAnalysisLog('shop.enter', {
					step: g.d6jueStepLeft || 0,
					wallet: g.d6jueWanxiangling || 0,
					lei: g.d6jueLeiLevel || 0,
					power: g.d6juePowerLevel || 0,
				});
			}
			const leiLevel = g.d6jueLeiLevel || 0;
			// 轰雷已满足且无待校验刷新扣费时直接退出商店，跳过约 250ms 的钱包 OCR。
			if (leiLevel < 1 || d6PendingRefreshCost > 0) {
				readWanxianglingOcr('shop');
			}
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
						// 购买前留一张商店截图（仅本地调试模式）
						if (debugMode) {
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
						}
						// 九宫格购买区：只点图标下方名称/价格区，不点图标
						thisScript.regionClick(buyOper);
						d6ShopBuyLastOper = buyOper;
						d6ShopBuyRetried = false;
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
					operator: [thisOperator[OP.SHOP_REFRESH]],
				}, thisScript.scheme.commonConfig);
				// 刷新后仍要保留 200 买轰雷：商店刷新 100/次
				const canKeepLeiPrice = wanxiangling - D6_SHOP_REFRESH_COST >= D6_SHOP_LEI_PRICE;
				if (refreshAvailable && canKeepLeiPrice && (g.d6jueShopRefresh || 0) < D6_SHOP_REFRESH_MAX) {
					thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
						[center, 1280, 720, 595, 600, 640, 645, 1500],
					]));
					g.d6jueShopRefresh = (g.d6jueShopRefresh || 0) + 1;
					// 刷新费等下一次 OCR 校验
					beginPendingRefreshCost(D6_SHOP_REFRESH_COST, 'shop_refresh', wanxiangling);
					console.log(`[d6jue-shop] 未见轰雷，万相铃=${wanxiangling}，刷新第${g.d6jueShopRefresh}次(-${D6_SHOP_REFRESH_COST}，保留${D6_SHOP_LEI_PRICE}购买)，当前=${g.d6jueWanxiangling}（等OCR校验）`);
					d6jueAnalysisLog('shop.refresh', {
						stock: g.d6jueShopRefresh,
						walletBefore: wanxiangling,
						walletAfter: g.d6jueWanxiangling || 0,
						cost: D6_SHOP_REFRESH_COST,
						costPending: 1,
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
				// 诊断（仅本地调试模式）：钱够、没轰雷且没有刷新按钮时留一张商店截图
				if (debugMode && wanxiangling >= D6_SHOP_LEI_PRICE) {
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
			d6LastShopExitTime = now();
			thisScript.regionClick(thisScript.helperBridge.regionClickTrans([
				[right, 1280, 720, 1200, 610, 1245, 660, 500],
			]));
			addIslandGainOnce('宁息岛');
			g.d6jueShopRefresh = 0;
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			shopGridMissLogged = false;
			shopEnterTime = 0;
			return true;
		}

		// ---- 选事件：识别到唤息即处理，目标完全由小地图决定 ----
		// 唤息只在“选择下一层节点”阶段出现（暗=不可刷新，亮=可刷新），是阶段指示器；
		// 是否真的有可选节点仍由 handleMapNodes 的小地图识别做最终判定。
		const huanxiDark = oper([OP.HUANXI_DARK], '六道觉_唤息_暗');
		const huanxiBright = !huanxiDark && oper([OP.HUANXI_BRIGHT], '六道觉_唤息_亮');
		if (huanxiDark || huanxiBright) {
			// 小地图无法确定目标时不点任何其他节点
			return handleMapNodes(true, huanxiBright);
		}

		// ---- 首领挑战：条件不足时结束脚本 ----
		const bossDetected = thisScript.desc({
			id: 323,
			name: '六道觉_首领挑战检测',
			operator: [thisOperator[OP.BOSS_CHALLENGE]],
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
			thisScript.oper({ id: 323, name: '六道觉_首领挑战', operator: [thisOperator[OP.BOSS_CHALLENGE]] });
			return true;
		}

		// ---- 挑战按钮：放在鏖战前，避免挑战界面仍带着地图点位时误点怪物 ----
		// 首领专用 OP.BOSS_CHALLENGE 未命中时，用通用挑战按钮兜底：
		// 1. 挑战界面出现只作为“已进岛”证据，步数仍由下一次稳定地图/计数器下降确认；
		// 2. 最后一步且条件不足时，不再点通用挑战，直接停止。
		if ((g.d6jueStepLeft || 0) <= 2) {
			const challengeDetected = thisScript.desc({
				id: 323,
				name: '六道觉_挑战检测',
				operator: [thisOperator[OP.BATTLE_CHALLENGE]],
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
				// 通用挑战在最后一行可能只是普通战斗（本局 0 步时出现过），
				// 不能在这里启动首领 60 秒计时；计时只在真正命中 OP.BOSS_CHALLENGE 时启动。
			}
		}
		if (oper([OP.BATTLE_CHALLENGE], '六道觉_挑战')) {
			addIslandGainOnce('鏖战岛');
			return true;
		}

		// ---- 鏖战-选择怪物：进入鏖战之屿后点右侧敌人；主地图节点由 OP.MAP_SLOTS 固定选择位处理 ----
		if (oper([OP.BATTLE_SELECT_MONSTER], '六道觉_鏖战_选择怪物')) {
			addIslandGainOnce('鏖战岛');
			return true;
		}

		// ---- 舞技强化-选择强化：优先于刷新门禁，避免选强化界面被当成舞技强化入口 ----
		if (oper([OP.SKILL_UPGRADE_PICK], '六道觉_舞技强化-选择强化')) {
			if (buffSelectLocked()) return true;
			const powerBefore = g.d6juePowerLevel || 0;
			g.d6juePowerLevel = powerBefore + 1;
			d6BuffLastPickTime = now();
			// 复用进入舞技强化前采样的 buff 卡面，供混沌精英第 1 轮选完强化切回第 2 轮卡面时提前解锁
			lockBuffSelect(D6_SKILL_SELECT_LOCK_MS, d6PreSkillBuffSample);
			d6PreSkillBuffSample = null;
			resetBuffScreenState();
			addBuffGainOnce('舞技强化选择');
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
		const refreshDark = oper([OP.BUFF_REFRESH_DARK], '六道觉_舞技强化_刷新_暗');
		if (oper([OP.BUFF_REFRESH], '六道觉_舞技强化_刷新') || refreshDark) {
			addIslandGainOnce('战斗岛');
			// 新 buff 界面先等入场动画结束；同一界面的后续轮次（刷新后）不重复等
			const buffScreenGap = d6BuffScreenLastSeen ? now() - d6BuffScreenLastSeen : Infinity;
			const isNewBuffScreen = buffScreenGap > D6_BUFF_SCREEN_GAP_MS;
			if (isNewBuffScreen) resetBuffScreenState();
			d6BuffScreenLastSeen = now();
			let isBuffContinuation = false;
			if (!d6BuffScreenSettled) {
				if (isNewBuffScreen) {
					d6BuffRefreshCount = 0;
					d6BuffLastRefreshTime = 0;
				}
				// 混沌精英第二组卡：buff 界面没有退场，只是换了一组卡；选卡锁已经
				// 覆盖换卡动画，再等 0.7s 入场是纯空等。普通新界面仍按原逻辑等入场。
				const continuation = d6BuffLastPickTime > 0
						&& now() - d6BuffLastPickTime <= D6_BUFF_CONTINUATION_MS;
				isBuffContinuation = continuation;
				if (continuation) {
					// 混沌精英两轮选卡只给一次 +100（在第 2 轮选完后到账）；进入第 2 轮时回退第 1 轮预加，
					// 使第 2 轮刷新费用校验的 walletBefore 与游戏内真实余额一致，且整岛总计仅 +100。
					if (d6IslandBuffGainDone) {
						g.d6jueWanxiangling = Math.max(0, (g.d6jueWanxiangling || 0) - D6_ISLAND_BUFF_GAIN);
						d6IslandBuffGainDone = false;
					}
					d6jueAnalysisLog('buff.continuation', {
						gap: now() - d6BuffLastPickTime,
						refresh: d6BuffRefreshCount,
						lei: g.d6jueLeiLevel || 0,
						power: g.d6juePowerLevel || 0,
						wallet: g.d6jueWanxiangling || 0,
						step: g.d6jueStepLeft || 0,
					});
				} else {
					waitBuffCardsStable('enter', D6_BUFF_ENTER_MIN_MS, null, () => {
						readWanxianglingOcr('buff');
						d6BuffWalletOcrSkipUntil = now() + 3000;
					});
				}
				d6BuffScreenSettled = true;
				thisScript.keepScreen(); // 让下面的 selectLei 用稳定后的卡面帧
			}
			// 混沌精英第二组：第一张卡的钱包还没结算，选卡前 OCR 既慢（约300ms），
			// 又会把 internal wallet sync 回旧值；这一轮跳过，下一次入场/刷新再校准。
			if (!isBuffContinuation) readWanxianglingOcr('buff');
			const powerLevel = g.d6juePowerLevel || 0;
			const leiLevel = g.d6jueLeiLevel || 0;
			const powerSelectable = powerLevel < 10;
			// 余额不足但仍有剩余次数时，游戏刷新按钮仍为亮蓝色（refreshDark=false），
			// 点击只弹“万相铃不足”；因此必须同时校验余额、未扣费熔断和单屏上限。
			const canRefreshBuff = !refreshDark
					&& (g.d6jueWanxiangling || 0) >= D6_BUFF_REFRESH_COST
					&& d6BuffRefreshFailCount < 1
					&& d6BuffRefreshCount < D6_BUFF_REFRESH_MAX_PER_SCREEN;
			const enterSkillUpgrade = (logMsg: string): boolean => {
				const preSample = readBuffCardsSample();
				if (!oper([OP.SKILL_UPGRADE], '六道觉_舞技强化')) return false;
				d6PreSkillBuffSample = preSample;
				resetBuffScreenState();
				console.log(logMsg);
				return true;
			};

			if (powerLevel <= 2) {
				// 优先满足通关：力量≤2，轰雷=0时优先轰雷，否则力量；力量卡不可用时再选其他可用buff
				if (leiLevel === 0 && selectLei()) return true;
				if (powerSelectable && enterSkillUpgrade(`[d6jue] 力量等级=${powerLevel}，继续舞技强化`)) return true;
				if (selectAllowedBuff()) return true;
			} else if (powerSelectable) {
				if (leiLevel === 0) {
					// 力量3~9、轰雷0：轰雷卡 → 刷新找轰雷 → 舞技强化 → 其他可用buff
					if (selectLei()) return true;
					if (canRefreshBuff) {
						refreshBuffSelection();
						return true;
					}
					if (enterSkillUpgrade(`[d6jue] 力量等级=${powerLevel}，无轰雷且刷新不可用，选择舞技强化`)) return true;
					if (selectAllowedBuff()) return true;
				} else {
					// 力量3~9、轰雷>=1：可用buff（轰雷与普通buff同优先级） → 力量 → 亮色刷新
					if (selectAllowedBuff()) return true;
					if (enterSkillUpgrade(`[d6jue] 力量等级=${powerLevel}，继续舞技强化`)) return true;
					if (canRefreshBuff) {
						refreshBuffSelection();
						return true;
					}
				}
			} else {
				// 力量已满（>=10）
				if (leiLevel === 0) {
					// 还缺轰雷：轰雷优先；没有则亮色刷新；暗色选可用buff
					if (selectLei()) return true;
					if (canRefreshBuff) {
						refreshBuffSelection();
						return true;
					}
					if (selectAllowedBuff()) return true;
				} else {
					// 力量与轰雷都不能再选：可用buff → 亮色刷新
					if (selectAllowedBuff()) return true;
					if (canRefreshBuff) {
						refreshBuffSelection();
						return true;
					}
				}
			}

			console.log('[d6jue-buff] 无可用buff，随机选择');

			// 死局：力量满、轰雷满、无法刷新，且三张全是已知黑名单
			// 此时没有能通关的选择，随机强制拿一张，并标记本局无法通关
			if (powerLevel >= 10 && leiLevel >= 3 && !canRefreshBuff) {
				const cards = scanBuffCards();
				const onlyBlacklist = cards.length === 3
					&& cards.every(card => !!card.name && D6_BUFF_BLACKLIST.includes(card.name));
				if (onlyBlacklist) {
					const pick = cards[Math.floor(Math.random() * cards.length)];
					return forceClickBuffCard(pick.index, pick.name);
				}
			}

			if (selectRandomAllowedBuff()) return true;
			return false;
		}

		// ---- 战斗失败：放弃前行 / 确定放弃 ----
		// 失败后不能继续按“通关”结算：记录 boss_fail、清掉首领计时并停止脚本。
		// OP.BATTLE_FAIL_GIVEUP 点“放弃前行”，OP.BATTLE_FAIL_CONFIRM 处理可能出现的二次确认；两者只收尾一次。
		const recordBattleFail = (stage: string) => {
			if (d6BattleFailHandled) return;
			d6BattleFailHandled = true;
			d6jueAnalysisLog('battle.fail', {
				stage,
				step: g.d6jueStepLeft || 0,
				power: g.d6juePowerLevel || 0,
				lei: g.d6jueLeiLevel || 0,
			});
			g.d6jueBossStartTime = 0;
			g.d6jueStarted = false;
			d6jueAnalysisLog('run.end', {
				result: 'boss_fail',
				reason: 'battle_fail',
				stage,
				step: g.d6jueStepLeft || 0,
				power: g.d6juePowerLevel || 0,
				lei: g.d6jueLeiLevel || 0,
				wallet: g.d6jueWanxiangling || 0,
				seconds: Math.floor((now() - (g.d6jueCurrentBegin || now())) / 1000),
			});
			const msg = '首领战失败，脚本停止';
			console.log('[d6jue] ' + msg);
			thisScript.myToast(msg);
			// 给“放弃前行/确定放弃”的点击和退场动画留时间，避免失败弹窗停留在屏幕上
			sleep(1500);
			thisScript.rerun('__停止脚本__');
		};
		if (oper([OP.BATTLE_FAIL_GIVEUP], '六道觉_战斗失败_放弃前行')) {
			recordBattleFail('giveup');
			return true;
		}
		if (oper([OP.BATTLE_FAIL_CONFIRM], '六道觉_战斗失败_确定放弃')) {
			recordBattleFail('confirm');
			return true;
		}

		// ---- 结算：统计、推送、切换方案（放在最后，先关掉奖励弹窗再统计）----
		if (oper([OP.SETTLE_DONE], '六道觉_结算_完成')) {
			// 一轮已经跑完：清空首领计时，避免结算/奖励界面停留时被 60 秒超时误停。
			g.d6jueBossStartTime = 0;
			thisConf.overTimes = Math.floor(Number(thisConf.overTimes) || 0);
			const time = now();
			const currentCost = Math.floor((time - (g.d6jueCurrentBegin || time)) / 1000); // 秒
			d6jueAnalysisLog('run.end', {
				result: 'clear',
				step: g.d6jueStepLeft || 0,
				wallet: g.d6jueWanxiangling || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				seconds: currentCost,
				huanxiShop: g.d6jueHuanxiShop || 0,
			});
			const cost = ((time - (g.d6jueBegin || time)) / 1000 / 60).toFixed(2); // 分
			const costAvg = Math.floor((time - (g.d6jueBegin || time)) / 1000 / (g.d6jueTimes || 1)); // 秒
			let toLog = `通关次数: ${g.d6jueTimes || 0}次, 本次通关时间: ${currentCost}秒, 平均通关时间: ${costAvg}秒, 总通关时间: ${cost}分`;
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
				thisScript.rerun(thisConf.next_scheme);
				sleep(3000);
				return true;
			}
			// 本局结束
			g.d6jueStarted = false;
			return true;
		}

		return false;
	}
}
