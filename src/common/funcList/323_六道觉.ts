import { IFuncOrigin, IFuncOperatorOrigin, IFuncOperator } from '@/interface/IFunc';
import { Script } from '@/system/script';
import { analyzeD6Map, pickD6MapChoice, d6MapSlotIndex, d6MapColName, D6_MINIMAP_DEV_REGION, warmUpD6Map, D6MapState } from '@/common/d6jueMap';
import { bitmapToImageData } from '@/common/autoSelectBitmap';
import { perfLogLine } from '@/common/perfLog';
import { d6jueUnknownLog } from '@/common/d6jueLog';
import { d6jueAnalysisLog, d6jueAnalysisSetRun, d6jueAnalysisPath } from '@/common/d6jueAnalysisLog';

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
// 按小地图画面哈希缓存识别结果，避免冷却/等待期间对同一帧重复跑 NCC
let mapStateCache: { hash: string; state: D6MapState | null } | null = null;

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
const D6_BLOOM_STEPS = [5, 10, 15];
const D6_MAP_SIG_WAIT = 5000;
const D6_HUANXI_COST = 300;
const D6_SHOP_LEI_PRICE = 200;
const D6_SHOP_REFRESH_COST = 50;
const D6_SHOP_REFRESH_MAX = 3;
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
const DEFAULT_BUFF_BLACKLIST = '六道·混沌,六道·偶戏,妖力化身,攻击加成';
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
			name: 'buffBlacklist',
			desc: 'buff黑名单（逗号分隔，默认：六道·混沌,六道·偶戏,妖力化身,攻击加成；其中妖力化身/攻击加成始终强制加入；名称需在 multiFindColors.ts 配置 六道觉_buff_<名称> 多点找色）',
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
		// TODO(六道觉): 取色
		// oper 可参考 316[28]：[center, 1280, 720, 673, 406, 844, 458, 1000]
	}, { // 25 六道觉 -> 战斗失败_确定放弃
		// TODO(六道觉): 取色
		// oper 可参考 316[29]：[center, 1280, 720, 680, 397, 802, 448, 1000]
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
		// 已取色：混沌之屿-精英
		desc: [1280, 720,
			[
				[left, 148, 29, 0xf8f3e0],
				[left, 159, 51, 0xf8f3e0],
				[left, 186, 50, 0xf8f3e0],
				[left, 211, 38, 0xf7f2df],
				[left, 128, 52, 0xf8f3e0],
				[center, 625, 314, 0x3f5081],
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
				[right, 647, 295, 0x364b7a],
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
			[center, 1280, 720, 645, 340, 695, 500, 500], // single
			[center, 1280, 720, 360, 320, 410, 490, 500], // two-left
			[center, 1280, 720, 885, 350, 940, 510, 500], // two-right
			[center, 1280, 720, 265, 310, 320, 460, 500], // three-left
			[center, 1280, 720, 710, 340, 765, 500, 500], // three-center
			[center, 1280, 720, 1005, 320, 1065, 480, 500], // three-right
			[center, 1280, 720, 190, 330, 240, 480, 500], // four-1
			[center, 1280, 720, 450, 450, 505, 600, 500], // four-2
			[center, 1280, 720, 870, 460, 925, 610, 500], // four-3
			[center, 1280, 720, 1000, 360, 1060, 510, 500], // four-4
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
		const now = () => new Date().getTime();
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
		const oper = (indexes: number[], name: string, retest = 0): boolean => {
			const operator = indexes.map(index => thisOperator[index]).filter(isReady);
			if (operator.length === 0) return false;
			const t0 = now();
			const matched = !!thisScript.oper({ id: 323, name, operator }, retest);
			const dt = now() - t0;
			if (perfLogEnabled || dt >= 120) perfLog(`oper ${name}`, dt, `matched=${matched} retest=${retest}`);
			return matched;
		};

		// 万相铃计算（用于商店购买/刷新决策）
		const addWanxiangling = (amount: number, source: string) => {
			g.d6jueWanxiangling = (g.d6jueWanxiangling || 0) + amount;
			console.log(`[d6jue-wanxiangling] ${source}+${amount}，当前=${g.d6jueWanxiangling}`);
			d6jueAnalysisLog('wallet.gain', {
				amount,
				source,
				wallet: g.d6jueWanxiangling || 0,
				pending: g.d6jueWanxianglingPending || 0,
				step: g.d6jueStepLeft || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
		};
		const applyPendingWanxiangling = () => {
			const pending = g.d6jueWanxianglingPending || 0;
			if (pending) {
				g.d6jueWanxiangling = (g.d6jueWanxiangling || 0) + pending;
				g.d6jueWanxianglingPending = 0;
				console.log(`[d6jue-wanxiangling] 进入下个区域，预加生效+${pending}，当前=${g.d6jueWanxiangling}`);
				d6jueAnalysisLog('wallet.apply', {
					amount: pending,
					wallet: g.d6jueWanxiangling || 0,
					step: g.d6jueStepLeft || 0,
				});
			}
		};
		const addPendingWanxiangling = (amount: number, reason: string) => {
			g.d6jueWanxianglingPending = (g.d6jueWanxianglingPending || 0) + amount;
			console.log(`[d6jue-wanxiangling] ${reason}，预加+${amount}，下个区域生效`);
			d6jueAnalysisLog('wallet.pending', {
				amount,
				reason,
				wallet: g.d6jueWanxiangling || 0,
				pending: g.d6jueWanxianglingPending || 0,
				step: g.d6jueStepLeft || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
		};
		// 舞技强化/buff 界面右下角刷新，统一扣费与记录
		const refreshBuffSelection = () => {
			thisScript.regionClick([[1180, 625, 1235, 675, 1500]]);
			g.d6jueWanxiangling = (g.d6jueWanxiangling || 0) - 50;
			console.log(`[d6jue-lei] 刷新-50，万相铃=${g.d6jueWanxiangling}`);
			d6jueAnalysisLog('buff.refresh', {
				wallet: g.d6jueWanxiangling || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
				step: g.d6jueStepLeft || 0,
			});
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
			});
			return cards;
		};

		const clickBuffCard = (index: number, name: string | null): boolean => {
			if (name && !isBuffSelectable(name)) {
				console.log(`[d6jue-buff] 拒绝选择不可用buff: ${name}`);
				return false;
			}
			const button = buffButtons[index];
			if (!button) return false;
			thisScript.regionClick([[button[0], button[1], button[2], button[3], 500]]);
			addPendingWanxiangling(100, `选择buff:${name || '未知'}`);
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
			});
			if (!lei) return false;
			return clickBuffCard(cardIndexByX(lei.x), '六道轰雷');
		};

		// 死局强制选择：跳过黑名单/等级限制，直接点一张，并把本局标记为无法通关
		const forceClickBuffCard = (index: number, name: string | null): boolean => {
			const button = buffButtons[index];
			if (!button) return false;
			thisScript.regionClick([[button[0], button[1], button[2], button[3], 500]]);
			addPendingWanxiangling(100, `死局选择buff:${name || '未知'}`);
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
			const readIndex = mapReadCount++;
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
						perfLog('map.cache', t3 - t0, `first=${readIndex === 0 ? 1 : 0} bitmap=${t1 - t0} pixels=${t2 - t1} hash=${t3 - t2} nodes=${mapStateCache.state ? mapStateCache.state.nodes.length : 0}`, true);
						return mapStateCache.state;
					}
					const state = analyzeD6Map(image);
					mapStateCache = { hash, state };
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

		// 唤息统一入口：点按钮、扣除 300 万相铃、共用点击冷却
		const clickHuanxi = (reason: string, time: number): boolean => {
			if (time - (g.d6jueMapClickTime || 0) < 3000) {
				console.log('[d6jue-map] 唤息点击冷却中');
				return false;
			}
			thisScript.regionClick([[1125, 585, 1210, 645, 500]]);
			g.d6jueMapClickTime = time;
			const before = g.d6jueWanxiangling || 0;
			g.d6jueWanxiangling = Math.max(0, before - D6_HUANXI_COST);
			console.log(`[d6jue-map] ${reason}，唤息-${D6_HUANXI_COST}，万相铃=${before}->${g.d6jueWanxiangling}`);
			d6jueAnalysisLog('map.huanxi', {
				reason,
				step: g.d6jueStepLeft || 0,
				walletBefore: before,
				walletAfter: g.d6jueWanxiangling || 0,
				pending: g.d6jueWanxianglingPending || 0,
				lei: g.d6jueLeiLevel || 0,
				power: g.d6juePowerLevel || 0,
			});
			if (before < D6_HUANXI_COST) {
				console.log(`[d6jue-map] 万相铃记录值不足${D6_HUANXI_COST}，可能存在记账偏差`);
			}
			return true;
		};

		const handleMapNodes = (doClick: boolean, huanxiBright = false): boolean => {
			const time = now();
			if (time - (g.d6jueMapLogTime || 0) < 1000) return false;
			g.d6jueMapLogTime = time;

			const state = readMapState();
			if (!state) {
				if (thisConf.logMapNodes) console.log('[d6jue-map] 未识别到小地图节点，跳过');
				return false;
			}

			// unknown 说明岛屿图标没有匹配到任何模板：无法判断目标，本回合不点击主地图，
			// 记录一次节点信息后继续运行，等小地图刷新或人工处理。
			const unknownNodes = state.nodes.filter(n => n.type === 'unknown');
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
			unknownMapNotified = false;

			// 同一行防重复点击：点击后 5 秒内仍看到相同节点行，说明还没进入事件，不再重复点
			const reachSig = state.reachable.map(n => `${n.type}${n.x}`).join('/');
			if (reachSig === (g.d6jueLastMapSig || '') && time - (g.d6jueLastMapSigTime || 0) < D6_MAP_SIG_WAIT) {
				if (thisConf.logMapNodes) console.log('[d6jue-map] 同一节点行等待跳转，暂不重复点击');
				return false;
			}

			// 绽放固定在第 5/10/15 关，用于校正点击漂移造成的步数误差
			const bloomIndex = g.d6jueBloomCheckpoint || 0;
			if (bloomIndex < D6_BLOOM_STEPS.length && state.reachable.some(n => n.type === '绽放')) {
				const expected = D6_BLOOM_STEPS[bloomIndex];
				const beforeStepNo = D6_TOTAL_STEPS - (g.d6jueStepLeft || 0) + 1;
				if (Math.abs(beforeStepNo - expected) <= 3) {
					if (beforeStepNo !== expected) {
						g.d6jueStepLeft = D6_TOTAL_STEPS - expected + 1;
						console.log(`[d6jue-map] 绽放步数校正：${beforeStepNo}->${expected}，剩余步数=${g.d6jueStepLeft}`);
						d6jueAnalysisLog('map.step_fix', {
							before: beforeStepNo,
							after: expected,
							left: g.d6jueStepLeft,
							nodes: state.reachable.map(n => n.type).join('/'),
						});
					}
					g.d6jueBloomCheckpoint = bloomIndex + 1;
				}
			}

			const powerLevel = g.d6juePowerLevel || 0;
			const leiLevel = g.d6jueLeiLevel || 0;
			const wallet = (g.d6jueWanxiangling || 0) + (g.d6jueWanxianglingPending || 0);
			const powerReady = powerLevel > 2;
			const needLei = leiLevel === 0;
			const clearMet = powerReady && leiLevel > 0;
			// 只剩轰雷且买得起时，临时把宁息提到最高，避免同行神秘把商店抢走
			// 350 = 买轰雷 200 + 商店刷 3 次 150，进店即可刷满
			const priority = needLei && powerReady && wallet >= D6_SHOP_LEI_PRICE + D6_SHOP_REFRESH_COST * D6_SHOP_REFRESH_MAX
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
			if (singleChaos && huanxiBright && leiLevel > 0) {
				return clickHuanxi('轰雷已满足，下一层仅混沌单节点', time);
			}

			const stepLeft = g.d6jueStepLeft || 0;
			const hasNingxi = state.reachable.some(n => n.type === '宁息');
			// 剩余 <=3 步时只求买到（W>=500）；4~5 步时要求唤息后还能三刷（300+350=650）
			const huanxiShopWallet = stepLeft <= 3 ? 500 : 650;
			if (
				needLei && powerReady && !g.d6jueCantClear && huanxiBright && !hasNingxi
				&& state.reachable.length < 4
				&& stepLeft > 0 && stepLeft <= 5
				&& (g.d6jueWanxiangling || 0) >= D6_HUANXI_COST
				&& wallet >= huanxiShopWallet
				&& (g.d6jueHuanxiShop || 0) < 1
			) {
				if (clickHuanxi(`仅剩轰雷且无宁息(剩余${stepLeft}步)，主动唤息找商店`, time)) {
					g.d6jueHuanxiShop = (g.d6jueHuanxiShop || 0) + 1;
					return true;
				}
				return false;
			}

			if (!choice) {
				if (thisConf.logMapNodes) console.log('[d6jue-map] 没有可达节点，跳过');
				return false;
			}

			if (doClick && time - (g.d6jueMapClickTime || 0) >= 3000) {
				const slotIndex = d6MapSlotIndex(choice.slot);
				const slotOper = slotIndex >= 0 && thisOperator[53] && thisOperator[53].oper
					? thisOperator[53].oper[slotIndex]
					: null;
				if (!slotOper) {
					console.log(`[d6jue-map] 未找到主地图选择位: ${choice.slot}`);
					return false;
				}
				applyPendingWanxiangling();
				thisScript.regionClick([slotOper]);
				g.d6jueMapClickTime = time;
				g.d6jueLastMapSig = state.reachable.map(n => `${n.type}${n.x}`).join('/');
				g.d6jueLastMapSigTime = time;
				const stepLeftBefore = g.d6jueStepLeft || 0;
				const stepNo = D6_TOTAL_STEPS - stepLeftBefore + 1;
				d6jueAnalysisLog('map.step', {
					step: stepNo,
					left: stepLeftBefore,
					nodes: state.reachable.map(n => n.type).join('/'),
					target: choice.target.type,
					slot: choice.slot,
					mode: priority === MAP_PRIORITY_SHOP_HUNT ? 'hunt' : (clearMet ? 'cleared' : 'normal'),
					wallet: g.d6jueWanxiangling || 0,
					pending: g.d6jueWanxianglingPending || 0,
					lei: leiLevel,
					power: powerLevel,
				});
				if (choice.target.type === '绽放' && stepLeftBefore > 0 && [5, 10, 15].indexOf(stepNo) === -1) {
					console.log(`[d6jue-map] 绽放出现在第${stepNo}步（预期5/10/15），请检查步数记录`);
				}
				if (stepLeftBefore > 0) {
					g.d6jueStepLeft = stepLeftBefore - 1;
				}
				console.log(`[d6jue-map] 点击 ${choice.target.type}@${d6MapColName(choice.target.col)}，主地图选择位=${choice.slot}(${choice.index + 1}/${choice.count})，剩余${g.d6jueStepLeft || 0}步`);
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
			mapStateCache = null;
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
			g.d6jueStepLeft = D6_TOTAL_STEPS;
			g.d6jueHuanxiShop = 0;
			g.d6jueLastMapSig = '';
			g.d6jueLastMapSigTime = 0;
			g.d6jueBloomCheckpoint = 0;
			g.d6jueCurrentBegin = now();
			if (!g.d6jueBegin) {
				g.d6jueBegin = now();
			}
			g.d6jueTimes = (g.d6jueTimes || 0) + 1;
			d6jueAnalysisSetRun(now());
			d6jueAnalysisLog('run.start', {
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
		if (oper([42], '六道觉_获得奖励界面')) return true;

		// ---- 绽放之屿：右下角直接离开，不进入战斗 ----
		if (oper([45], '六道觉_绽放_离开', 500)) {
			console.log('[d6jue] 绽放离开按钮命中');
			addWanxiangling(50, '绽放退出');
			return true;
		}

		// ---- 神秘之屿：退出后 +50 ----
		if (oper([17], '六道觉_神秘_转换')) {
			addWanxiangling(50, '神秘转换退出');
			return true;
		}
		if (oper([43], '六道觉_神秘_仿造')) {
			addWanxiangling(50, '神秘仿造退出');
			return true;
		}

		// ---- 万象赐福使用 ----
		if (oper([51], '六道觉_万象赐福使用')) return true;

		// ---- 混沌之屿-幸运秘宝：优先于精英判定 ----
		if (oper([47], '六道觉_混沌_幸运秘宝')) {
			addWanxiangling(50, '混沌秘宝退出');
			return true;
		}

		// ---- 混沌之屿-精英：优先点击 ----
		if (oper([46], '六道觉_混沌_精英')) {
			addWanxiangling(50, '混沌精英挑战');
			return true;
		}

		// ---- 商店购买确认：点击购买后必须确认成功，不能提前标记轰雷已获得 ----
		const completeShopBuy = (how: string) => {
			g.d6jueLeiLevel = 1;
			g.d6jueWanxiangling = Math.max(0, (g.d6jueWanxiangling || 0) - D6_SHOP_LEI_PRICE);
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			console.log(`[d6jue-shop] 购买轰雷成功(${how})，万相铃=${g.d6jueWanxiangling}`);
			d6jueAnalysisLog('shop.buy_success', {
				how,
				stock: (g.d6jueShopRefresh || 0) + 1,
				wallet: g.d6jueWanxiangling || 0,
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
			addWanxiangling(50, '宁息退出');
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
				// 刷新后仍要保留 200 买轰雷：只要扣 50 后还 >=200 就可以继续刷
				const canKeepLeiPrice = wanxiangling - D6_SHOP_REFRESH_COST >= D6_SHOP_LEI_PRICE;
				if (refreshAvailable && canKeepLeiPrice && (g.d6jueShopRefresh || 0) < D6_SHOP_REFRESH_MAX) {
					thisScript.regionClick([[595, 600, 640, 645, 1500]]);
					g.d6jueShopRefresh = (g.d6jueShopRefresh || 0) + 1;
					g.d6jueWanxiangling = wanxiangling - D6_SHOP_REFRESH_COST;
					console.log(`[d6jue-shop] 未见轰雷，万相铃=${wanxiangling}，刷新第${g.d6jueShopRefresh}次(-${D6_SHOP_REFRESH_COST}，保留${D6_SHOP_LEI_PRICE}购买)，剩余=${g.d6jueWanxiangling}`);
					d6jueAnalysisLog('shop.refresh', {
						stock: g.d6jueShopRefresh,
						walletBefore: wanxiangling,
						walletAfter: g.d6jueWanxiangling || 0,
						step: g.d6jueStepLeft || 0,
						lei: g.d6jueLeiLevel || 0,
					});
					return true;
				}
				console.log(`[d6jue-shop] 未见轰雷且无法刷新(万相铃=${wanxiangling}，刷新${g.d6jueShopRefresh || 0}次)，退出商店`);
				d6jueAnalysisLog('shop.exit', {
					reason: 'no_hit',
					stock: (g.d6jueShopRefresh || 0) + 1,
					wallet: wanxiangling,
					step: g.d6jueStepLeft || 0,
					lei: g.d6jueLeiLevel || 0,
					power: g.d6juePowerLevel || 0,
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
			addWanxiangling(50, '宁息退出');
			g.d6jueShopRefresh = 0;
			g.d6jueShopBuyPending = false;
			g.d6jueShopBuyStage = 0;
			shopGridMissLogged = false;
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
			thisScript.oper({ id: 323, name: '六道觉_首领挑战', operator: [thisOperator[50]] });
			return true;
		}

		// ---- 挑战按钮：放在鏖战前，避免挑战界面仍带着地图点位时误点怪物 ----
		// 诊断：首领专用 operator[50] 未命中时，检查通用挑战按钮是否命中。
		// 若这里命中且剩余步数 <=2，很可能就是首领挑战被通用按钮误点。
		if (!bossDetectLogged && (g.d6jueStepLeft || 0) <= 2) {
			const challengeDetected = thisScript.desc({
				id: 323,
				name: '六道觉_挑战检测',
				operator: [thisOperator[20]],
			}, thisScript.scheme.commonConfig);
			if (challengeDetected) {
				bossDetectLogged = true;
				const power = g.d6juePowerLevel || 0;
				const lei = g.d6jueLeiLevel || 0;
				const cantClear = !!g.d6jueCantClear;
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
		}
		if (oper([20], '六道觉_挑战')) {
			addWanxiangling(50, '鏖战挑战');
			return true;
		}

		// ---- 鏖战-选择怪物：进入鏖战之屿后点右侧敌人；主地图节点由 operator[53] 固定选择位处理 ----
		if (oper([38], '六道觉_鏖战_选择怪物')) return true;

		// ---- 舞技强化-选择强化：优先于刷新门禁，避免选强化界面被当成舞技强化入口 ----
		if (oper([41], '六道觉_舞技强化-选择强化')) {
			const powerBefore = g.d6juePowerLevel || 0;
			g.d6juePowerLevel = powerBefore + 1;
			addPendingWanxiangling(100, '舞技强化选择');
			d6jueAnalysisLog('skill.pick', {
				powerBefore,
				powerAfter: g.d6juePowerLevel,
				wallet: g.d6jueWanxiangling || 0,
				lei: g.d6jueLeiLevel || 0,
				step: g.d6jueStepLeft || 0,
			});
			return true;
		}

		// ---- 舞技强化/buff选择：右下角「刷新」表示该界面（亮/暗都识别）----
		const refreshDark = oper([49], '六道觉_舞技强化_刷新_暗');
		if (oper([39], '六道觉_舞技强化_刷新') || refreshDark) {
			const powerLevel = g.d6juePowerLevel || 0;
			const leiLevel = g.d6jueLeiLevel || 0;
			const powerSelectable = powerLevel < 10;

			if (powerLevel <= 2) {
				// 优先满足通关：力量≤2，轰雷=0时优先轰雷，否则力量；力量卡不可用时再选其他可用buff
				if (leiLevel === 0 && selectLei()) return true;
				if (powerSelectable && oper([40], '六道觉_舞技强化')) {
					g.d6jueSkillCount = (g.d6jueSkillCount || 0) + 1;
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
						console.log(`[d6jue] 力量等级=${powerLevel}，无轰雷且刷新不可用，选择舞技强化`);
						return true;
					}
					if (selectAllowedBuff()) return true;
				} else {
					// 力量3~9、轰雷>=1：可用buff（轰雷与普通buff同优先级） → 力量 → 亮色刷新
					if (selectAllowedBuff()) return true;
					if (oper([40], '六道觉_舞技强化')) {
						g.d6jueSkillCount = (g.d6jueSkillCount || 0) + 1;
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
			thisConf.overTimes = Math.floor(Number(thisConf.overTimes) || 0);
			const time = now();
			const currentCost = Math.floor((time - (g.d6jueCurrentBegin || time)) / 1000); // 秒
			d6jueAnalysisLog('run.end', {
				result: 'clear',
				step: g.d6jueStepLeft || 0,
				wallet: g.d6jueWanxiangling || 0,
				pending: g.d6jueWanxianglingPending || 0,
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
