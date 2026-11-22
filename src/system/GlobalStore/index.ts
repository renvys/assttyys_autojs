export type globalRootType = {
	currentNotifyDate: null | Date,
	app_is_open_flag: boolean,
	checked_yard_count: number,
	checked_yard_count_999: number,
	currentRunTimes: Record<string, number>,
	running: boolean,
	define_run_time: number,
	define_pause_time: number,
	runningTime: number,
	pauseTime: number,
	notifyTime: number,
	back: boolean, // 返回庭院的开关,true为开启,false为关闭.默认为:true(开启)
	back_time: number, // 记录返回庭院的点击次数
	tp_swipe_times: number,
	tsAttackSwhipeNum: number,
	dgCurNum: number,
	currentChatEnd: number,
	greenPosition: number[] | null,
	greenTagEnd: number,
	greenNonDTime: number,
	d6LoadBuff: boolean | null,
	d6LoadedBuff: boolean | null
	d6d: Record<string, number[]>,
	d6RefreshCnt: number,
	d6dCurrentBegin: number,
	d6dBegin: number,
	times: number,
	d6NxFilter: string[],
	d6NextStation: string,
	d6NxRefreshCnt: number,
	d6NextEvent: string[],
	jy_list_swipe_times: number,
	jy_list_getTime_fault_count: number,
	jy_friends_enchantment_waitingtime: number,
	jy_enchantment_index: number,
	jy_change_shikigami: 'change' | 'get_reward' | 'change_enchantment' | 'jy_flag',   //  寄养_是否更换养成式神(狗粮)  更换式神 | 获取奖励 | 更换结界卡 | 寄养
	jy_experience_wine_pot_count: number,   //  寄养获取经验酒壶次数
	jy_enchantment_experience_count: number,   //  寄养获取结界卡奖励次数
	back_courtyard_to_next_scheme: string,
	fm_kiss_boss_flag: boolean, //  逢魔 是否已击杀首领
	fm_boss_btn_click_cnt: number, // 点击逢魔首领按钮次数
	change_shikigami_flag: boolean, //  更换式神
	change_shikigami_state: 'flushed' | 'search_group' | 'search_default' | 'change_team_default_1' | 'change_team_default_2' | 'finish' | 'second_groud' | 'second_default_1' | 'second_default_2', //  跟换式神预设状态值
	change_shikigami_list_swipe_times: number,
	change_shikigami_last_group_name: string,   //  式神录预设分组最后一项的名称
	narrow_state: Record<string, boolean>,   //  狭间暗域状态
	narrow_time: number, // 狭间暗域自定义3D人物走路时等待时间
	narrow_mode: boolean,
	recruitCount?: number, // 招募点击计数
	recruitClickedY?: number[], // 招募已点击的Y坐标
	lastRecruitFinishTime?: number | null, // 招募完成点击的时间戳
	recruitHasScrolled?: boolean, // 是否已翻页
	liao_activity_page_flag: number,   //  寮活动翻页标记
	liao_activity_Switch: Record<string, boolean>, // 寮活动记录
	liao_banquet_collect: boolean,   //  宴会筹备状态
	liao_banquet_onGoing: boolean,   //  宴会进行状态
	banquet_change_flag: boolean,   //  宴会轮换开关标识
	gateOfHades_state: boolean,     //  阴门状态
	team_up_lagTime: null | Date,    // 组队延时
	team_up_Frist: boolean,  // 首次组队
	xsOpened: boolean, // 是否打开过悬赏
	xsXieZuo: boolean, // 开始协作
	intensify_lagTime: null | Date, // 强化延时
	intensify_NumOT: number, // 强化计数
	create_NumOT: number, // 创建队伍计数
	redFlag: boolean;   //  红标标识
	yl_next: number, // 言灵对弈下一个
	bgy_three: boolean; // 百鬼奕三胜
	bgy_ten: boolean; // 百鬼奕十次
	xxlLastLevel: number;
	buff_enable_page_flag: boolean; // 开启buff是否完成翻页
	team_up_Time: number;   // 被邀请的次数
	game_area: string;  //  游戏区域
	operate_finish_flag: boolean;  // 寄养完成操作flag
	preset_once_groupNum: number | null;     // 一次性修改的预设分组
	preset_once_defaultNum: number | null;     // 一次性修改的预设阵容
	preset_once_team_groupNum: number | null;     // 315预设阵容的预设分组
	preset_once_team_defaultNum: number | null;     // 315预设阵容的预设阵容
	qiling_Position: number[] | null;   //  契灵的地图位置
	qiling_last: number | null;     //  契灵的上次类型
	qiling_shop: boolean; // 契灵商店购买
	qiling_ball: number; // 已购买的契灵球次数
	opened_buff: boolean; // 是否已执行开启buff
	closed_buff: boolean; // 是否已执行关闭buff
	huahezhan: boolean;//    是否已领取花合战
	shangyushe: boolean;//    是否已上过预设
	d6Loop: number;//     椒图事件点击循环数
	d6RouFeng: number;//     椒图柔风实时buff数
	d6jueLoop: number;//     六道觉事件点击循环数
	d6jueStarted: boolean;// 六道觉是否已由脚本点击「开启」进入本局
	d6jueStartPrompted: boolean;// 六道觉未开启时是否已提示
	d6jueCantClear: boolean;// 六道觉本局已判定无法通关（T）
	d6jueCoreBuff: number;// 六道觉核心buff实时层数
	d6jueTimes: number;//    六道觉通关次数
	d6jueBegin: number;//    六道觉首次开始时间
	d6jueCurrentBegin: number;// 六道觉本局开始时间
	d6jueMapLogTime: number;// 六道觉小地图节点日志上次输出时间
	d6jueMapClickTime: number;// 六道觉主地图节点上次点击时间
	d6jueLastMapSig: string;// 六道觉上次点击时的节点行签名（防同一屏重复点击）
	d6jueLastMapSigTime: number;// 六道觉上次点击时的节点行签名时间
	d6jueBloomCheckpoint: number;// 六道觉已看到的绽放检查点（0=未到5，1=5，2=10，3=15）
	d6jueSkillCount: number;// 六道觉舞技强化次数
	d6jueLeiLevel: number;// 六道觉六道轰雷等级
	d6jueOtherBuffSelected: boolean;// 六道觉是否选择过其他buff（boss战前需卸载）
	d6juePowerLevel: number;// 六道觉力量等级，初始为0
	d6jueYaoLevel: number;// 六道觉妖力化身等级（不要到2级）
	d6jueBeishuiLevel: number;// 六道觉背水一战等级（不要到2级）
	d6jueChifenLevel: number;// 六道觉炽焚天火等级（需在轰雷后拿）
	d6jueShopRefresh: number;// 六道觉商店本次已刷新次数
	d6jueShopBuyPending: boolean;// 六道觉已点购买，等待确认结果
	d6jueShopBuyStage: number;// 六道觉购买阶段：1=等确认弹窗，2=已点确认等待校验
	d6jueShopBuyTime: number;// 六道觉购买阶段开始时间
	d6jueWanxiangling: number;// 六道觉万相铃计算（用于商店决策）
	d6jueWanxianglingPending: number;// 六道觉待结算万相铃
	d6jueStepLeft: number;// 六道觉剩余步数（孔雀国共20步）
	d6jueHuanxiShop: number;// 六道觉本局主动唤息找商店次数
	upYuHun: boolean;//      强化御魂记录界面次数
	upYuHunIni: boolean;//      强化御魂初设置
	bgyxLastCapture: number; // 上次截图的时间戳
	waitFight: boolean;//      等待分享鬼王被击杀
	faXian_NumOT: number, // 点击发现鬼王计数
	cgwDetailCnt: number, // 超鬼王鬼王详情页连点挑战计数
	youjiequyuan_ten: boolean;//      缘结趣游是否十抽
	dengluNumOT: number, // 登录账号计数
	dengluState: boolean, // 登录账号状态
	yaoqing_close: boolean, // 关闭_接受邀请
	frist_open: boolean, // 首次开启方案
	tongXinDui_ZhanDou: 'collect' | 'judge' | 'prestore' | 'juexing' | 'stage' | 'yuhun' | 'back';   // 同心队预存阶段
	daoGuan_swip: boolean, // 选寮往下滑
	daoGuan_compare: number[], // 选寮存储记录的值
	daoGuan_click: boolean, // 选寮点挑战
	daoGuan_exit: boolean, // 道馆退出突破
	daoGuan_again: boolean, // 道馆再次攻打是否攻打第二阵容
	daoguan_team: boolean, // 道馆是否切换队伍
	first_create_team: boolean, // 首次创建队伍
	open_only_once: boolean, // 首次启动游戏
	flash_time: number, // 519刷新次数
	fengNa: boolean, // 302奉纳
	xxxskill: number, // 寻香行技能
	MT_share: 'start' | 'back' | 'end', // 每周分享
	MT_share_type: 'mumu' | 'phone', // 每周分享_类型
	MT_liaoShop: 'start' | 'back' | 'end', // 寮商店购买
	MT_liaoShopList: string[], // 寮商店购买_未购买列表
	MT_shop: 'zhiBo' | 'jiShouWu' | 'miJuanWu' | 'zaHuoPu_teSu' | 'zaHuoPu_rongYu' | 'zaHuoPu_youQing' | 'zaHuoPu_xunZhang' | 'zaHuoPu_meiLi' | 'done', // 商店购买
	zhiBoBack: boolean, // 直播间返回
	shop_find: string[], // 商店购买_查找物品
	fengZi: boolean, // 风姿
	zhenLvJu: boolean, // 珍旅居
	shenKan: boolean, // 神龛
	zhenShe: number, // 真蛇
	miWenshare: boolean, // 秘闻分享
	diGuishare: boolean, // 地鬼分享
	shopShare: boolean, // 神秘商店分享
	shopSharenName: string[] | null, // 商店分享昵称
	sneak_level_open: boolean, // 选择层数
	day_chouKa: boolean, // 每日抽卡
	shiHe_jingYan: boolean, // 食盒经验领取上限
	xianShiFengMo: number,
	account_num: number, // 账号计数（用于点击位置）
	valid_account_num: number, // 有效账号计数（实际完成功能的账号数）
	account_double: boolean, // 安卓苹果双登录模式
	account_state: 'login' | 'function' | 'logout',
	function_Switch: Record<string, boolean | number>, // 小号功能记录
	loop_add: boolean, // 循环增加
	liao_cheak: number, // 寮活动判定
	email_yuHun: number, // 邮箱御魂已满计数
	runTime_2: number, // 留存2退出结算次数
	fight_Switch: Record<string, boolean | number>, // 战斗内操作记录
	xiaJian: Record<string, boolean | number>, // 狭间换御魂判断
	timestamp: number, // 全局时间戳
	paiMing: number, // 排名
	email_switch_enabled: boolean, // 邮箱切换
	tuDi: Record<string, boolean | number>, // 徒弟
	newAccount: Record<string, boolean | number>, // 新号
	frist: boolean, // 上阵式神
	chess: Record<string, boolean | number>,  // 下棋局数判定
	chessShop: boolean, // 下棋商店
	chessShopNum: number, // 下棋商店购买次数
	miWenChange: boolean, // 秘闻是否更换过式神
	shaoTiao: boolean, // 烧条
	miWenClearTimer: number, // 秘闻挑战清理状态次数
}

export const globalRoot: globalRootType = {
	currentNotifyDate: null,
	app_is_open_flag: true,
	checked_yard_count: 0,
	checked_yard_count_999: 0,
	currentRunTimes: {},
	running: undefined,
	define_run_time: 0,
	define_pause_time: 0,
	runningTime: 0,
	pauseTime: 0,
	notifyTime: 0,
	tp_swipe_times: 0,
	tsAttackSwhipeNum: undefined,
	dgCurNum: 0,
	currentChatEnd: undefined,
	greenPosition: null,
	greenTagEnd: undefined,
	greenNonDTime: 0,
	d6LoadBuff: undefined,
	d6LoadedBuff: undefined,
	d6d: undefined,
	d6RefreshCnt: undefined,
	d6dCurrentBegin: undefined,
	d6dBegin: undefined,
	times: 0,
	d6NxFilter: undefined,
	d6NextStation: undefined,
	d6NxRefreshCnt: undefined,
	d6NextEvent: undefined,
	jy_list_swipe_times: 0,
	jy_list_getTime_fault_count: 0,
	jy_friends_enchantment_waitingtime: undefined,
	jy_enchantment_index: 0,
	jy_change_shikigami: 'change',
	jy_experience_wine_pot_count: 0,
	jy_enchantment_experience_count: 0,
	back_courtyard_to_next_scheme: '',
	fm_kiss_boss_flag: false,
	fm_boss_btn_click_cnt: 0,
	change_shikigami_flag: true,
	change_shikigami_state: 'flushed',
	change_shikigami_list_swipe_times: 0,
	change_shikigami_last_group_name: undefined,
	narrow_state: undefined,
	narrow_time: 0,
	narrow_mode: false,
	recruitCount: 0,
	recruitClickedY: [],
	lastRecruitFinishTime: null,
	recruitHasScrolled: false,
	liao_activity_page_flag: 0,
	liao_activity_Switch: undefined,
	banquet_change_flag: false,
	gateOfHades_state: false,
	team_up_lagTime: null,
	team_up_Frist: true,
	xsOpened: false,
	xsXieZuo: false,
	intensify_lagTime: null,
	intensify_NumOT: 0,
	create_NumOT: 0,
	redFlag: false,
	yl_next: 0,
	bgy_three: false,
	bgy_ten: false,
	xxlLastLevel: 0,
	buff_enable_page_flag: false,
	team_up_Time: 0,
	game_area: '',
	operate_finish_flag: false,
	preset_once_groupNum: null,
	preset_once_defaultNum: null,
	preset_once_team_groupNum: null,
	preset_once_team_defaultNum: null,
	qiling_Position: null,
	qiling_last: null,
	qiling_ball: 0,
	opened_buff: false,
	closed_buff: false,
	huahezhan: true,
	shangyushe: true,
	d6Loop: 0,
	d6RouFeng: 1,
	d6jueLoop: 0,
	d6jueStarted: false,
	d6jueStartPrompted: false,
	d6jueCantClear: false,
	d6jueCoreBuff: 0,
	d6jueTimes: 0,
	d6jueBegin: 0,
	d6jueCurrentBegin: 0,
	d6jueMapLogTime: 0,
	d6jueMapClickTime: 0,
	d6jueLastMapSig: '',
	d6jueLastMapSigTime: 0,
	d6jueBloomCheckpoint: 0,
	d6jueSkillCount: 0,
	d6jueLeiLevel: 0,
	d6jueOtherBuffSelected: false,
	d6juePowerLevel: 0,
	d6jueYaoLevel: 0,
	d6jueBeishuiLevel: 0,
	d6jueChifenLevel: 0,
	d6jueShopRefresh: 0,
	d6jueShopBuyPending: false,
	d6jueShopBuyStage: 0,
	d6jueShopBuyTime: 0,
	d6jueWanxiangling: 0,
	d6jueWanxianglingPending: 0,
	d6jueStepLeft: 20,
	d6jueHuanxiShop: 0,
	upYuHun: false,
	upYuHunIni: true,
	bgyxLastCapture: undefined,
	waitFight: true,
	faXian_NumOT: 0,
	cgwDetailCnt: 0,
	youjiequyuan_ten: true,
	dengluNumOT: 0,
	dengluState: true,
	yaoqing_close: false,
	frist_open: true,
	tongXinDui_ZhanDou: 'collect',
	daoGuan_swip: true,
	daoGuan_compare: [],
	daoGuan_click: false,
	daoGuan_exit: false,
	daoGuan_again: true,
	daoguan_team: true,
	first_create_team: false,
	open_only_once: false,
	flash_time: 0,
	fengNa: false,
	xxxskill: 0,
	MT_share: 'start',
	MT_share_type: 'mumu',
	MT_liaoShop: 'start',
	MT_liaoShopList: null,
	MT_shop: 'zhiBo',
	zhiBoBack: false,
	shop_find: null,
	fengZi: true,
	zhenLvJu: true,
	shenKan: true,
	zhenShe: 2,
	miWenshare: true,
	diGuishare: false,
	shopShare: null,
	shopSharenName: null,
	sneak_level_open: true,
	day_chouKa: true,
	qiling_shop: true,
	shiHe_jingYan: false,
	liao_banquet_collect: false,
	liao_banquet_onGoing: true,
	xianShiFengMo: 0,
	account_num: 0,
	valid_account_num: 0,
	account_double: null,
	account_state: 'login',
	function_Switch: null,
	loop_add: true,
	liao_cheak: -1,
	email_yuHun: 0,
	runTime_2: null,
	fight_Switch: null,
	xiaJian: null,
	timestamp: 0,
	paiMing: 0,
	email_switch_enabled: null,
	tuDi: null,
	newAccount: null,
	frist: true,
	chess: null,
	chessShop: true,
	chessShopNum: 0,
	miWenChange: false,
	shaoTiao: false,
	miWenClearTimer: 0,
	back: true,
	back_time: 0,
}
export type superGlobalRootType = {
	liao_activity_Switch: Record<string, boolean>, // 寮活动记录
	next_scheme_name: string, // 中转后的下个方案
	daoguan_lose: boolean, // 记录道馆第一次失败
	runTime: number, // 记录结界卡时间
}

export const superGlobalRoot: superGlobalRootType = {
	liao_activity_Switch: undefined,
	next_scheme_name: null,
	daoguan_lose: true,
	runTime: 0,
}