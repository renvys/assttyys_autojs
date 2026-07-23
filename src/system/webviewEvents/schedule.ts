import { webview } from '@/system';
import script from '@/system/script';
import store from '@/system/Store/store';
import ScheduleDefaultList from '@/common/scheduleList';
import schedule, { Job, JobOptions, mergeOffsetTime } from '@/system/Schedule'
import { getNextByCron } from '@/common/toolCron';

/**
 * 用代码中的默认任务补齐已保存列表，同时保留用户修改过的完整任务配置。
 * 任务名不在默认列表中的自定义任务也必须保留。
 */
function mergeScheduleListWithDefaults(savedJobs: JobOptions[]): JobOptions[] {
	const jobs = Array.isArray(savedJobs) ? savedJobs : [];
	const defaultJobNames = ScheduleDefaultList.map(job => job.name);
	const mergedDefaultJobs = ScheduleDefaultList.map(defaultJob => {
		const savedJob = jobs.find(job => job.name === defaultJob.name);
		if (!savedJob) {
			return { ...defaultJob, config: { ...defaultJob.config } };
		}
		return {
			...defaultJob,
			...savedJob,
			config: {
				...defaultJob.config,
				...savedJob.config,
			},
		};
	});
	const customJobs = jobs
		.filter(job => !defaultJobNames.includes(job.name))
		.map(job => ({ ...job, config: { ...job.config } }));

	return [...mergedDefaultJobs, ...customJobs];
}
// // import schedule from 'node-schedule';

// const emt = events.emitter()
// events.EventEmitter = function () {}
// Object.keys(emt).forEach(function (key) {
//     events.EventEmitter.prototype[key] = emt[key];
// });

// let schedule = null;
// import('node-schedule').then(function (inSchedule) {
//     schedule = inSchedule;
// });

export default function webviewSchedule() {

	// 3. 初始化scheduleList
	let savedScheduleList = store.get('scheduleList');
	if (!savedScheduleList) {
		console.log('初始化scheduleList', ScheduleDefaultList);
		store.put('scheduleList', ScheduleDefaultList);
		savedScheduleList = ScheduleDefaultList;
	}
	// 3.1 cron更新下次执行时间，时间字段转回date类型
	savedScheduleList.forEach((item: JobOptions) => {
		['lastRunTime', 'nextDate', 'lastStopTime'].forEach(keyName => {
			try {
				const dtstr = item[keyName as keyof JobOptions] as string;
				if (dtstr) {
					item[keyName as 'lastRunTime' | 'nextDate' | 'lastStopTime'] = new Date(dtstr);
				}
			} catch (e) {
				console.log(`${item.name}中${keyName}转换失败：${item[keyName as keyof JobOptions]}`)
				item[keyName as 'lastRunTime' | 'nextDate' | 'lastStopTime'] = null;
			}
		})
		if (item.repeatMode === 3 && item.checked) {
			// 如果没有 nextDate 或 nextDate 已过期，重新计算
			if (!item.nextDate || new Date(item.nextDate).getTime() <= Date.now()) {
				const nextDate = getNextByCron(item.interval);
				if (!nextDate) return; // cron表达式解析失败，跳过该任务
				item.nextDate = mergeOffsetTime(nextDate, item.nextOffset);
			}
		}
		// 只有启用的任务才加入调度器
		if (item.checked === true) {
			jobToSchedule(item);
		}
	});
	persistScheduleList(savedScheduleList);


	// 返回所有任务列表（所有方案都显示全部任务）
	webview.on('getScheduleList').subscribe(([_param, done]) => {
		const currentConfigName = store.get('currentScheduleConfigName');
		const configs = store.get('scheduleConfigs') || {};

		// 当前配置优先；没有选择配置时使用最后一次保存的任务列表
		if (currentConfigName && configs[currentConfigName]) {
			done(mergeScheduleListWithDefaults(configs[currentConfigName]));
		} else {
			const savedJobs = store.get('scheduleList', ScheduleDefaultList);
			done(mergeScheduleListWithDefaults(savedJobs));
		}
	});

	// 保存定时任务列表
	webview.on('saveScheduleList').subscribe(([scheduleList, done]) => {
		// store.put('scheduleList', scheduleList);
		// // if (Array.isArray(scheduleList)) {
		// //     scheduleList.forEach(item => {
		// //         item.job && script.setScheduleJobInstance(item.id, item.job);
		// //     });
		// // }

		// console.log('scheduleList已保存');
		// done('success');

		persistScheduleList(scheduleList);
		done({ error: 0, message: 'success' });
	});

	webview.on('getScheduleInstance').subscribe(([_param, done]) => {
		done(schedule);
	});

	webview.on('setScheduleLazyMode').subscribe(([lazyMode, done]) => {
		schedule.lazyMode = lazyMode;
		done('success');
	});

	webview.on('getScheduleLazyMode').subscribe(([_param, done]) => {
		done(schedule.lazyMode);
	});


	// schedule.add(new Job({
	//     name: 'test',
	//     nextDate: new Date(Date.now() + 10000),
	//     repeatMode: 1,
	//     interval: 10000,
	//     runningCallback: function() {
	//         console.log(`调度任务，当前时间：${new Date().toUTCString()}`);
	//         console.log(`调度任务，this：${this}`);
	//     }
	// }));

	webview.on('scheduleChange').subscribe(([job, done]) => {
		jobToSchedule(job);
		schedule.immediateTimerInterval();
		done();
	});

	function jobToSchedule(job: JobOptions) {
		if (job.checked === true) {
			// cron 模式下，如果 nextDate 不存在或过期超过2分钟，重新计算
			// 2分钟内的容错时间用于调度器捕获并执行过期任务
			let nextDate = job.nextDate ? new Date(job.nextDate) : null;
			const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
			if (job.repeatMode === 3 && (!nextDate || nextDate.getTime() <= twoMinutesAgo)) {
				const calculatedNextDate = getNextByCron(job.interval);
				if (calculatedNextDate) {
					nextDate = mergeOffsetTime(calculatedNextDate, job.nextOffset);
					// 更新 job 的 nextDate 以便后续使用
					job.nextDate = nextDate;
				}
			}
			const jobObj = new Job({
				...job,
				nextDate: nextDate || new Date(job.nextDate),
				runningCallback() {
					updateJobStore(this);
					script.isPause = false;
					script.setCurrentScheme(job.config.scheme);
					script.launchRelatedApp();
					script.rerunWithJob(this);
				}
			});
			jobObj.setDoneCallback(function () {
				updateJobStore(this);
			});
			schedule.add(jobObj);
		} else {
			schedule.remove(job.name);
		}

		function updateJobStore(job: JobOptions) {
			const sl = store.get('scheduleList', ScheduleDefaultList);
			for (const storedJob of sl) {
				if (storedJob.name === job.name) {
					storedJob.nextDate = job.nextDate;
					storedJob.lastRunTime = job.lastRunTime;
					storedJob.lastStopTime = job.lastStopTime;
					break;
				}
			}
			persistScheduleList(sl);
		}
	}

	/**
	 * 保存当前任务列表，并同步当前选中的配置。
	 * scheduleList 是运行态数据，scheduleConfigs 是配置管理数据，两者必须保持一致。
	 */
	function persistScheduleList(scheduleList: JobOptions[]) {
		store.put('scheduleList', scheduleList);

		const currentConfigName = store.get('currentScheduleConfigName');
		if (!currentConfigName) return;

		const configs = store.get('scheduleConfigs') || {};
		// 当前配置可能已经被删除，避免一次普通保存将它意外恢复
		if (!configs[currentConfigName]) return;

		configs[currentConfigName] = scheduleList;
		store.put('scheduleConfigs', configs);
	}

	// const jobList = [];
	// webview.on('scheduleChange').subscribe(([item, done]) => {
	//     const index = jobList.findIndex(job => job.id === item.id);

	//     if (index != -1) {
	//         if (item.checked) {
	//             jobList[index].job.reschedule(item.config.cron, async function () {
	//                 setCurrentScheme(item.config.scheme, store);
	//                 script.rerun();
	//                 item.lastRunTime = new Date().toLocaleString();
	//             });
	//         } else {
	//             jobList[index].job.cancel();
	//         }

	//     } else {
	//         const jobTemp = schedule.scheduleJob(item.config.cron, async function () {
	//             setCurrentScheme(item.config.scheme, store);
	//             script.rerun();
	//             item.lastRunTime = new Date().toLocaleString();
	//         });
	//         jobList.push({
	//             id: item.id,
	//             job: jobTemp
	//         })
	//     }

	//     console.log(jobList);
	//     done(true);
	// });

	// ========== 配置管理接口 ==========

	// 获取所有配置名称列表
	webview.on('getScheduleConfigNames').subscribe(([_param, done]) => {
		const configs = store.get('scheduleConfigs') || {};
		// 如果没有"默认配置"，自动创建
		const DEFAULT_CONFIG_NAME = '默认配置';
		if (!configs[DEFAULT_CONFIG_NAME]) {
			const currentJobs = mergeScheduleListWithDefaults(store.get('scheduleList') || []);
			configs[DEFAULT_CONFIG_NAME] = currentJobs;
			store.put('scheduleConfigs', configs);
		}
		done(Object.keys(configs));
	});

	// 加载指定配置到调度器
	webview.on('loadScheduleConfig').subscribe(([name, done]) => {
		const configs = store.get('scheduleConfigs') || {};
		const configJobs = configs[name];
		if (!configJobs) {
			done({ error: 1, message: '配置不存在' });
			return;
		}
		const jobs = mergeScheduleListWithDefaults(configJobs);
		// 清空调度器中的所有现有任务（先复制任务名列表，避免遍历中修改数组）
		const currentJobList = schedule.getJobList();
		const jobNames = currentJobList.map(job => job.name);
		for (const jobName of jobNames) {
			schedule.remove(jobName);
		}
		// 将新配置的任务加入调度器（cron 模式检查 nextDate 是否过期）
		for (const job of jobs) {
			if (job.checked === true) {
				// cron 模式下，如果 nextDate 已过期，重新计算
				if (job.repeatMode === 3 && job.nextDate && new Date(job.nextDate).getTime() <= Date.now()) {
					const nextDate = getNextByCron(job.interval);
					if (nextDate) {
						job.nextDate = mergeOffsetTime(nextDate, job.nextOffset);
					}
				}
				jobToSchedule(job);
			}
		}
		// 保存当前配置名称和任务列表
		store.put('currentScheduleConfigName', name);
		persistScheduleList(jobs);

		done({ error: 0, message: 'success', data: jobs });
	});

	// 保存/更新配置
	webview.on('saveScheduleConfig').subscribe(([params, done]) => {
		const { name, jobs } = params;
		const configs = store.get('scheduleConfigs') || {};
		const mergedJobs = mergeScheduleListWithDefaults(jobs);
		configs[name] = mergedJobs;
		store.put('scheduleConfigs', configs);
		if (store.get('currentScheduleConfigName') === name) {
			store.put('scheduleList', mergedJobs);
		}
		done({ error: 0, message: 'success' });
	});

	// 删除配置
	webview.on('deleteScheduleConfig').subscribe(([name, done]) => {
		const configs = store.get('scheduleConfigs') || {};
		delete configs[name];
		store.put('scheduleConfigs', configs);
		done({ error: 0, message: 'success' });
	});
}


