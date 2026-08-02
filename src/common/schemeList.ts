import funcList from './funcListIndex';
import commonConfigArr from './commonConfig';
import { IScheme } from '@/interface/IScheme';
import { merge } from './tool';

const SchemeDefinitions: Array<Omit<IScheme, 'id'>> = [
	// ========== 未分组 ==========
	{
		schemeName: '小功能合集',
		star: true,
		list: [0, 1, 2, 3, 17, 22, 28, 31, 302, 309, 310, 319, 24],
	},
	{
		schemeName: '关闭BUFF',
		list: [0, 1, 2, 3, 501, 29, 40, 503],
	},
	{
		schemeName: '返回庭院',
		list: [0, 1, 2, 3, 24, 503],
		config: {
			'0': {
				jspd_enabled_longtime_nodo: true,
				jspd_times_longtime_nodo: 1,
			},
		},
	},
	{
		schemeName: '通用准备退出',
		star: true,
		list: [0, 1, 2, 3, 24],
	},
	// ========== 战斗 ==========
	{
		schemeName: '通用活动',
		groupNames: ['战斗'],
		star: true,
		list: [0, 1, 2, 3, 24, 312],
	},
	{
		schemeName: '组队司机',
		groupNames: ['战斗'],
		star: true,
		list: [0, 1, 2, 3, 5],
	},
	{
		schemeName: '组队乘客',
		groupNames: ['战斗'],
		star: true,
		list: [0, 1, 2, 3, 4],
	},
	{
		schemeName: '个人突破_打9退4',
		groupNames: ['战斗'],
		star: true,
		list: [690, 509, 510, 51, 0, 1, 2, 3, 7, 8, 9, 29, 503],
		config: {
			'7': {
				switch_nineWin: true,
			},
			'9': {
				scheme_switch_enabled: true,
			},
			'51': {
				greenType: '自定义坐标',
				preSearch: true,
			},
		},
	},
	{
		schemeName: '个人突破_降级',
		groupNames: ['战斗'],
		list: [0, 1, 2, 3, 8, 9, 11],
		config: {
			'0': {
				jspd_enabled_1: true,
				jspd_times_1: 27,
			},
			'1': {
				exitBeforeReady: true,
			},
		},
	},
	{
		schemeName: '寮突破',
		groupNames: ['战斗'],
		star: true,
		list: [0, 1, 2, 3, 8, 9, 12, 29],
		config: {
			'8': {
				type: '寮突破',
			},
		},
	},
	{
		schemeName: '个人御魂',
		groupNames: ['战斗'],
		star: false,
		list: [0, 1, 2, 3, 6],
	},
	{
		schemeName: '个人探索',
		groupNames: ['战斗'],
		star: true,
		list: [0, 1, 2, 3, 14, 29],
	},
	{
		schemeName: '妖气封印',
		groupNames: ['战斗'],
		list: [0, 1, 2, 3, 5, 27],
	},
	// ========== 日常 ==========
	{
		schemeName: '寄养',
		groupNames: ['日常'],
		star: true,
		list: [690, 0, 1, 2, 3, 700, 702, 503],
	}, {
		schemeName: '结界卡',
		groupNames: ['日常'],
		star: true,
		list: [690, 0, 1, 2, 3, 700, 701, 503],
	},
	{
		schemeName: '悬赏',
		groupNames: ['日常'],
		star: true,
		list: [690, 509, 510, 1, 2, 3, 18, 29, 503],
	},
	{
		schemeName: '地鬼日常',
		groupNames: ['日常'],
		star: true,
		list: [690, 509, 510, 0, 1, 2, 3, 16, 29, 503],
		config: {
			'16': {
				next_scheme: '逢魔日常'
			}
		}
	},
	{
		schemeName: '逢魔日常',
		groupNames: ['日常'],
		star: true,
		list: [1, 2, 3, 23, 24, 26, 508, 8, 504],
		config: {
			'508': {
				next_scheme: '每日签到与收取邮件',
			},
		},
	},
	{
		schemeName: '每日签到与收取邮件',
		groupNames: ['日常'],
		list: [0, 1, 2, 3, 518, 521],
		config: {
			'0': {
				jspd_enabled_longtime_nodo: true,
				jspd_times_longtime_nodo: 1,
				after_operation: '切换方案',
				next_scheme: '喂猫喂狗'
			},
		},
	},
	{
		schemeName: '喂猫喂狗',
		groupNames: ['日常'],
		list: [0, 1, 2, 3, 517],
		config: {
			'517': {
				next_scheme: '个人突破_打9退4'
			},
		},
	},
	{
		schemeName: '经验妖怪',
		groupNames: ['日常'],
		list: [0, 50, 1, 2, 3, 5, 27],
		config: {
			'27': {
				mission: '经验妖怪',
			},
			'50': {
				ready_once_buff: true,
				buff_type: '经验',
			},
		},
	},
	{
		schemeName: '金币妖怪',
		groupNames: ['日常'],
		list: [0, 50, 1, 2, 3, 5, 27],
		config: {
			'27': {
				mission: '金币妖怪',
			},
			'50': {
				ready_once_buff: true,
				buff_type: '金币',
			},
		},
	},
	// ========== 寮活动 ==========
	{
		schemeName: '寮活动启动器',
		groupNames: ['寮活动'],
		list: [690, 0, 1, 2, 3, 505, 600, 503],
	},
	{
		schemeName: '狩猎战',
		groupNames: ['寮活动'],
		list: [509, 510, 0, 1, 2, 3, 601],
	},
	{
		schemeName: '道馆',
		groupNames: ['寮活动'],
		list: [509, 510, 0, 1, 2, 3, 602],
		star: true,
	},
	{
		schemeName: '狭间暗域',
		groupNames: ['寮活动'],
		list: [318, 311, 315, 510, 0, 1, 2, 3, 24, 603],
	},
	{
		schemeName: '宴会',
		groupNames: ['寮活动'],
		star: true,
		list: [0, 1, 2, 3, 605, 503],
	},
	{
		schemeName: '首领退治',
		groupNames: ['寮活动'],
		list: [509, 510, 0, 1, 2, 3, 604],
	},
	{
		schemeName: '阴门挑战',
		groupNames: ['寮活动'],
		list: [509, 510, 0, 1, 2, 3, 5, 606],
	},
	{
		schemeName: '僵尸寮自动攻打道馆',
		groupNames: ['寮活动'],
		list: [509, 510, 311, 519, 505, 51, 0, 1, 2, 3, 602],
		config: {
			'51': {
				greenType: '自定义坐标',
				preSearch: true,
			},
			'311': {
				redType: '神荒',
			},
			'602': {
				after_fail_operation: '再战道馆',
				exit_second: true,
			},
		},
	},
	// ========== 每周活动 ==========
	{
		schemeName: '斗技',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 0, 1, 2, 3, 30, 503],
	},
	{
		schemeName: '秘闻前五层',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 315, 0, 50, 1, 2, 3, 34, 29, 503],
		star: true,
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 5,
				after_operation: '切换方案',
				next_scheme: '秘闻后五层'
			},
			'50': {
				buff_type: '金币',
				ready_once_buff: true
			},
			'503': {
				oper_42: false,
				oper_43: false,
			}
		},
	},
	{
		schemeName: '秘闻后五层',
		groupNames: ['每周活动'],
		list: [509, 510, 315, 0, 40, 1, 2, 3, 34],
		star: true,
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 5,
				after_operation: '切换方案',
				next_scheme: '返回庭院'
			},
			'40': {
				ready_once_buff: true
			},
			'503': {
				oper_42: false,
				oper_43: false,
			}
		},
	},
	{
		schemeName: '六道椒图',
		groupNames: ['每周活动'],
		star: true,
		list: [690, 509, 510, 0, 1, 316, 2, 3, 24, 29, 503],
		config: {
			'316': {
				overTimes: '2'
			},
			'503': {
				oper_35: false
			}
		}
	},
	{
		schemeName: '每周真蛇_队长',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 1106, 0, 1, 2, 3, 306, 5, 1106, 6, 53, 29, 503],
	},
	{
		schemeName: '每周真蛇_队员',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 0, 1, 2, 3, 4, 24, 1106, 503],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 2,
			},
		}
	},
	{
		schemeName: '契灵_单人',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 0, 1, 2, 3, 313, 29, 503],
		star: true,
		config: {
			'503': {
				oper_40: false
			}
		}
	},
	{
		schemeName: '契灵_队长',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 0, 1, 2, 3, 306, 5, 313, 29, 503],
		config: {
			'313': {
				buy_ball: true,
				team: '队长'
			},
			'503': {
				oper_40: false
			}
		}
	},
	{
		schemeName: '契灵_队员',
		groupNames: ['每周活动'],
		list: [690, 509, 510, 0, 1, 2, 3, 4, 313, 29, 503],
		config: {
			'313': {
				team: '队员'
			},
			'503': {
				oper_40: false
			}
		}
	},
	{
		schemeName: '周三神秘商人',
		groupNames: ['每周活动'],
		list: [690, 0, 1, 2, 3, 24, 1110, 503],
		config: {
			'0': {
				jspd_times_longtime_nodo: '1',
			},
		},
	},
	{
		schemeName: '百鬼棋局',
		groupNames: ['每周活动'],
		list: [0, 1, 2, 3, 24, 320],
		config: {
			'0': {
				jspd_times_longtime_nodo: '5',
			},
		},
	},
	{
		schemeName: '每周资源领取',
		groupNames: ['每周活动'],
		list: [690, 0, 1, 2, 3, 24, 1100, 1101, 1102, 1103, 1104, 1105, 1107, 1108, 1109, 1111, 503],
		config: {
			'0': {
				jspd_times_longtime_nodo: '1',
			},
		},
	},
	{
		schemeName: '魂海_队员',
		groupNames: ['每周活动'],
		star: true,
		list: [690, 509, 510, 0, 1, 2, 3, 4, 503],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: '30',
				stop_with_launched_app_exit: true
			},
			'503': {
				oper_34: false
			},
		}
	},
	{
		schemeName: '魂海_队长',
		star: false,
		groupNames: ['每周活动'],
		list: [690, 509, 510, 0, 1, 2, 3, 306, 5, 5, 27, 503, 306],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 30,
				after_operation: '切换方案',
				next_scheme: '__关闭应用__'
			},
			'27': {
				mission: '永生之海',
				next_scheme: '__关闭应用__'
			},
			'503': {
				afterCountOper: '不进行任何操作',
				oper_34: false
			}
		},
	},
	// ========== 罕见活动 ==========
	{
		schemeName: '绘卷进度_检测并提醒',
		groupNames: ['罕见活动'],
		list: [0, 2, 3, 304],
		star: true,
	},
	{
		schemeName: '夜行荒河',
		groupNames: ['罕见活动'],
		list: [2, 3, 220, 221],
	},
	{
		schemeName: '伊吹之擂',
		groupNames: ['罕见活动'],
		list: [0, 3, 24, 99],
	},
	{
		schemeName: '对弈竞猜',
		groupNames: ['罕见活动'],
		list: [0, 2, 3, 401],
		config: {
			'0': {
				jspd_times_longtime_nodo: '1',
			},
		},
	},
	{
		schemeName: '清自己1-4星鬼王',
		groupNames: ['罕见活动'],
		list: [0, 1, 2, 3, 24, 317],
	},
	// ========== 循环任务 ==========
	{
		schemeName: '循环_魂十队长',
		star: true,
		list: [690, 509, 510, 0, 1, 2, 3, 5, 27, 306, 503],
		groupNames: ['循环任务'],
		config: {
			'0': {
				'jspd_enabled_2': true,
				'jspd_times_2': '80',
				'after_operation': '切换方案',
				'next_scheme': '突破打9退4'
			},
			'27': { 'level': '魂十' },
			'503': { 'oper_26': false },
		}
	},
	{
		schemeName: '循环_御魂队员',
		star: true,
		list: [690, 509, 510, 50, 0, 1, 2, 3, 4, 503],
		groupNames: ['循环任务'],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: '80',
				after_operation: '切换方案',
				next_scheme: '突破打9退4'
			},
			'50': {
				buff_type: '御魂',
				ready_once_buff: true
			},
			'503': {
				'oper_26': false
			},
		}
	},
	{
		schemeName: '循环_探索队长',
		star: true,
		list: [690, 509, 510, 0, 1, 2, 3, 5, 27, 306, 25, 14, 503],
		groupNames: ['循环任务'],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 80,
				after_operation: '切换方案',
				next_scheme: '突破打9退4'
			},
			'27': { mission: '探索（困难）' },
			'503': { oper_26: false, oper_27: false },
		}
	},
	{
		schemeName: '循环_探索队员',
		star: true,
		list: [690, 509, 510, 50, 0, 1, 2, 3, 4, 25, 503],
		groupNames: ['循环任务'],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: '80',
				after_operation: '切换方案',
				next_scheme: '突破打9退4'
			},
			'50': {
				buff_type: '经验',
				ready_once_buff: true
			},
			'503': {
				'oper_26': false,
				'oper_27': false
			},
		}
	},
	{
		schemeName: '循环_探索单人',
		star: true,
		list: [690, 509, 510, 50, 0, 1, 2, 3, 14, 29, 503],
		groupNames: ['循环任务'],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: '80',
				after_operation: '切换方案',
				next_scheme: '突破打9退4'
			},
			'50': {
				buff_type: '经验',
				ready_once_buff: true
			},
			'503': {
				'oper_26': false,
				'oper_27': false
			},
		}
	},
	{
		schemeName: '突破打9退4',
		groupNames: ['循环任务'],
		star: true,
		list: [690, 509, 510, 501, 40, 51, 0, 1, 2, 3, 8, 9, 10, 11, 29, 503],
		config: {
			'8': {
				inv: true,
				designated_scheme: '循环',
			},
			'9': {
				scheme_switch_enabled: true,
			},
			'51': {
				greenType: '自定义坐标',
				preSearch: true,
			},
			'501': {
				once: true
			},
			'503': {
				oper_26: true,
			},
		},
	},
	// ========== 小号部分 ==========
	{
		schemeName: '僵尸寮日常任务',
		star: true,
		list: [0, 1, 2, 3, 24, 609, 503],
		groupNames: ['小号部分'],
		config: {
			'0': {
				jspd_times_longtime_nodo: '1',
			},
			'609': {
				next_scheme: '__关闭应用__'
			},
			'690': {
				scheme_switch_enabled: true,
				next_scheme: '__不做动作__'
			}
		}
	},
	{
		schemeName: '协战十五',
		groupNames: ['小号部分'],
		list: [690, 694, 0, 1, 2, 3, 6, 53, 29, 503],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 15,
				stop_with_launched_app_exit: true,
			},
			'53': { challenge_type: '觉醒-火麒麟' },
		},
	},
	// ========== 师徒部分 ==========
	{
		schemeName: '师徒_师傅战斗',
		groupNames: ['师徒部分'],
		list: [690, 510, 0, 1, 2, 3, 693, 503],
		config: {
			'0': {
				stop_with_launched_app_exit: true,
			}
		},
	},
	{
		schemeName: '师徒_徒弟登录',
		groupNames: ['师徒部分'],
		list: [690, 0, 1, 2, 3, 5, 24, 691, 503],
		config: {
			'0': {
				jspd_times_longtime_nodo: '3',
			},
			'691': {
				next_scheme: '师徒_徒弟领体力',
				levelUP_scheme: '师徒_徒弟升级'
			},
			'690': {
				area: '徒弟',
			}
		},
	},
	{
		schemeName: '师徒_徒弟升级',
		groupNames: ['师徒部分'],
		list: [694, 0, 1, 2, 3, 29, 14],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 14,
				after_operation: '切换方案',
				next_scheme: '__返回上个方案__'
			},
		}
	},
	{
		schemeName: '师徒_徒弟领体力',
		groupNames: ['师徒部分'],
		list: [690, 0, 1, 2, 3, 518, 503],
		config: {
			'0': {
				jspd_times_longtime_nodo: '0.5',
				after_operation: '切换方案',
				next_scheme: '师徒_徒弟金币'
			}
		},
	},
	{
		schemeName: '师徒_徒弟金币',
		groupNames: ['师徒部分'],
		list: [0, 1, 2, 3, 27, 306, 5],
		config: {
			'27': {
				mission: '金币妖怪',
				next_scheme: '师徒_徒弟经验'
			}
		},
	},
	{
		schemeName: '师徒_徒弟经验',
		groupNames: ['师徒部分'],
		list: [0, 1, 2, 3, 27, 306, 5],
		config: {
			'27': {
				mission: '经验妖怪',
				next_scheme: '师徒_徒弟石距'
			}
		},
	}, {
		schemeName: '师徒_徒弟石距',
		groupNames: ['师徒部分'],
		list: [0, 1, 2, 3, 27, 306, 5],
		config: {
			'27': {
				mission: '石距',
				next_scheme: '师徒_徒弟协战'
			}
		},
	}, {
		schemeName: '师徒_徒弟协战',
		groupNames: ['师徒部分'],
		list: [690, 694, 0, 1, 2, 3, 53, 6, 29, 503],
		config: {
			'0': {
				jspd_enabled_2: true,
				jspd_times_2: 15,
				after_operation: '切换方案',
				next_scheme: '师徒_徒弟守护'
			},
			'6': {
				next_scheme: '师徒_徒弟守护'
			}
		},
	},
	{
		schemeName: '师徒_徒弟守护',
		groupNames: ['师徒部分'],
		list: [0, 1, 2, 3, 306, 692, 29],
		config: {
			'692': {
				next_scheme: '__关闭应用__'
			}
		},
	},
	// 完整demo
	// , {
	//     id: 2,
	//     schemeName: '组队队长',
	//     star: false,
	//     list: [0, ], // funcList中的id集合
	//     config: { // 方案中的配置，如返回空的话使用默认配置
	//         '1': { // key为功能的ID（1表示准备）
	//             enabled: false,
	//             position: '五人-左1'
	//         }
	//     },
	//     commonConfig: { // 通用参数
	//         clickDelay: 200, // 点击后固定延时
	//         clickDelayRandom: 1000, // 点击后延时随机数
	//         // 等
	//     }
	// }
];

const commonConfig = {};
for (let i = 0; i < commonConfigArr.length; i++) {
	for (let j = 0; j < commonConfigArr[i].config.length; j++) {
		const item = commonConfigArr[i].config[j];
		commonConfig[item.name] = item.default;
	}
}
const allConfig = {};
for (let i = 0; i < funcList.length; i++) {
	const configs = funcList[i].config;
	if (configs) {
		allConfig[funcList[i].id] = {};
		for (const config of configs) {
			config.config.forEach((item) => {
				allConfig[funcList[i].id][item.name] = item.default;
			});
		}
	}
}

// 内置方案列表
const innerSchemeListName = {};

const SchemeList: IScheme[] = SchemeDefinitions.map(item => {
	innerSchemeListName[item.schemeName] = true;
	const thisConfig = {};
	item.list.forEach((funcId) => {
		if (allConfig[funcId]) {
			thisConfig[funcId] = allConfig[funcId];
		}
	});
	const scheme = merge(
		{},
		{
			schemeName: '未命名',
			inner: true,
			star: false,
			list: [],
			config: thisConfig,
			commonConfig: commonConfig,
		},
		item
	);
	// 内置方案使用由名称稳定派生的 UUID，避免旧数字 ID 重复，也不会因列表顺序调整而改变。
	scheme.id = createBuiltInSchemeId(scheme.schemeName);
	return scheme;
});

export const schemeNameMap = innerSchemeListName;
export default SchemeList;
export type GroupSchemeName = {
	groupName: string,
	hidden: boolean,
	schemeNames: string[]
}

/** 分组持久化数据只保存展示元信息，成员始终由 schemeList 实时派生。 */
export type GroupSchemeMetadata = Omit<GroupSchemeName, 'schemeNames'>;

export const DEFAULT_SCHEME_GROUP_NAME = '未分组';

let schemeIdSequence = 0;

function hash32(value: string, seed: number): string {
	let hash = seed | 0;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		// FNV-1a 的移位写法，兼容 Auto.js 的 ES5 运行环境。
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
}

function formatUuid(source: string, version: '4' | '8'): string {
	let hex = [
		hash32(source, 0x811c9dc5),
		hash32(source, 0x9e3779b9),
		hash32(source, 0x85ebca6b),
		hash32(source, 0xc2b2ae35),
	].join('');
	hex = `${hex.slice(0, 12)}${version}${hex.slice(13)}`;
	const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
	hex = `${hex.slice(0, 16)}${variant}${hex.slice(17)}`;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 为用户方案生成 UUID。 */
export function createSchemeId(): string {
	schemeIdSequence += 1;
	return formatUuid(`${Date.now()}-${schemeIdSequence}-${Math.random()}`, '4');
}

/** 为内置方案生成跨版本稳定的自定义 UUIDv8。 */
export function createBuiltInSchemeId(schemeName: string): string {
	return formatUuid(`assttyys-ng/builtin-scheme/${schemeName}`, '8');
}

export const isSchemeUuid = (id: unknown): id is string => {
	return typeof id === 'string'
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
};

export const normalizeSchemeGroupNames = (groupNames?: string[]): string[] => {
	const normalized: string[] = [];
	if (Array.isArray(groupNames)) {
		groupNames.forEach(groupName => {
			const name = typeof groupName === 'string' ? groupName.trim() : '';
			if (name && !normalized.includes(name)) normalized.push(name);
		});
	}
	return normalized.length ? normalized : [DEFAULT_SCHEME_GROUP_NAME];
};

/**
 * 以方案列表为唯一事实源生成分组成员；metadata 只控制分组顺序和隐藏状态。
 */
export const deriveGroupSchemeNames = (
	schemeList: IScheme[],
	metadata: Array<Partial<GroupSchemeName>> = []
): GroupSchemeName[] => {
	type DerivedGroup = GroupSchemeName & { fromMetadata: boolean };
	const groups: DerivedGroup[] = [];

	metadata.forEach(item => {
		const groupName = typeof item?.groupName === 'string' ? item.groupName.trim() : '';
		if (!groupName || groups.some(group => group.groupName === groupName)) return;
		groups.push({
			groupName,
			hidden: !!item.hidden,
			schemeNames: [],
			fromMetadata: true,
		});
	});

	(schemeList || []).forEach(scheme => {
		normalizeSchemeGroupNames(scheme.groupNames).forEach(groupName => {
			let group = groups.find(item => item.groupName === groupName);
			if (!group) {
				group = {
					groupName,
					hidden: !!scheme.hidden,
					schemeNames: [],
					fromMetadata: false,
				};
				groups.push(group);
			} else if (!group.fromMetadata && scheme.hidden) {
				group.hidden = true;
			}
			if (!group.schemeNames.includes(scheme.schemeName)) {
				group.schemeNames.push(scheme.schemeName);
			}
		});
	});

	return groups
		.filter(group => group.schemeNames.length > 0)
		.map(group => ({
			groupName: group.groupName,
			hidden: group.hidden,
			schemeNames: group.schemeNames,
		}));
};

export const toGroupSchemeMetadata = (
	groups: Array<Partial<GroupSchemeName>> = []
): GroupSchemeMetadata[] => {
	const metadata: GroupSchemeMetadata[] = [];
	groups.forEach(group => {
		const groupName = typeof group?.groupName === 'string' ? group.groupName.trim() : '';
		if (!groupName || metadata.some(item => item.groupName === groupName)) return;
		metadata.push({ groupName, hidden: !!group.hidden });
	});
	return metadata;
};
