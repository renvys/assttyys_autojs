/**
 * 六道觉（323）右上角小地图识别与地图结构推断。
 *
 * 修改识别逻辑后必须运行 `npm run test:d6jue-map`，用例见 tools/d6jueMap/test/。
 *
 * 设计目标：
 * 1. 每个岛屿只维护“图标本身”的模板；图标出现在任意行列都用同一份模板识别，
 *    不再按节点排列、按行列位置分别取色。
 * 2. 直接扫描整块小地图：按金色像素密度找出所有图标，再按模板分类。
 * 3. 游戏用小地图图标的“亮/暗”表示能否进入：亮色 = 当前可选的下一层节点。
 *    因此不需要假设固定 3 列，也不需要定位针：把亮色节点按行分组，取最上面
 *    一排亮色节点（当前节点徽记在它下方），按从左到右顺序对应主地图选择位。
 * 4. 主地图只按“可选节点数量 + 目标顺序”点击固定选择位，不再为某个岛屿出现
 *    在某个位置单独取主地图锚点。
 *
 * 当前版本的岛屿共 5 种：鏖战/混沌/神秘/宁息/绽放。
 *
 * 类型识别分两层：
 * 1. 实机截图模板（9 份）：24x24 灰度 + NCC，准确度最高。
 * 2. 形状补充模板（宁息/绽放）：用于模板未覆盖的变体，按图例轮廓做梯度方向补判。
 *
 * 模板来源：d6jue_now2 / map_frame_3 / d6jue_5types 的小地图实机截图，
 * 以及 d6jue_map_now.png 的玩法图例。重新截取模板见
 * tools/d6jueMap/extractTemplates.js。
 *
 * 注意：本模块只做纯像素计算，不依赖 Auto.js / DOM / Node，方便离线验证。
 */

export type D6MapNodeType = '鏖战' | '混沌' | '神秘' | '宁息' | '绽放' | 'unknown';

export interface D6MapImageData {
	width: number;
	height: number;
	/** RGBA，长度应为 width * height * 4 */
	data: Uint8ClampedArray | Uint8Array | number[];
}

export interface D6MapPin {
	x: number;
	y: number;
}

export interface D6MapNode {
	/** 所在行从左到右的序号（仅日志用） */
	col: number;
	x: number;
	y: number;
	type: D6MapNodeType;
	/** 命中的图标模板最大相似度 0~1 */
	score: number;
	/** 图标附近 26x26 范围内的金色像素数 */
	gold: number;
	/** 命中的模板 key（调试用） */
	template: string;
	/**
	 * NCC 未命中时，用图例形状模板补判的分数 0~1（0 表示未使用形状补判）。
	 * 目前只用于宁息/绽放这类变体。
	 */
	shapeScore?: number;
	/** 亮色 = 当前可进入；暗色 = 不可进入 */
	bright: boolean;
	/** 金色像素平均亮度，用于亮/暗判定 */
	meanLum: number;
}

export interface D6MapState {
	/** 定位针（仅单节点时识别，用于避免误点当前节点；多节点时为 null） */
	pin: D6MapPin | null;
	/** 可选节点行的平均 y（开发坐标），没有可选节点时为 -1 */
	nextRowY: number;
	/** 当前可选的亮色节点，按 x 从左到右 */
	nodes: D6MapNode[];
	/** 当前可选的下一层节点（亮色），按从左到右 */
	reachable: D6MapNode[];
}

export type D6MapSlot =
	| 'single'
	| 'two-left'
	| 'two-right'
	| 'three-left'
	| 'three-center'
	| 'three-right'
	| 'four-1'
	| 'four-2'
	| 'four-3'
	| 'four-4';

export interface D6MapChoice {
	target: D6MapNode;
	/** 目标在全部可选节点（从左到右）中的下标 */
	index: number;
	/** 可达节点数量（1/2/3/4），对应主地图的显示数量 */
	count: number;
	slot: D6MapSlot;
}

/**
 * 小地图识别区域（1280x720 开发坐标，含边界）。
 * 覆盖节点图标和定位针，不包含下方“X 回合后迎战”文字。
 */
export const D6_MINIMAP_DEV_REGION = { x0: 1060, y0: 0, x1: 1270, y1: 235 } as const;

/** 主地图固定选择位顺序，与 323 operator[53].oper 的下标一一对应 */
export const D6_MAP_SLOTS: D6MapSlot[] = [
	'single',
	'two-left',
	'two-right',
	'three-left',
	'three-center',
	'three-right',
	'four-1',
	'four-2',
	'four-3',
	'four-4',
];

const REGION_W = D6_MINIMAP_DEV_REGION.x1 - D6_MINIMAP_DEV_REGION.x0 + 1;
const REGION_H = D6_MINIMAP_DEV_REGION.y1 - D6_MINIMAP_DEV_REGION.y0 + 1;

/** 候选图标：26x26 范围内金色像素数下限（真实图标约 160~370，路径/定位针约 60~135） */
const CANDIDATE_MIN_GOLD = 140;
/** 候选图标非极大值抑制半径（像素中心距离） */
const CANDIDATE_NMS_RADIUS = 20;
/** 亮/暗判定：金色像素平均亮度默认阈值 */
const BRIGHT_MEAN_DEFAULT = 150;
/** 亮/暗判定：自适应阈值的允许范围，避免把亮色簇内部差异误当分界 */
const BRIGHT_MEAN_MIN = 135;
const BRIGHT_MEAN_MAX = 160;
/** 亮/暗判定：亮度分布最大间隙小于该值时使用默认阈值 */
const BRIGHT_GAP_MIN = 18;
/** 类型判定：NCC 相似度下限，低于该值记为 unknown（可能是未配置模板的变体） */
const TYPE_MIN_SCORE = 0.65;
/** 宁息/绽放形状补判：梯度方向相关分数下限 */
const SHAPE_MIN_SCORE = 0.18;
/** 宁息/绽放形状补判：模板边缘被实际像素边缘覆盖的比例下限（实心色块覆盖率很低） */
const SHAPE_MIN_COVERAGE = 0.7;
/** 宁息/绽放形状补判：两者分数差下限，避免模棱两可时误判 */
const SHAPE_MIN_MARGIN = 0.015;
// 定位针颜色（亮黄色，内联在 findPin）：r > 205 && g > 160 && b < 210 && (r - b) > 45 && (g - b) > 25
// 岛屿图标颜色（金色，内联在 buildGoldIntegral/nodeBrightness/goldCentroid）：r > 85 && g > 65 && b < 205 && (r - b) > 18 && (g - b) > 8 && r >= g - 18

interface RawIconTemplate {
	key: string;
	type: D6MapNodeType;
	size: number;
	/** 灰度字节的十六进制串，长度 = size*size*2 */
	data: string;
}

interface IconTemplate {
	key: string;
	type: D6MapNodeType;
	size: number;
	gray: Float32Array;
	/** 已按 L2 范数归一化的零均值模板 (gray - mean) / sqrt(ss)，供单遍 24x24 精搜 NCC */
	normCentered: Float32Array;
	/** 隔行隔列 12x12 下采样归一化零均值模板，供 3x3 粗搜排名（计算量降为 1/4） */
	coarseNormCentered: Float32Array;
	mean: number;
	ss: number;
}

/**
 * 图标模板（鏖战/混沌/神秘/宁息/绽放）：只保留亮色。
 * 当前可选节点一定是亮色；暗色节点不会成为下一层目标，不需要模板。
 * 鏖战/混沌/神秘取自 d6jue_now2.png / map_frame_3.png；
 * 宁息/绽放取自 d6jue_5types.png / d6jue_zhanfang_bright.png 的实机小地图。
 * 均为 24x24 图标内部区域（含少量背景，NCC 对背景不敏感）。
 */
const RAW_ICON_TEMPLATES: RawIconTemplate[] = [
	{ key: 'aozhan_bright', type: '鏖战', size: 24, data: '212670c0474885e0f2cda65db0e2648ebbe9faccb0ebaf5f22232ecabc4e74e68d432b26a8f049263666ddfafb9b2f7123242359e8e8e44f1e1f1f25a6ef462321212b90d34539702424299ae8d249283345244cd4ee9b3437462e2a89afc161242467e6d48d75a5b7a662d6b8a0e9a475c3ad9c80aeeab6232ba3e999343e49b09acda22f2751e7acbf7e5e4446ddd9214bc9e73d22211f4da7e4381d1d1fb0c0a22d24222460e82b80e2ae262322202450db87281d3ac49337242324263bde4d81d96f23232221212876d7a08dbcba5026222121252cbd1b48ca5724242e28306a3861dbdabc315963262e212325a6d9cecc4f2b51a8bd808e2f46cad39b235cbd77bc883725ad73c3d05a4f8e63454835223dc2cea62528444e4d73723ca62480d38f3a3324212139472780d09428522b242427393fba2663cabf3126232259bd4e269acb6926849d2a26252538cc253daace632723239a872643c2c34f2440b85229292a9dc7232987bca43f25259e712540b9c48b2337b058303268c1af212332a5c78028597e36252b92bd7424255a823260b5c6852120238364ae83482827262b9cbb692422242a569abec8842121572a53bfc08445292732aeb26924273161a57444a0ab21244759aeb3b8b89c7f534ca4b283356391a8be846754a0213b89a05733469db9b1b2aaa3a4a0aeb5bcba73343f5f7e245d632f2222232b628da7a9a5a6a29f9c773d2a2a2b304b242a2624242525282b3543549ba59957312b292a2a2b2d3324242424252627292a2a2a2b73a666282a292b2c2d2c2e31' },
	{ key: 'hundun_bright', type: '混沌', size: 24, data: '1d1e1e1e1d2168ddf5e2e4e6e2e0e0e2e4e3ebbb392e3d361d1e1e1e2271e3e5e0ebd0c8c4bebfc5bed1e7e5d76e2d281c1c1d1f66e6e5dff0ab80a2cacacabb9981a8e3f2df5e211a1a1e3cb0f5dfdc718dd9f8f6f5f6f0efd68780cff1da241b1b4293ecb29d8ab2f4c5865d4b6b98d0e2e8ad7bc4eeba1b1b5db2c3919eb1f0963c1a2e611a1d4dacdcdac58ad1e51b3b74bb98909fe1aa241b1a7a571819193cb9d7d2b78edb1b597fb2b293adce2e1919198b592c1b1b1a69e2cbd18ab91c888ea484b2c987201a1a22be8e4b1d1b1b31c0ced2b9941d7f989d7ba6c6621b1a1a47dea4732a1c1c1f95d5c8cc741b6c83916ab2bf581c1c1e91e4856e301c1d1d6fd5c1d27e1f527d7d6fadb3671e1e54c7c840429d1d1d1e58d5c0c7952b2c8c7a8999938d23237fc8c7535fba1e1d1e66cebbc09f4b1e798566719fa13a1f389ac9bcc0761f214487c6b6bca481204a872a40b988b62c202a96b867232251868dbdb5bb956f512171762756a2a7913f292f2b2b386bb278b2acacb75737bd4c348987374c75a29a7c7d6d689dce727cb1acaea4342357b4482f81aa572d4755676e779ab46770a9a9a8af756b262765bf632c61a6aa85505985a28c425ca0a8a6a9a64da329272b60a88d462c366f87847d565b6891a2a0a4ab6d3c4d292827284f97a9876b4e425365838c9ba2a0a5a6672e31282a29292a2a354a74a7b4b0a9a7aba2a4a4a49e462a26282829292a2b2b2c2d2e343d4973a2a6a49e92884a2a27282726292828282934404853616e829993765a58342c2b29272727' },
	{ key: 'shenmi_bright', type: '神秘', size: 24, data: '1c2c1a1d6edecfd8dee8e6eaddd8d7d6d6d6dbdf4d1818192369215eeaeae8e1b8a2a3c2e2eed7d7d6d6d6841d171919288a82eadbb67836231d1e272f68aad7dcd7db6f1918191f3ec4ead76b29191b19181f1d1c1a266ccbd7dead3518176378dee33d1d181929467e97a2a289521d3bd8d7d5cb8f9fd4a8dd48191b3157bfe3e8dde2dbdbdd6b1925cdc7cee1e277db7f1a2465cfdab0948893adc9c9dc6b191867cfc8c7cb4cbe37184ad5e4973325222256c6c3cf5b18172da5c4cfa62a87201b2352aebfa3301b1b55c0c8c4371b1a2182c6d07a1c4a1b1b1b1b34c9cd85221d6fc5d16e1f1b1a1b52c2cb5c1c351b1b1b1b1c407262232086ceb3331c1b1b1d3bb9c07b1e311a1b1c1c1c1c1e1f1c35b4c14c1b1c1d1e2032b0bd8d23311b1c1c1d1e1d1b1b1b69da671d1c1d1f202139b0b299264d1e1c1f2323211d1a42ce73201c1d1f20212148b4b1974e71221e282c2b251e2b8e7b231f1f20202122256cb2af9f9d90292a34382f26212e402427222323232423308fb5a8b15f9b543842372b2524253187322423242526244baca9a78c2587a54d3f302623252d92742b25232325273098ada8b0491c6fb8a0452824242538b9b351262423243483aea6b26e211e6a92b29d3621212437686b322625273a8ea59dad92201e1f6370a9a2a769302c2a2726282b365ca6ae9fa18c312322234f2f66adaaad897f7566636a7a92b2a8a396632e25262525312b2b4e7080766c778b9999967f5a5c513e2726262625252a2a2b2a293537252728272c282826272726262626252424' },
	{ key: 'ningxi_bright', type: '宁息', size: 24, data: '7d775c4542434244423f3f597a7b5c433f3c3a3837363838667c6850424443403e3d41597575563f3d3c3e3e3d3b3b395469745b4c42423d3d3f43576d6c513e3d3d41403f3d3c39495b69665547413c3d4046536f7064493d40403e3e3d3c3b424b5a675c4e42436084abb3bbbcbab3a182623f424242423d3f4b585f544d7db2ca4f3f54574b3e71cfb87f54454140413f424d5454504647988d4855554b459d7e3a3f4c433f3e4a4643465d574c45424a644c5251443a4a47433f40516d3d4b474644bce8b37850534b4a515149464b515a6ec4f4cd44444543418df9f9f9dfd3b79ea2a2a2a3bacaf0f6efef963f3e3f403f51aba4adc7eaf9f8eaddf0f2ede7c19bafa0503c414a433f5ad05558883a5863a1b499634646a5447bdf383952d8ac6958653ea1b2414750b3dba3404245cf7a3b61516c45729bd0bba5a1dfa0716075d4e4cd625b79a0cb939db9c8434765cf896dcfdcd3dcd6dad7d7d7d6c9d5d0dcb2599eb24654c6d8d35ac3e05245484a494c4d4c4b485edaa66ff3e3454863b19082cbce4a47434144474a4b46442fd0cd9693a243446a5c4c91d99a4548494647495d7c444241aad165455643454d435dbfd96a46494c494a52af8242424484d3a74f4f49766a415ec6c350474b4b456b92da6345494c6dcecc445149776a4671cbab4248484568bcc8d6515b565062bace684f48504c4ea8ca9649474545bfb89d9f6a955a4e52a1c6984f48484952cbbc814e474583c651a2a7aba0514c4890b3c64c45464889c2ad6a4c465e9e5664b4bbbb805c514e84adb783' },
	{ key: 'zhanfang_bright', type: '绽放', size: 24, data: '42355950288b786384a0d3d6cfddcfa2876070a02d384a2f4a3dca9a334eb1e3f5d6ac8f8891add6fae5b4502374d03f47425238aef2face5639282752342b3b61c8faf3b7555d40c05048b6fbd0722e25253a89f9af3c27252c6cd3fac74c3e9d44b4f4af3e29262540c4f8addccd672525274cb0f6b85331adfaac412a272528ccdd863467e4db262627283da8f2b27dfac4342e30433f43f1a32e262d8fe6573c442f2d38baf8ceeb694274d9e4edcde46e26262741cac9eaeaca8b4173e4e6934db6dab77b7ab0de68271d2755dab38282aed6b45492ea4d45c4c0322625338fa853cf4595b3392c2c358fcf4f50bd343eb8c12626252634acc9bbc6b2422b2a29268bca4b23832e35a4e24f292a29509b712782b55b2d2b293bd8ba3d28682f2e7ad9a54f216aba968a4199a6bb67353f99e49c332a642f2d2f7bcfe6d7db45306fd7762f3cdad5d6da92392b2a632f2f3885c6b16d9d96659dc1a2637b9e61a5cca8472b296a2f3288cc85392b4387a5832c98a890392c356dd5962d29962f3eabab4b2b2a2b2b81702d988d312b2b2c2bbab43f29bd2540afa32c2e2d2d40bcc7bbbbbb412a2c2c297abe453fd06244b8ba5f44374aa08952943260b342393848a3bd4d5fbcb6578bc1c8ac8aadbe682c2e2d3eb5c19a98c2c0876ca399bf8a3f5f7aafbea2b2642b2d324cb189b5b87b5d3c83ce54b8b67a4e41453b4abc9e462d3b88c73e3639353c68bec2627fb3a3674033373d96bc854483bc9c3f342e3563acb16eb65880b6ac80423d484a83b59cbb8d4f493c347ab7ba7849' },
];

function decodeTemplate(raw: RawIconTemplate): IconTemplate {
	const size = raw.size;
	const gray = new Float32Array(size * size);
	for (let i = 0; i < gray.length; i++) {
		gray[i] = parseInt(raw.data.slice(i * 2, i * 2 + 2), 16) || 0;
	}
	let sum = 0;
	for (let i = 0; i < gray.length; i++) sum += gray[i];
	const mean = sum / gray.length;
	const centered = new Float32Array(gray.length);
	let ss = 0;
	for (let i = 0; i < gray.length; i++) {
		const d = gray[i] - mean;
		centered[i] = d;
		ss += d * d;
	}
	const normCentered = new Float32Array(gray.length);
	const invNorm = ss > 1e-9 ? 1 / Math.sqrt(ss) : 0;
	for (let i = 0; i < gray.length; i++) {
		normCentered[i] = centered[i] * invNorm;
	}
	// 12x12 隔行隔列下采样模板，用于粗搜排名；精搜仍使用完整 24x24
	const halfSize = size >> 1;
	const coarseLen = halfSize * halfSize;
	const coarseRaw = new Float32Array(coarseLen);
	let coarseSum = 0;
	let ci = 0;
	for (let y = 0; y < size; y += 2) {
		const row = y * size;
		for (let x = 0; x < size; x += 2) {
			const v = gray[row + x];
			coarseRaw[ci++] = v;
			coarseSum += v;
		}
	}
	const coarseMean = coarseSum / coarseLen;
	const coarseNormCentered = new Float32Array(coarseLen);
	let coarseSs = 0;
	for (let i = 0; i < coarseLen; i++) {
		const d = coarseRaw[i] - coarseMean;
		coarseNormCentered[i] = d;
		coarseSs += d * d;
	}
	const invCoarseNorm = coarseSs > 1e-9 ? 1 / Math.sqrt(coarseSs) : 0;
	for (let i = 0; i < coarseLen; i++) {
		coarseNormCentered[i] *= invCoarseNorm;
	}
	return { key: raw.key, type: raw.type, size, gray, normCentered, coarseNormCentered, mean, ss };
}

const ICON_TEMPLATES: IconTemplate[] = RAW_ICON_TEMPLATES.map(decodeTemplate);

/**
 * 宁息/绽放的“形状补充模板”。
 * 这两类目前没有小地图实机截图，先用 d6jue_map_now.png 玩法说明里的图例图标
 * 提取 24x24 灰度，再用梯度方向相关做补判。它只在 NCC 未命中时使用：
 * - 宁息/绽放的线条风格与图例不同，但轮廓方向一致，梯度方向相关不依赖颜色/明暗；
 * - 拿到实机小地图截图后，可把精确模板加到 RAW_ICON_TEMPLATES，形状补判会自动让位。
 */
const RAW_SHAPE_TEMPLATES: RawIconTemplate[] = [
	{ key: 'shape_ningxi', type: '宁息', size: 24, data: 'cccccccccccbc8bfb1a2a0a0a0a0a7b3bec8cbcccccccccccccccccbcac4bca596afc2c6c6c1ad95a4b8c3cacbccccccccccccc8c0b4b7a19a928ca9a387a397a2b1abb9c2c8c9cbccccccbea794807b779e97b1a4978a6b7276909eb3c2c2c5cbcccab3abcba087777075807c74717586a0cb9db2c0c0c2c8c6bca693d1dcdbd7c3b6b5b7b7c5d9dddbcf8fadbdc0c1c1b6a4927386a1b1c8d0dbd9dadad0caafa18d7d9cabb8c0b7a5abb581724e86905d70d5cc765e8481567487c0b2aabfb3a48a94c3bdb1c6b28995d6d19a8eb2ccb8bdc49794b2c4b4ad8e9cc063abcfafadb3b5b4b3acacd0a97ec1929bbdc6b4b29bb4c886b7c4627a827973737066c0b393c4aaa8c1c5b4b0a3a2726ecbaf7ca6ab958da08e74b0c3706f9ea6bbc4b4a99d8c63aec38d89a788879fab82818dc09c639ba5b7c3b5a8a08b64b5b781948d85b7c38873857cbeb168a1a1b4c3b5abab817cb6b1769288bca8b178898376b0ba748fb0b7c4b9b0a87992b8a2768fac9a75aca6958576a0b79384b5bec6bcb0a485a9b6858192ac649d90af988e808fb0a58dacbcc5bcaf9ba5acac788a868874757797728c8a7daaadb09fbac6bcb69599aa9e5d6d745f5a54614e5b786d59a1a890a0bfc6bbbaac8496a06679a4a1a1a19f9ea2a77167a3918bb5c3c5bbbbba997b98a5a19f9e9e9e9f9ea0a0a1a5967ea5bec1c5bbbbbbb59e81859e9b989a9b9b9a999f9e8b8ba5babfc2c5bdbcbcbcbab5a5907b787c7f7e7d7a839db2c0c1bfc1c5c6bdbec0bfbcbbbab5ab9f9e9c9a9fa7b7c1c5c6c3c0c0c1c2' },
	{ key: 'shape_zhanfang', type: '绽放', size: 24, data: 'bdb6b6b5b5b5b3b2b0ab9f9297aaacafb2b7b9b8bbb0a0a3b8b6b6b5b4b2aa9f988b837683878a8f9eaab4b4aba3a5b1b5b7b7b5afa49386787f916fa1719f7b808b95989fadb7b8b5b5b4b09f8b718f817391a8a8a59171908372819db4b7b8b5b4af9e86947483bccab6a59ca7bfc8ad6f828c89a6b3b7b6b3a18c806aa6d2ab826b7694706d88b9ca91688a8aa7b6b5a98a8087a7d28b727185d4c3c6746b76a8d4899c7d98b1b095886991ce796d7479ce9366a9b97378709ed0767386a2ab889580c1977aacc2bfbe5e7076c7bbc19e79b3a7848c94a2836895b376c7a37e95bc667c7cbe8f8bb8a97acf75748a98997cad906ac3736f6e89aea1a7807f7c8aaf6dbd8c9687946e65be7962c69470759a9868b78c7777b1ac6c99a96b7f8a9e78b76e647ac1a2a37d7fa07896a0abb97b7084ae798286756ab46d688db88d92988f948a9b9096b67d6383a86e79877767b07f6dbd8d7c7d7d956fa2757f6f9b9f5c9e956c798988699d946fb8727978879898967a716780a162b977898494726980a872aba58898ab5f686bb58b84a8947eb7676d879a8299729e9367879b95a5616971ab939a7f6dad838285989f98826975af84636469a98c689e966a6d6a9ca2687388a8a49c85897575b28d666266a4a595696e759ca06e97799cb3a5a0927963676da5a37963607762718fad906966788daab7a5a39f9077815a5778939ea195a2a4977b667c8193abb5b8a8a3a29d907c69885e676b6769647361837b8095abb7b8b8b6ada4a19e968577677b706f895d866a73859eafb7b9b9b9' },
];

interface ShapeTemplate {
	key: string;
	type: D6MapNodeType;
	size: number;
	gx: Float32Array;
	gy: Float32Array;
	mag: Float32Array;
}

interface GradientField {
	gx: Float32Array;
	gy: Float32Array;
	mag: Float32Array;
}

function buildGradientField(gray: Float32Array, size: number): GradientField {
	const gx = new Float32Array(size * size);
	const gy = new Float32Array(size * size);
	const mag = new Float32Array(size * size);
	for (let y = 1; y < size - 1; y++) {
		for (let x = 1; x < size - 1; x++) {
			const i = y * size + x;
			gx[i] = (gray[i - size + 1] + 2 * gray[i + 1] + gray[i + size + 1])
				- (gray[i - size - 1] + 2 * gray[i - 1] + gray[i + size - 1]);
			gy[i] = (gray[i + size - 1] + 2 * gray[i + size] + gray[i + size + 1])
				- (gray[i - size - 1] + 2 * gray[i - size] + gray[i - size + 1]);
			mag[i] = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
		}
	}
	return { gx, gy, mag };
}

function buildShapeTemplate(raw: RawIconTemplate): ShapeTemplate {
	const size = raw.size;
	const gray = new Float32Array(size * size);
	for (let i = 0; i < gray.length; i++) {
		gray[i] = parseInt(raw.data.slice(i * 2, i * 2 + 2), 16) || 0;
	}
	const field = buildGradientField(gray, size);
	return { key: raw.key, type: raw.type, size, gx: field.gx, gy: field.gy, mag: field.mag };
}

const SHAPE_TEMPLATES: ShapeTemplate[] = RAW_SHAPE_TEMPLATES.map(buildShapeTemplate);

interface DevImage {
	/** 区域宽高（开发坐标） */
	w: number;
	h: number;
	/** 重采样后的 RGBA 区域；与开发尺寸一致时直接复用原缓冲 */
	rgba: Uint8ClampedArray | Uint8Array | number[];
}

interface LocalGrayPatch {
	/** 局部块左上角在开发局部坐标（相对 D6_MINIMAP_DEV_REGION）中的起点 */
	x0: number;
	y0: number;
	w: number;
	h: number;
	gray: Float32Array;
}

/**
 * 把设备截图裁剪区重采样成开发坐标区域。
 * 设备分辨率可能是 1280x720、1920x1080 等，统一按开发坐标计算，
 * 模板和列坐标无需随分辨率修改。
 *
 * 性能：
 * - 1280x720 下裁剪区本身就是 211x236，直接复用原缓冲，免掉 5 万像素拷贝；
 * - 全图不再预计算灰度，只对最终选中的 1~4 个亮节点按需提取 30x30 局部灰度。
 */
function buildDevImage(image: D6MapImageData): DevImage | null {
	const w = REGION_W;
	const h = REGION_H;
	const sw = image.width;
	const sh = image.height;
	if (!sw || !sh) return null;
	const data = image.data;
	if (sw === w && sh === h) {
		return { w, h, rgba: data };
	}
	const rgba = new Uint8Array(w * h * 4);
	const sxMap = new Int32Array(w);
	for (let x = 0; x < w; x++) {
		let sx = Math.floor((x + 0.5) * sw / w);
		if (sx >= sw) sx = sw - 1;
		sxMap[x] = sx * 4;
	}
	let di = 0;
	for (let y = 0; y < h; y++) {
		let sy = Math.floor((y + 0.5) * sh / h);
		if (sy >= sh) sy = sh - 1;
		const rowOffset = sy * sw * 4;
		for (let x = 0; x < w; x++) {
			const si = rowOffset + sxMap[x];
			rgba[di] = data[si] || 0;
			rgba[di + 1] = data[si + 1] || 0;
			rgba[di + 2] = data[si + 2] || 0;
			rgba[di + 3] = 255;
			di += 4;
		}
	}
	return { w, h, rgba };
}

function localIndexX(devX: number): number {
	return devX - D6_MINIMAP_DEV_REGION.x0;
}

function localIndexY(devY: number): number {
	return devY - D6_MINIMAP_DEV_REGION.y0;
}

interface GoldIntegral {
	data: Int32Array;
	w: number;
	h: number;
}

/** 金色像素积分图，用于 O(1) 查询任意位置 26x26 的金色像素数（行累加 + 内联判定） */
function buildGoldIntegral(img: DevImage): GoldIntegral {
	const w = img.w;
	const h = img.h;
	const stride = w + 1;
	const data = new Int32Array(stride * (h + 1));
	const rgba = img.rgba;
	let pi = 0;
	for (let y = 0; y < h; y++) {
		const prevRow = y * stride;
		const curRow = prevRow + stride;
		let rowGold = 0;
		for (let x = 0; x < w; x++) {
			const r = rgba[pi];
			const g = rgba[pi + 1];
			const b = rgba[pi + 2];
			pi += 4;
			if (r > 85 && g > 65 && b < 205 && r - b > 18 && g - b > 8 && r >= g - 18) {
				rowGold++;
			}
			data[curRow + x + 1] = data[prevRow + x + 1] + rowGold;
		}
	}
	return { data, w, h };
}

/** 节点图标的金色像素平均/最大亮度，用于判断“亮色=可进入 / 暗色=不可进入” */
function nodeBrightness(
	img: DevImage,
	devX: number,
	devY: number,
	radius = 11,
): { gold: number; mean: number } {
	const cx = localIndexX(devX);
	const cy = localIndexY(devY);
	const yStart = cy - radius < 0 ? 0 : cy - radius;
	const yEnd = cy + radius >= img.h ? img.h - 1 : cy + radius;
	const xStart = cx - radius < 0 ? 0 : cx - radius;
	const xEnd = cx + radius >= img.w ? img.w - 1 : cx + radius;
	const rgba = img.rgba;
	const w = img.w;
	let gold = 0;
	let sum = 0;
	for (let y = yStart; y <= yEnd; y++) {
		let i = (y * w + xStart) * 4;
		for (let x = xStart; x <= xEnd; x++) {
			const r = rgba[i];
			const g = rgba[i + 1];
			const b = rgba[i + 2];
			i += 4;
			if (r > 85 && g > 65 && b < 205 && r - b > 18 && g - b > 8 && r >= g - 18) {
				gold++;
				sum += 0.299 * r + 0.587 * g + 0.114 * b;
			}
		}
	}
	return { gold, mean: gold > 0 ? sum / gold : 0 };
}

/**
 * 金色像素重心：密度峰可能偏向图标的一侧（例如绽放的虚线边），
 * 用重心把模板搜索中心拉回图标中心附近，再叠加小幅搜索。
 */
function goldCentroid(img: DevImage, devX: number, devY: number, radius = 15): { x: number; y: number } {
	const cx = localIndexX(devX);
	const cy = localIndexY(devY);
	const yStart = cy - radius < 0 ? 0 : cy - radius;
	const yEnd = cy + radius >= img.h ? img.h - 1 : cy + radius;
	const xStart = cx - radius < 0 ? 0 : cx - radius;
	const xEnd = cx + radius >= img.w ? img.w - 1 : cx + radius;
	const rgba = img.rgba;
	const w = img.w;
	let n = 0;
	let sx = 0;
	let sy = 0;
	for (let y = yStart; y <= yEnd; y++) {
		let i = (y * w + xStart) * 4;
		for (let x = xStart; x <= xEnd; x++) {
			const r = rgba[i];
			const g = rgba[i + 1];
			const b = rgba[i + 2];
			i += 4;
			if (r > 85 && g > 65 && b < 205 && r - b > 18 && g - b > 8 && r >= g - 18) {
				n++;
				sx += x;
				sy += y;
			}
		}
	}
	if (n === 0) return { x: devX, y: devY };
	return { x: sx / n + D6_MINIMAP_DEV_REGION.x0, y: sy / n + D6_MINIMAP_DEV_REGION.y0 };
}

/** 仅为单个候选节点提取局部灰度块（覆盖 24x24 模板与 ±3 搜索半径，约 30x30 像素） */
function buildNodeGrayPatch(img: DevImage, devCx: number, devCy: number, halfSpan = 15): LocalGrayPatch {
	const lcx = localIndexX(devCx);
	const lcy = localIndexY(devCy);
	const x0 = Math.max(0, lcx - halfSpan);
	const y0 = Math.max(0, lcy - halfSpan);
	const x1 = Math.min(img.w, lcx + halfSpan);
	const y1 = Math.min(img.h, lcy + halfSpan);
	const pw = Math.max(0, x1 - x0);
	const ph = Math.max(0, y1 - y0);
	const gray = new Float32Array(pw * ph);
	const rgba = img.rgba;
	const iw = img.w;
	let di = 0;
	for (let y = y0; y < y1; y++) {
		let si = (y * iw + x0) * 4;
		for (let x = x0; x < x1; x++) {
			gray[di++] = 0.299 * rgba[si] + 0.587 * rgba[si + 1] + 0.114 * rgba[si + 2];
			si += 4;
		}
	}
	return { x0, y0, w: pw, h: ph, gray };
}

/** 粗搜用隔行隔列单遍 NCC（12x12 = 144 像素，计算量为 24x24 的 1/4） */
function nccScorePatchCoarse(patch: LocalGrayPatch, tpl: IconTemplate, cx: number, cy: number): number {
	const size = tpl.size;
	const half = size >> 1;
	const ox = localIndexX(cx) - half - patch.x0;
	const oy = localIndexY(cy) - half - patch.y0;
	if (ox < 0 || oy < 0 || ox + size > patch.w || oy + size > patch.h) return -2;
	const gray = patch.gray;
	const pw = patch.w;
	const tnorm = tpl.coarseNormCentered;
	const count = half * half;
	let sum = 0;
	let sumSq = 0;
	let cov = 0;
	let ti = 0;
	for (let y = 0; y < size; y += 2) {
		let gi = (oy + y) * pw + ox;
		for (let x = 0; x < size; x += 2) {
			const v = gray[gi];
			gi += 2;
			sum += v;
			sumSq += v * v;
			cov += v * tnorm[ti++];
		}
	}
	const ss = sumSq - (sum * sum) / count;
	return ss > 1e-9 ? cov / Math.sqrt(ss) : -2;
}

/** 单遍归一化互相关（NCC）：模板已零均值且单位化，一次循环同时求 sum / sumSq / cov */
function nccScorePatch(patch: LocalGrayPatch, tpl: IconTemplate, cx: number, cy: number): number {
	const size = tpl.size;
	const half = size >> 1;
	const ox = localIndexX(cx) - half - patch.x0;
	const oy = localIndexY(cy) - half - patch.y0;
	if (ox < 0 || oy < 0 || ox + size > patch.w || oy + size > patch.h) return -2;
	const gray = patch.gray;
	const pw = patch.w;
	const tnorm = tpl.normCentered;
	let sum = 0;
	let sumSq = 0;
	let cov = 0;
	let ti = 0;
	for (let y = 0; y < size; y++) {
		let gi = (oy + y) * pw + ox;
		for (let x = 0; x < size; x++) {
			const v = gray[gi++];
			sum += v;
			sumSq += v * v;
			cov += v * tnorm[ti++];
		}
	}
	const ss = sumSq - (sum * sum) / (size * size);
	return ss > 1e-9 ? cov / Math.sqrt(ss) : -2;
}

function buildPatchGradient(img: DevImage, cx: number, cy: number, size: number): GradientField | null {
	const half = size >> 1;
	const ox = localIndexX(cx) - half;
	const oy = localIndexY(cy) - half;
	if (ox < 0 || oy < 0 || ox + size > img.w || oy + size > img.h) return null;
	const gray = new Float32Array(size * size);
	const rgba = img.rgba;
	const iw = img.w;
	let di = 0;
	for (let y = 0; y < size; y++) {
		let si = ((oy + y) * iw + ox) * 4;
		for (let x = 0; x < size; x++) {
			gray[di++] = 0.299 * rgba[si] + 0.587 * rgba[si + 1] + 0.114 * rgba[si + 2];
			si += 4;
		}
	}
	return buildGradientField(gray, size);
}

/**
 * 梯度方向相关：只比较边缘方向，不比较颜色/明暗，因此图例图标（深色线条+浅色底）
 * 和小地图图标（金色线条+深色底）可以互相比对。
 */
function orientationScore(
	patch: GradientField,
	tpl: ShapeTemplate,
	dx: number,
	dy: number,
): { score: number; coverage: number } {
	const size = tpl.size;
	let num = 0;
	let den1 = 0;
	let den2 = 0;
	let templateEdges = 0;
	let matchedEdges = 0;
	for (let y = 2; y < size - 2; y++) {
		for (let x = 2; x < size - 2; x++) {
			const tx = x + dx;
			const ty = y + dy;
			if (tx < 2 || ty < 2 || tx >= size - 2 || ty >= size - 2) continue;
			const i = y * size + x;
			const j = ty * size + tx;
			const mb = tpl.mag[j];
			if (mb < 20) continue;
			templateEdges++;
			const ma = patch.mag[i];
			if (ma < 20) continue;
			matchedEdges++;
			const dot = patch.gx[i] * tpl.gx[j] + patch.gy[i] * tpl.gy[j];
			const cross = patch.gx[i] * tpl.gy[j] - patch.gy[i] * tpl.gx[j];
			// cos(2Δθ) = (dot² - cross²) / (|a|²|b|²)，对梯度正负不敏感
			const c2 = (dot * dot - cross * cross) / (ma * ma * mb * mb);
			num += ma * mb * c2;
			den1 += ma * ma;
			den2 += mb * mb;
		}
	}
	const denom = Math.sqrt(den1 * den2);
	return {
		score: denom > 1e-9 ? num / denom : -2,
		coverage: templateEdges > 0 ? matchedEdges / templateEdges : 0,
	};
}

/**
 * NCC 未命中时，用图例形状模板补判宁息/绽放。
 * 分数、模板边缘覆盖率、两者分差任一不满足都返回 null，保持 unknown。
 */
function classifyUnknownShape(
	img: DevImage,
	cx: number,
	cy: number,
): { type: D6MapNodeType; score: number; template: string } | null {
	const size = SHAPE_TEMPLATES[0].size;
	const patch = buildPatchGradient(img, cx, cy, size);
	if (!patch) return null;
	let best: { type: D6MapNodeType; score: number; coverage: number; template: string } | null = null;
	let secondScore = -2;
	for (let i = 0; i < SHAPE_TEMPLATES.length; i++) {
		const tpl = SHAPE_TEMPLATES[i];
		let score = -2;
		let coverage = 0;
		for (let dy = -3; dy <= 3; dy++) {
			for (let dx = -3; dx <= 3; dx++) {
				const result = orientationScore(patch, tpl, dx, dy);
				if (result.score > score) {
					score = result.score;
					coverage = result.coverage;
				}
			}
		}
		if (!best || score > best.score) {
			if (best) secondScore = best.score;
			best = { type: tpl.type, score, coverage, template: tpl.key };
		} else if (score > secondScore) {
			secondScore = score;
		}
	}
	if (
		best
		&& best.coverage >= SHAPE_MIN_COVERAGE
		&& best.score >= SHAPE_MIN_SCORE
		&& best.score - secondScore >= SHAPE_MIN_MARGIN
	) {
		return { type: best.type, score: best.score, template: best.template };
	}
	return null;
}

/**
 * 定位针：小地图中唯一的亮黄色指针，位于当前节点图标正上方。
 * 只取面积最大的黄色连通块，避免把下方当前节点图标或文字算进来。
 */
function findPin(img: DevImage): D6MapPin | null {
	const x0 = 1060;
	const x1 = 1270;
	// 下一行图标底部可能伸到 y≈150，从 152 开始扫描，避免把亮金图标误当定位针
	const y0 = 152;
	const y1 = 225;
	const w = x1 - x0 + 1;
	const h = y1 - y0 + 1;
	const lx0 = x0 - D6_MINIMAP_DEV_REGION.x0;
	const ly0 = y0 - D6_MINIMAP_DEV_REGION.y0;
	const mask = new Uint8Array(w * h);
	const rgba = img.rgba;
	const iw = img.w;
	let pinPixels = 0;
	for (let y = 0; y < h; y++) {
		let si = ((ly0 + y) * iw + lx0) * 4;
		const rowOff = y * w;
		for (let x = 0; x < w; x++) {
			const r = rgba[si];
			const g = rgba[si + 1];
			const b = rgba[si + 2];
			si += 4;
			if (r > 205 && g > 160 && b < 210 && r - b > 45 && g - b > 25) {
				mask[rowOff + x] = 1;
				pinPixels++;
			}
		}
	}
	if (pinPixels < 40) return null;
	const seen = new Uint8Array(w * h);
	let best: { n: number; sx: number; sy: number } | null = null;
	const queue = new Int32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const start = y * w + x;
			if (!mask[start] || seen[start]) continue;
			let head = 0;
			let tail = 0;
			let n = 0;
			let sx = 0;
			let sy = 0;
			queue[tail++] = start;
			seen[start] = 1;
			while (head < tail) {
				const cur = queue[head++];
				const cx = cur % w;
				const cy = (cur / w) | 0;
				n++;
				sx += cx;
				sy += cy;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = cx + dx;
						const ny = cy + dy;
						if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
						const idx = ny * w + nx;
						if (mask[idx] && !seen[idx]) {
							seen[idx] = 1;
							queue[tail++] = idx;
						}
					}
				}
			}
			if (!best || n > best.n) best = { n, sx, sy };
		}
	}
	if (!best || best.n < 40) return null;
	const px = best.sx / best.n + x0;
	const py = best.sy / best.n + y0;
	return { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10 };
}

/**
 * 扫描小地图，只返回“当前可选（亮色）”的节点。
 *
 * 性能优化（Rhino 上循环与函数调用都很贵）：
 * 1. 内联金色积分图查询找候选，步长 2；
 * 2. 先算每个候选的平均亮度，只保留亮色（可进入）节点；
 * 3. 亮色节点按行分组，只取最上面一排（当前节点徽记在下方）；
 * 4. 仅对这一排按需提取 30×30 局部灰度并做单遍 NCC：
 *    先对每个模板做 3×3 粗搜（-3/0/3）排名；若第一名高置信且领先明显，
 *    只对第一名在最佳粗搜点周围 ±2 精搜；否则对前两名做完整 ±3 精搜（跳过已算粗搜点）。
 */
function detectNodes(img: DevImage): D6MapNode[] {
	const ii = buildGoldIntegral(img);
	const iiData = ii.data;
	const iw = ii.w;
	const ih = ii.h;
	const stride = iw + 1;
	const x0 = D6_MINIMAP_DEV_REGION.x0;
	const y0 = D6_MINIMAP_DEV_REGION.y0;
	const lyMax = ih - 21;
	const lxMax = iw - 11;
	const candidates: { x: number; y: number; gold: number }[] = [];
	for (let ly = 20; ly <= lyMax; ly += 2) {
		const gy0 = ly > 13 ? ly - 13 : 0;
		const gy1 = gy0 + 26 < ih ? gy0 + 26 : ih;
		const rowTop = gy0 * stride;
		const rowBot = gy1 * stride;
		for (let lx = 10; lx <= lxMax; lx += 2) {
			const gx0 = lx > 13 ? lx - 13 : 0;
			const gx1 = gx0 + 26 < iw ? gx0 + 26 : iw;
			const gold = iiData[rowBot + gx1] - iiData[rowTop + gx1] - iiData[rowBot + gx0] + iiData[rowTop + gx0];
			if (gold >= CANDIDATE_MIN_GOLD) candidates.push({ x: x0 + lx, y: y0 + ly, gold });
		}
	}
	candidates.sort((a, b) => b.gold - a.gold);
	const picked: { x: number; y: number; gold: number }[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		let overlap = false;
		for (let j = 0; j < picked.length; j++) {
			const p = picked[j];
			if (Math.abs(p.x - c.x) <= CANDIDATE_NMS_RADIUS && Math.abs(p.y - c.y) <= CANDIDATE_NMS_RADIUS) {
				overlap = true;
				break;
			}
		}
		if (!overlap) picked.push(c);
	}

	interface Candidate {
		cx: number;
		cy: number;
		gold: number;
		meanLum: number;
	}
	const all: Candidate[] = [];
	for (let i = 0; i < picked.length; i++) {
		const c = picked[i];
		const center = goldCentroid(img, c.x, c.y);
		const ccx = Math.round(center.x);
		const ccy = Math.round(center.y);
		const lum = nodeBrightness(img, ccx, ccy);
		if (lum.gold < 40) continue;
		all.push({ cx: ccx, cy: ccy, gold: c.gold, meanLum: lum.mean });
	}
	if (all.length === 0) return [];

	// 亮/暗阈值：按所有候选的平均亮度分布自适应
	const means = all.map(n => n.meanLum).sort((a, b) => a - b);
	let brightThreshold = BRIGHT_MEAN_DEFAULT;
	let bestGap = 0;
	for (let i = 1; i < means.length; i++) {
		const gap = means[i] - means[i - 1];
		if (gap > bestGap) {
			bestGap = gap;
			brightThreshold = (means[i] + means[i - 1]) / 2;
		}
	}
	if (bestGap >= BRIGHT_GAP_MIN) {
		brightThreshold = Math.max(BRIGHT_MEAN_MIN, Math.min(BRIGHT_MEAN_MAX, brightThreshold));
	} else {
		brightThreshold = BRIGHT_MEAN_DEFAULT;
	}
	const bright = all.filter(n => n.meanLum >= brightThreshold);
	if (bright.length === 0) return [];

	// 亮色节点分行，只取最上面一排（下一层可选节点）
	const rows: { y: number; items: Candidate[] }[] = [];
	for (let i = 0; i < bright.length; i++) {
		const n = bright[i];
		let row = rows.filter(r => Math.abs(r.y - n.cy) <= 18)[0];
		if (!row) {
			row = { y: n.cy, items: [] };
			rows.push(row);
		}
		row.y = (row.y * row.items.length + n.cy) / (row.items.length + 1);
		row.items.push(n);
	}
	rows.sort((a, b) => a.y - b.y);
	const choiceRow = rows[0];
	choiceRow.items.sort((a, b) => a.cx - b.cx);

	// 只对这一排做局部灰度提取 + 亮色模板单遍 NCC
	const templates = ICON_TEMPLATES;
	const nodes: D6MapNode[] = [];
	// 偏移 -2/0/2 距 [-3..+3] 内任意整数点都不超过 1px，既覆盖中心 (0,0) 又避免 ±3 跨度过大漏峰
	const coarseOffsets = [-2, 0, 2];
	for (let k = 0; k < choiceRow.items.length; k++) {
		const c = choiceRow.items[k];
		const patch = buildNodeGrayPatch(img, c.cx, c.cy, 15);
		const coarseRanked: { score: number; ox: number; oy: number; template: IconTemplate }[] = [];
		for (let t = 0; t < templates.length; t++) {
			const tpl = templates[t];
			let coarseScore = -2;
			let bestOx = 0;
			let bestOy = 0;
			for (let oy = 0; oy < coarseOffsets.length; oy++) {
				const dy = coarseOffsets[oy];
				for (let ox = 0; ox < coarseOffsets.length; ox++) {
					const dx = coarseOffsets[ox];
					const score = nccScorePatchCoarse(patch, tpl, c.cx + dx, c.cy + dy);
					if (score > coarseScore) {
						coarseScore = score;
						bestOx = dx;
						bestOy = dy;
					}
				}
			}
			coarseRanked.push({ score: coarseScore, ox: bestOx, oy: bestOy, template: tpl });
		}
		coarseRanked.sort((a, b) => b.score - a.score);
		const top0 = coarseRanked[0];
		let best: { score: number; template: IconTemplate; x: number; y: number } = {
			score: -2,
			template: top0.template,
			x: c.cx,
			y: c.cy,
		};
		// 先在第一名最佳粗搜点周围 ±1（最多 9 点）做完整 24x24 精搜；
		// 若已达到高置信 (>=0.90)，直接结束，省掉其余偏移与第二名模板的全量精搜。
		const fMinDy = Math.max(-3, top0.oy - 1);
		const fMaxDy = Math.min(3, top0.oy + 1);
		const fMinDx = Math.max(-3, top0.ox - 1);
		const fMaxDx = Math.min(3, top0.ox + 1);
		for (let dy = fMinDy; dy <= fMaxDy; dy++) {
			for (let dx = fMinDx; dx <= fMaxDx; dx++) {
				const score = nccScorePatch(patch, top0.template, c.cx + dx, c.cy + dy);
				if (score > best.score) {
					best = { score, template: top0.template, x: c.cx + dx, y: c.cy + dy };
				}
			}
		}
		if (best.score < 0.90) {
			const refineCount = Math.min(2, coarseRanked.length);
			for (let r = 0; r < refineCount; r++) {
				const tpl = coarseRanked[r].template;
				const skipFastBox = r === 0;
				for (let dy = -3; dy <= 3; dy++) {
					for (let dx = -3; dx <= 3; dx++) {
						if (skipFastBox && dy >= fMinDy && dy <= fMaxDy && dx >= fMinDx && dx <= fMaxDx) continue;
						const score = nccScorePatch(patch, tpl, c.cx + dx, c.cy + dy);
						if (score > best.score) {
							best = { score, template: tpl, x: c.cx + dx, y: c.cy + dy };
						}
					}
				}
				if (best.score >= 0.90) break;
			}
		}
		let type: D6MapNodeType = best.score >= TYPE_MIN_SCORE ? best.template.type : 'unknown';
		let template = best.template.key;
		let shapeScore = 0;
		let nodeX = best.x;
		let nodeY = best.y;
		if (type === 'unknown') {
			const shape = classifyUnknownShape(img, c.cx, c.cy);
			if (shape) {
				type = shape.type;
				shapeScore = shape.score;
				template = shape.template;
				nodeX = c.cx;
				nodeY = c.cy;
			}
		}
		nodes.push({
			col: k,
			x: nodeX,
			y: nodeY,
			type,
			score: best.score,
			gold: c.gold,
			template,
			shapeScore,
			bright: true,
			meanLum: c.meanLum,
		});
	}
	return nodes;
}

/**
 * 识别小地图并返回当前可进入的下一层节点。
 * 返回 null 表示没有识别到亮色可选节点。
 */
export function analyzeD6Map(image: D6MapImageData): D6MapState | null {
	if (!image || !image.data) return null;
	const img = buildDevImage(image);
	if (!img) return null;
	const nodes = detectNodes(img);
	if (nodes.length === 0) return null;
	// 定位针只用于“只有一个亮节点”时避免误点当前节点；多节点时不需要扫描
	const pin = nodes.length === 1 ? findPin(img) : null;
	// 只有当前节点亮着（没有下一层可选节点）时不要误点当前节点
	if (pin && nodes.length === 1 && Math.abs(nodes[0].y - (pin.y + 17)) <= 14) return null;
	const nextRowY = Math.round(nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length);
	return {
		pin: pin || null,
		nextRowY,
		nodes,
		reachable: nodes.slice(),
	};
}

function slotFor(count: number, index: number): D6MapSlot | null {
	if (count === 1) return 'single';
	if (count === 2) return index === 0 ? 'two-left' : index === 1 ? 'two-right' : null;
	if (count === 3) return (['three-left', 'three-center', 'three-right'] as D6MapSlot[])[index] || null;
	if (count === 4) return (['four-1', 'four-2', 'four-3', 'four-4'] as D6MapSlot[])[index] || null;
	return null;
}

/**
 * 按优先级从可达节点中选目标，并换算成主地图固定选择位。
 * priority 未定义的节点类型按 0 处理。
 */
export function pickD6MapChoice(
	state: D6MapState,
	priority: { [key: string]: number },
): D6MapChoice | null {
	if (!state || state.reachable.length === 0) return null;
	const ordered = state.reachable.slice().sort((a, b) => a.x - b.x);
	if (ordered.length > 4) return null; // 主地图最多 4 个选择位，宁可等待也不乱点
	let target = ordered[0];
	for (let i = 1; i < ordered.length; i++) {
		const node = ordered[i];
		const p = priority[node.type] || 0;
		const tp = priority[target.type] || 0;
		if (p > tp || (p === tp && node.score > target.score + 1e-9)) {
			target = node;
		}
	}
	const index = ordered.indexOf(target);
	const count = ordered.length;
	const slot = slotFor(count, index);
	if (!slot) return null;
	return { target, index, count, slot };
}

/** 选择位在 323 operator[53].oper 中的下标 */
export function d6MapSlotIndex(slot: D6MapSlot): number {
	return D6_MAP_SLOTS.indexOf(slot);
}

/** 日志用：行内序号 */
export function d6MapColName(col: number): string {
	return ['左', '中', '右'][col] || `第${col + 1}位`;
}

let warmUpDone = false;

/**
 * 预热小地图识别。
 *
 * Rhino 首次调用 analyzeD6Map 时才编译 buildDevImage / detectNodes /
 * buildGoldIntegral / nccScore / findPin 等函数，首帧会明显慢于后续识别。
 * 这里用一张合成的 211x236 小地图（深色背景 + 一个亮金色方块）提前跑一遍，
 * 把编译成本挪到脚本启动阶段；正式识别仍使用真实截图。
 *
 * 纯像素计算，不依赖 Auto.js，可安全在模块内调用。
 */
export function warmUpD6Map(): void {
	if (warmUpDone) return;
	warmUpDone = true;
	const t0 = new Date().getTime();
	const w = REGION_W;
	const h = REGION_H;
	const data = new Uint8ClampedArray(w * h * 4);
	const size = 24;
	const cx = Math.floor(w / 2);
	const cy = 60;
	for (let y = cy - size / 2; y < cy + size / 2; y++) {
		for (let x = cx - size / 2; x < cx + size / 2; x++) {
			const i = (y * w + x) * 4;
			data[i] = 220;
			data[i + 1] = 180;
			data[i + 2] = 40;
			data[i + 3] = 255;
		}
	}
	const image: D6MapImageData = { width: w, height: h, data };
	try {
		// 跑两遍：第一遍触发函数编译，第二遍让热点循环进入优化
		analyzeD6Map(image);
		analyzeD6Map(image);
	} catch (e) {
		// 预热失败不影响正式识别
	}
	console.log(`[d6jue-map] warmup ${new Date().getTime() - t0}ms`);
}
