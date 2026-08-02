import { fromEvent } from 'rxjs';
import { webview } from '@/system';
import store, { storeCommon } from '@/system/Store/store';
import { getWebLoaded, requestMyScreenCapture, setWebLoaded } from '@/common/toolAuto';
import { getWidthPixels, getHeightPixels } from '@auto.pro/core';
// import _ from 'lodash';
import version, { versionList } from '@/common/version';
import myFloaty from '@/system/MyFloaty';
import defaultSchemeList, {
	createSchemeId,
	deriveGroupSchemeNames,
	GroupSchemeMetadata,
	GroupSchemeName,
	isSchemeUuid,
	normalizeSchemeGroupNames,
	schemeNameMap,
	toGroupSchemeMetadata,
} from '@/common/schemeList';
import MyAutomator from '@/system/MyAutomator';
import helperBridge from '@/system/helperBridge';
import { IScheme } from '@/interface/IScheme';
import { deepClone } from '@/common/tool';

export default function webviewSchemeList() {
	// 初始化并迁移旧数据：数字/重复 ID -> UUID，旧 groupName -> groupNames。
	const schemeList = migrateSchemeList(store.get('schemeList'));
	persistSchemeList(schemeList);

	// 返回已保存的方案列表，如果未保存过，返回common中的schemeList
	webview.on('getSchemeList').subscribe(([_param, done]) => {
		// const savedSchemeList = store.get('schemeList', defaultSchemeList);
		// savedSchemeList.forEach(item => {
		// 	item.inner = schemeNameMap[item.schemeName] || false;
		// });
		// done(savedSchemeList);
		done(readSchemeList());
	});

	webview.on('getGroupSchemeNames').subscribe(([_param, done]) => {
		done(readDerivedGroupSchemeNames());
	});

	webview.on('getDefaultSchemeList').subscribe(([_param, done]) => {
		done(defaultSchemeList);
	});

	webview.on('getGroupNames').subscribe(([_param, done]) => {
		// const savedSchemeList = store.get('schemeList', defaultSchemeList);
		// const groupNamesMap = {};
		// savedSchemeList.forEach(s => {
		// 	if (s.groupName) groupNamesMap[s.groupName] = 1;
		// });
		// done(Object.keys(groupNamesMap));
		done(readDerivedGroupSchemeNames().map(group => group.groupName));
	});

	webview.on('saveGroupSchemeNames').subscribe(([params, done]) => {
		const derivedGroups = deriveGroupSchemeNames(readSchemeList(), Array.isArray(params) ? params : []);
		store.put('groupSchemeNames', toGroupSchemeMetadata(derivedGroups));
		done({ error: 0, message: 'success' });
	});

	// 保存方案
	webview.on('saveScheme').subscribe(([params, done]) => {
		// const savedSchemeList = store.get('schemeList', defaultSchemeList);
		// console.log(`saveScheme: ${JSON.stringify(scheme, null, 4)}`);
		// const schemeList = mergeSchemeList(savedSchemeList, defaultSchemeList);
		// for (let i = 0; i < schemeList.length; i++) {
		// 	if (schemeList[i].schemeName === scheme.schemeName) {
		// 		scheme.id = schemeList[i].id;
		// 		schemeList[i] = scheme;
		// 		break;
		// 	}
		// }
		// store.put('schemeList', schemeList);
		// done('success');
		const schemeList = readSchemeList();
		const { type, oldScheme, newScheme } = params;
		if (type === 'modify') {
			const schemeName = normalizeSchemeName(newScheme?.schemeName);
			if (!schemeName) {
				done({ error: 1, message: '方案名不能为空' });
				return;
			}
			const index = findSchemeIndex(schemeList, oldScheme);
			if (index === -1) {
				done({ error: 1, message: '未找到该方案' });
				return;
			}
			if (hasDuplicateSchemeName(schemeList, schemeName, index)) {
				done({ error: 1, message: '方案名重复' });
				return;
			}
			// 方案 ID 是不可变身份，前端修改方案时无权覆盖。
			schemeList[index] = normalizeScheme(newScheme, String(schemeList[index].id));
			persistSchemeList(schemeList);
			done({ error: 0, message: 'success' });
			return;
		} else if (type === 'add' || type === 'copy') {
			const schemeName = normalizeSchemeName(newScheme?.schemeName);
			if (!schemeName) {
				done({ error: 1, message: '方案名不能为空' });
				return;
			}
			if (hasDuplicateSchemeName(schemeList, schemeName)) {
				done({ error: 1, message: '方案名重复' });
				return;
			}
			// 新增和复制必须生成新 UUID，不能沿用前端传来的数字 ID 或源方案 ID。
			schemeList.push(normalizeScheme(newScheme, createSchemeId()));
			persistSchemeList(schemeList);
			done({ error: 0, message: 'success' });
			return;
		} else if (type === 'remove') {
			const index = findSchemeIndex(schemeList, oldScheme);
			if (index === -1) {
				done({ error: 1, message: '未找到该方案' });
				return;
			}
			schemeList.splice(index, 1);
			persistSchemeList(schemeList);
			done({ error: 0, message: 'success' });
			return;
		}
		done({ error: 1, message: '未知错误' });
		return;
	});

	webview.on('removeScheme').subscribe(([params, done]) => {
		const schemeList = readSchemeList();
		const index = findSchemeIndex(schemeList, params);
		if (index === -1) {
			done({ error: 1, message: '未找到该方案' });
			return;
		}
		schemeList.splice(index, 1);
		persistSchemeList(schemeList);
		done({ error: 0, message: 'success' });
	});


	// 保存方案列表
	webview.on('saveSchemeList').subscribe(([incomingSchemeList, done]) => {
		if (!Array.isArray(incomingSchemeList)) {
			done({ error: 1, message: '方案列表格式错误' });
			return;
		}
		const invalidName = findInvalidOrDuplicateSchemeName(incomingSchemeList);
		if (invalidName) {
			done({ error: 1, message: invalidName });
			return;
		}
		const schemeList = normalizeIncomingSchemeList(incomingSchemeList, readSchemeList());
		persistSchemeList(schemeList);
		console.log('schemeList已保存');
		done('success');
	});


	/**
	 * 收藏/取消收藏方案
	 */
	webview.on('starScheme').subscribe(([opt, done]) => {
		const savedSchemeList = readSchemeList();
		const index = findSchemeIndex(savedSchemeList, opt);
		if (index === -1) {
			done({ error: 1, message: '未找到该方案' });
			return;
		}
		savedSchemeList[index].star = !!opt.star;
		persistSchemeList(savedSchemeList);
		done(savedSchemeList[index]);
		toastLog(`${!opt.star ? '取消' : ''}收藏成功`);
	});

	// 注册返回界面的事件
	fromEvent(ui.emitter, 'resume').subscribe((_e) => {
		// 登录验证
		webview.runHtmlJS('window.resumeValidUser && window.resumeValidUser()');
		// 更新定时任务界面的数据
		webview.runHtmlJS('window.loadScheduleData && window.loadScheduleData()');
	})

	webview.on('webloaded').subscribe(([_param, done]) => {
		if (getWebLoaded()) {
			done(true);
			return;
		}
		setWebLoaded(true);
		// 界面加载完成后申请截图权限
		requestMyScreenCapture(done, helperBridge);

		// 加载完界面后再注册返回事件
		fromEvent(ui.emitter, 'back_pressed').subscribe((e: any) => {
			e.consumed = true;
			webview.runHtmlJS('window.routeBack && window.routeBack()');
		});

		// 初始化automator
		const storeSettings = storeCommon.get('settings', {});
		if (!storeSettings.tapType) {
			if (device.sdkInt >= 24) {
				storeSettings.tapType = '无障碍';
			} else {
				storeSettings.tapType = 'Root';
			}
			storeCommon.put('settings', storeSettings);
		}
		helperBridge.setAutomator(new MyAutomator(storeSettings.tapType));

		if (floaty.checkPermission()) {
			myFloaty.init();
		}
	});

	// TODO 使用core包的获取状态栏高度
	webview.on('getStatusBarHeight').subscribe(([_param, done]) => {
		const resources = context.getResources();
		const resourceId = resources.getIdentifier('status_bar_height', 'dimen', 'android');
		const statusBarHeight = resources.getDimensionPixelSize(resourceId);
		const density = context.getResources().getDisplayMetrics().density;
		done(Math.floor(statusBarHeight / density));
	});

	// 获取版本信息，前端对版本信息进行拼接，告知更新内容
	webview.on('versionInfo').subscribe(([_param, done]) => {
		// storages.remove('assttyys_ng_common');
		const storeVersion = storeCommon.get('storeVersion', null);
		storeCommon.put('storeVersion', version);
		done({
			storeVersion: storeVersion,
			versionList: versionList
		});
	});

	// 获取应用信息，每次进入app都会以弹窗形式出现
	webview.on('getAppInfo').subscribe(([_param, done]) => {
		const appMsg = '';
		const ret = { msg: appMsg };
		const w = getWidthPixels();
		const h = getHeightPixels();
		if (!(w == 1280 && h == 720) && !(w == 720 && h == 1280)) {
			ret.msg = `当前分辨率为 ${w} * ${h}, 非推荐分辨率 720 * 1280, 不保证正常运行。${appMsg}`;
		}
		done(ret);
	});

	webview.on('getClip').subscribe(([_param, done]) => {
		done(getClip());
	});

	// 提供toast给前端使用
	webview.on('toast').subscribe(([string, done]) => {
		done();
		toastLog(string);
	});

	// 退出，前端回到方案界面后返回按两次后退出
	webview.on('exit').subscribe(([_param, done]) => {
		done();
		exit();
	});
}




type LegacyScheme = IScheme & { groupName?: string };

const normalizeSchemeName = (schemeName: unknown): string => {
	return typeof schemeName === 'string' ? schemeName.trim() : '';
};

const normalizeScheme = (source: IScheme, immutableId: string): IScheme => {
	const scheme = deepClone(source || {}) as LegacyScheme;
	scheme.id = immutableId;
	scheme.schemeName = normalizeSchemeName(scheme.schemeName);
	if (scheme.groupName && (!scheme.groupNames || scheme.groupNames.length === 0)) {
		scheme.groupNames = [scheme.groupName];
	}
	delete scheme.groupName;
	scheme.groupNames = normalizeSchemeGroupNames(scheme.groupNames);
	if (!Array.isArray(scheme.list)) scheme.list = [];
	return scheme;
};

const migrateSchemeList = (storedSchemeList: IScheme[] | null): IScheme[] => {
	const source = Array.isArray(storedSchemeList)
		? storedSchemeList
		: deepClone(defaultSchemeList);
	const usedIds: string[] = [];

	return source.map(rawScheme => {
		const defaultScheme = rawScheme?.inner
			? defaultSchemeList.find(item => item.schemeName === rawScheme.schemeName)
			: null;
		let immutableId = defaultScheme
			? String(defaultScheme.id)
			: (isSchemeUuid(rawScheme?.id) ? rawScheme.id : createSchemeId());
		if (usedIds.includes(immutableId)) immutableId = createSchemeId();
		usedIds.push(immutableId);
		return normalizeScheme(rawScheme, immutableId);
	});
};

const readSchemeList = (): IScheme[] => {
	const saved = store.get('schemeList', []);
	return Array.isArray(saved) ? saved : [];
};

const readGroupSchemeMetadata = (): GroupSchemeMetadata[] => {
	const saved = store.get('groupSchemeNames', []);
	return toGroupSchemeMetadata(Array.isArray(saved) ? saved : []);
};

const readDerivedGroupSchemeNames = (): GroupSchemeName[] => {
	return deriveGroupSchemeNames(readSchemeList(), readGroupSchemeMetadata());
};

const syncGroupSchemeMetadata = (schemeList: IScheme[]): void => {
	const derivedGroups = deriveGroupSchemeNames(schemeList, readGroupSchemeMetadata());
	store.put('groupSchemeNames', toGroupSchemeMetadata(derivedGroups));
};

const reconcileCurrentScheme = (schemeList: IScheme[]): void => {
	const currentScheme: IScheme | null = store.get('currentScheme', null);
	if (!currentScheme) return;
	const index = findSchemeIndex(schemeList, currentScheme);
	// 删除当前方案时清空旧快照；修改/重命名时同步成列表中的最新数据。
	store.put('currentScheme', index === -1 ? null : deepClone(schemeList[index]));
};

const persistSchemeList = (schemeList: IScheme[]): void => {
	store.put('schemeList', schemeList);
	syncGroupSchemeMetadata(schemeList);
	reconcileCurrentScheme(schemeList);
	const deletedSchemeNames = Object.keys(schemeNameMap).filter(schemeName => {
		return !schemeList.some(scheme => scheme.schemeName === schemeName);
	});
	store.put('deletedSchemeNames', deletedSchemeNames);
};

const findSchemeIndex = (schemeList: IScheme[], reference: Partial<IScheme> | null): number => {
	if (!reference) return -1;
	if (isSchemeUuid(reference.id)) {
		const index = schemeList.findIndex(scheme => String(scheme.id) === reference.id);
		if (index !== -1) return index;
	}
	const schemeName = normalizeSchemeName(reference.schemeName);
	return schemeName
		? schemeList.findIndex(scheme => scheme.schemeName === schemeName)
		: -1;
};

const hasDuplicateSchemeName = (
	schemeList: IScheme[],
	schemeName: string,
	excludedIndex = -1
): boolean => {
	return schemeList.some((scheme, index) => index !== excludedIndex && scheme.schemeName === schemeName);
};

const findInvalidOrDuplicateSchemeName = (schemeList: IScheme[]): string => {
	const names: string[] = [];
	for (const scheme of schemeList) {
		const schemeName = normalizeSchemeName(scheme?.schemeName);
		if (!schemeName) return '方案名不能为空';
		if (names.includes(schemeName)) return `方案名重复：${schemeName}`;
		names.push(schemeName);
	}
	return '';
};

/**
 * 兼容旧前端的整表保存，同时保证已有 UUID 不被改写、复制项不会复用源 UUID。
 */
const normalizeIncomingSchemeList = (incoming: IScheme[], existing: IScheme[]): IScheme[] => {
	const ownerById: Record<string, number> = {};

	incoming.forEach((scheme, index) => {
		if (!isSchemeUuid(scheme?.id)) return;
		const id = scheme.id;
		const oldScheme = existing.find(item => String(item.id) === id);
		// 未知 UUID 不能覆盖已有身份；新方案统一由后端生成 UUID。
		if (!oldScheme) return;
		if (typeof ownerById[id] === 'number') return;
		const sameIdIndexes = incoming
			.map((item, itemIndex) => isSchemeUuid(item?.id) && item.id === id ? itemIndex : -1)
			.filter(itemIndex => itemIndex !== -1);
		const exactNameIndex = sameIdIndexes.find(itemIndex => {
			return normalizeSchemeName(incoming[itemIndex].schemeName) === oldScheme.schemeName;
		});
		ownerById[id] = typeof exactNameIndex === 'number' ? exactNameIndex : index;
	});

	const usedIds: string[] = [];
	return incoming.map((scheme, index) => {
		let immutableId = '';
		if (isSchemeUuid(scheme?.id) && ownerById[scheme.id] === index) {
			immutableId = scheme.id;
		} else {
			const oldScheme = existing.find(item => {
				return item.schemeName === normalizeSchemeName(scheme?.schemeName)
					&& isSchemeUuid(item.id)
					&& !usedIds.includes(item.id);
			});
			if (oldScheme) immutableId = String(oldScheme.id);
		}
		if (!immutableId || usedIds.includes(immutableId)) immutableId = createSchemeId();
		usedIds.push(immutableId);
		return normalizeScheme(scheme, immutableId);
	});
};
