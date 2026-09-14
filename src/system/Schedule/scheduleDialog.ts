import schedule from '@/system/Schedule/index';
import store from '@/system/Store/store';

const ONE_HOUR_MS = 60 * 60 * 1000;

interface ScheduleListItem {
	name: string;
	status: string;
	statusStr: string;
	statusColor: string;
	nextDateStr?: string;
	nextDateBueatifyTime?: string;
}

/**
 * 列表行与数据的对应关系。
 * 注意：item_bind 触发时 itemHolder.item 可能还是 null（数据要在 item_data_bind 阶段才写入），
 * 所以不能在绑定时就把 item 存进闭包里，只能在点击时通过 itemHolder 实时读取；
 * 列表滚动复用后 itemHolder 会被替换成新的，这里保存的是最新一次绑定的引用。
 */
interface ScheduleRow {
	itemView: any;
	itemHolder: any;
	item: ScheduleListItem;
	clickBound: boolean;
}

export const showScheduleDialog = function () {
	const view = ui.inflate(`<frame>
        <vertical>
            <list id="list">
                <card w="*" h="78" margin="5 2" cardCornerRadius="2dp"
                    cardElevation="1dp" foreground="?selectableItemBackground">
                    <vertical padding="10 4" h="*" w="*">
                        <text id="title" text="{{this.name}}" textColor="#222222" textSize="16sp" maxLines="1" />
                        <horizontal gravity="center_vertical" margin="0 2">
                            <text id="nextTime" visibility="{{this.status === 'waiting' ? 'visible' : 'gone'}}"
                                text="{{this.nextDateBueatifyTime}}" textColor="#999999" textSize="13sp" maxLines="1"
                                w="*" layout_weight="1" />
                            <text id="advanceBtn" visibility="{{this.status === 'waiting' ? 'visible' : 'gone'}}"
                                text="提前1h" textColor="#4f91de" textSize="13sp" padding="6 3" />
                            <text id="delayBtn" visibility="{{this.status === 'waiting' ? 'visible' : 'gone'}}"
                                text="延长1h" textColor="#4f91de" textSize="13sp" padding="6 3" />
                            <text id="statusText" w="58" gravity="center" text="{{this.statusStr}}"
                                textColor="{{this.statusColor}}" />
                        </horizontal>
                    </vertical>
                </card>
            </list>
        </vertical>
    </frame>`);

	const scheduleDialog = dialogs.build({
		title: '定时任务',
		customView: view
	}).show();

	const topList = []; /* [{
		name: '喂猫喂狗',
		status: 'running',
		statusStr: '执行中',
		statusColor: '#00cc00',
	}, {
		name: '悬赏',
		status: 'queueing',
		statusStr: '队列中',
		statusColor: '#cc0000',
	}, {
		name: '每日签到与领取邮箱奖励',
		status: 'queueing',
		statusStr: '队列中',
		statusColor: '#cc0000',
	}];*/
	const runnJob = schedule.getRunningJub();
	if (runnJob) {
		topList.push({
			name: runnJob.name,
			status: 'running',
			statusStr: '执行中',
			statusColor: '#00cc00',
		});
	}
	const queueList = schedule.getJobQueue();
	if (queueList?.length) {
		for (const job of queueList) {
			topList.push({
				name: job.name,
				status: 'queueing',
				statusStr: '队列中',
				statusColor: '#cc0000',
			});
		}
	}

	const waitList = schedule.getJobList().filter(item => {
		if (!item.checked) return false;
		for (const ii of topList) {
			if (ii.name === item.name) {
				return false;
			}
		}
		return true;
	}).sort((a, b) => a.nextDate.getTime() - b.nextDate.getTime()).map(item => {
		return {
			name: item.name,
			nextDateStr: formatDate(item.nextDate),
			nextDateBueatifyTime: bueatifyTime(item.nextDate.getTime() - new Date().getTime()),
			status: 'waiting',
			statusStr: topList.length ? '加入队列' : '立即执行',
			statusColor: '#0000dd', // #4f91de
		}
	});


	view.list.setDataSource([...topList, ...waitList]);

	const rows: ScheduleRow[] = [];

	/**
	 * 取当前行对应的数据。点击时 itemHolder.item 才是有效的，
	 * 若此时仍为 null（例如列表正在复用/解绑），退回最近一次读到的非空数据。
	 */
	const getRowItem = (row: ScheduleRow): ScheduleListItem => {
		const item = (row.itemHolder && row.itemHolder.item) || row.item;
		return item || null;
	};

	const onItemBound = function (itemView: any, itemHolder: any) {
		let row = rows.find(item => item.itemView === itemView);
		if (!row) {
			row = { itemView, itemHolder: null, item: null, clickBound: false };
			rows.push(row);
		}
		// item_bind / item_data_bind 都会走到这里，每次都刷新当前行持有的数据
		row.itemHolder = itemHolder;
		if (itemHolder && itemHolder.item) {
			row.item = itemHolder.item;
		}
		if (row.clickBound) return;
		// 事件只注册一次，避免列表复用后同一行重复注册导致一次点击执行多次
		row.clickBound = true;
		itemView.advanceBtn.on('click', () => adjustJobNextDate(itemView, () => getRowItem(row), -1));
		itemView.delayBtn.on('click', () => adjustJobNextDate(itemView, () => getRowItem(row), 1));
		itemView.statusText.on('click', () => runJobImmediately(() => getRowItem(row), scheduleDialog));
	};

	view.list.on('item_bind', onItemBound);
	view.list.on('item_data_bind', onItemBound);
}

function adjustJobNextDate(itemView: any, resolveItem: () => ScheduleListItem, hourOffset: number) {
	try {
		const item = resolveItem();
		if (!item || item.status !== 'waiting') return;

		const job = schedule.getJobByName(item.name);
		if (!job) return;

		const now = Date.now();
		const currentTime = job.nextDate ? job.nextDate.getTime() : now;
		// 提前：最多提前到当前时间（即立即执行）；延长：从原定时间往后顺延
		job.nextDate = new Date(Math.max(Math.max(currentTime, now) + hourOffset * ONE_HOUR_MS, now));

		item.nextDateBueatifyTime = bueatifyTime(job.nextDate.getTime() - Date.now());
		item.nextDateStr = formatDate(job.nextDate);
		itemView.nextTime.text(item.nextDateBueatifyTime);

		persistJobNextDate(job.name, job.nextDate);
		if (job.nextDate.getTime() <= Date.now()) {
			schedule.immediateTimerInterval();
		}

		if (hourOffset < 0) {
			toast(job.nextDate.getTime() <= Date.now() ? '已提前至立即执行' : '已提前一小时');
		} else {
			toast('已延长一小时');
		}
	} catch (e) {
		console.error(`[scheduleDialog]调整下次执行时间失败：${e}`);
		toast('调整失败，请查看日志');
	}
}

function runJobImmediately(resolveItem: () => ScheduleListItem, scheduleDialog: any) {
	try {
		// 先取数据再关闭弹窗：弹窗关闭后列表会解绑，itemHolder.item 可能被清空
		const item = resolveItem();
		if (!item || item.status !== 'waiting') return;

		const job = schedule.getJobByName(item.name);
		scheduleDialog.dismiss();
		if (!job) return;

		job.nextDate = new Date();
		persistJobNextDate(job.name, job.nextDate);
		schedule.immediateTimerInterval();
	} catch (e) {
		console.error(`[scheduleDialog]立即执行定时任务失败：${e}`);
		toast('执行失败，请查看日志');
	}
}

function persistJobNextDate(jobName: string, nextDate: Date) {
	const scheduleList = store.get('scheduleList');
	if (Array.isArray(scheduleList) && updateJobNextDate(scheduleList, jobName, nextDate)) {
		store.put('scheduleList', scheduleList);
	}

	const currentConfigName = store.get('currentScheduleConfigName');
	const configs = store.get('scheduleConfigs') || {};
	const configJobs = currentConfigName ? configs[currentConfigName] : null;
	if (Array.isArray(configJobs) && updateJobNextDate(configJobs, jobName, nextDate)) {
		store.put('scheduleConfigs', configs);
	}
}

function updateJobNextDate(jobs: any[], jobName: string, nextDate: Date): boolean {
	const job = jobs.find(item => item.name === jobName);
	if (!job) return false;
	job.nextDate = nextDate;
	return true;
}


function formatDate(date: Date) {
	const y = date.getFullYear();
	const m = date.getMonth() + 1;
	const d = date.getDate();
	const h = date.getHours();
	const i = date.getMinutes();
	const s = date.getSeconds();
	const padZero = num => num < 10 ? `0${num}` : `${num}`;
	return `${[y, m, d].map(padZero).join('-')} ${[h, i, s].map(padZero).join(':')}`;
}

function bueatifyTime(ms: number) {
	const absMs = Math.abs(ms);
	const d = Math.floor(absMs / 1000 / 60 / 60 / 24);
	const h = Math.floor((absMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
	const m = Math.floor((absMs % (1000 * 60 * 60)) / (1000 * 60));
	const s = Math.floor((absMs % (1000 * 60)) / 1000);
	let str = '';
	if (d) str += `${d}天`;
	if (h) str += `${h}时`;
	if (m) str += `${m}分`;
	if (s) str += `${s}秒`;
	if (ms < -180000) {
		str = '已错过' + str;
	} else if (ms <= 0) {
		str = '即将执行';
	} else {
		str = '将于' + str + '后执行';
	}
	return str;
}
