/**
 * 六道觉步数状态机（纯逻辑，不依赖 Auto.js / 截图 / OCR）。
 *
 * 设计目标：
 * 1. 步数推进以“地图行推进”为主：点击岛屿 -> 观测到岛屿界面（或计数器下降）
 *    -> 下一次稳定、完整解析的小地图 -> 剩余步数 -1。
 * 2. 单次地图签名变化不能直接算一步：转场帧、气泡/动画抖动、连续两行结构
 *    完全相同都会误判。因此只有“岛屿证据 + 稳定新行”才计数。
 * 3. 回合数字模板读数只做校验/恢复：
 *    - 开局/中途接手时用来初始化；
 *    - 比当前步数低且连续两次一致时接受（补漏读）；大跳变/疑似丢前导 1 时要求三次；
 *    - 比当前步数高时忽略（旧值/误读），绝不把步数往回加。
 * 4. 岛屿 key 用独立自增序号，不用 stepLeft 反推；点击失败重试沿用同一序号。
 * 5. 绽放固定在第 5/10/15/20 步：可达行出现绽放但步号不是倍数时，优先记录；
 *    只允许“少算”方向的安全纠偏。
 *
 * 修改本模块后必须运行：npm run test:d6jue-step
 */

export type D6StepPhase = 'map' | 'pending';

export interface D6StepTrackerOptions {
	/** 总步数，孔雀国为 20 */
	totalSteps: number;
	/** 同一行地图结构至少保持多久才视为稳定 */
	settleMs: number;
	/** 点击后同一行/同一画面保持多久才允许重试（未离图） */
	retryMinMs: number;
	/** 点击后地图画面哈希变化时，延长到多久才允许重试 */
	retryHashChangedMs: number;
	/** 没有岛屿证据、但地图行已变化且稳定多久后，允许弱确认 */
	weakRowMs: number;
	/** 计数器最低置信度 */
	counterMinConfidence: number;
	/** 绽放固定间隔（5 步） */
	bloomEvery: number;
	/** 绽放纠偏允许的最大步号差 */
	bloomFixMaxGap: number;
	/** 两次相同计数器读数允许的最大间隔 */
	counterConfirmGapMs: number;
}

export interface D6StepMapObservation {
	time: number;
	/** 地图行量化指纹（类型 + 量化坐标 + 定位针） */
	rowKey: string;
	/** 是否完整解析：1~4 个已知节点，无 unknown */
	valid: boolean;
	/** 小地图画面哈希，用于识别转场动画 */
	mapHash?: string;
	/** 当前可达行是否包含绽放 */
	bloom?: boolean;
}

export interface D6StepUpdate {
	left: number;
	consumed: number;
	islandSeq: number;
	stepNo: number;
	phase: D6StepPhase;
	pending: boolean;
	committed: boolean;
	stable: boolean;
	/** 当前阶段可用的稳定信号：归图阶段看归图后的稳定时间，其余看行稳定时间 */
	settled: boolean;
	/** 距离稳定还差多少毫秒（0 表示已稳定）；供运行时精确 sleep，避免多次轮询 */
	waitMs: number;
	confirmed: boolean;
	retry: boolean;
	reason: string;
	evidence: string;
	elapsed: number;
	alerts: string[];
	leftBefore: number;
}

export interface D6StepCounterUpdate {
	accepted: boolean;
	committed: boolean;
	confirmed: boolean;
	left: number;
	consumed: number;
	islandSeq: number;
	stepNo: number;
	leftBefore: number;
	leftAfter: number;
	reason: string;
	alerts: string[];
}

const DEFAULT_OPTIONS: D6StepTrackerOptions = {
	totalSteps: 20,
	settleMs: 1000,
	retryMinMs: 4000,
	retryHashChangedMs: 8000,
	weakRowMs: 3500,
	counterMinConfidence: 0.55,
	bloomEvery: 5,
	bloomFixMaxGap: 2,
	counterConfirmGapMs: 2000,
};

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export class D6StepTracker {
	private opts: D6StepTrackerOptions;

	private leftValue: number;
	private consumedValue: number;
	private seqValue: number;
	private initializedValue: boolean;

	private phaseValue: D6StepPhase;
	private pendingRowKey: string;
	private pendingHash: string;
	private pendingTime: number;
	private pendingLeft: number;
	private committedValue: boolean;
	private evidenceValue: string;
	/** 已离图后第一次看到地图的时间/行：归图也要重新稳定，避免在回图动画/输入锁里点击 */
	private returnRowKey: string;
	private returnSince: number;

	private seenRowKey: string;
	private seenSince: number;
	private seenValid: boolean;
	/** 当前稳定地图行是否包含绽放，用于防止计数器把绽放步纠偏回去 */
	private currentBloomValue: boolean;

	private counterCandidateValue: number;
	private counterCandidateTime: number;
	private counterCandidateCount: number;

	/** 计数器持续偏高（计算值偏小）的候选：必须跨不同地图行连续成立才纠正 */
	private higherRowKey: string;
	private higherDelta: number;
	private higherRowCount: number;
	/** 最近一次 weak_row 确认前的快照；计数器证明没推进时用于回滚 */
	private weakSnapshot: { left: number; consumed: number; seq: number } | null;

	constructor(options?: Partial<D6StepTrackerOptions>) {
		this.opts = {
			totalSteps: options && options.totalSteps !== undefined ? options.totalSteps : DEFAULT_OPTIONS.totalSteps,
			settleMs: options && options.settleMs !== undefined ? options.settleMs : DEFAULT_OPTIONS.settleMs,
			retryMinMs: options && options.retryMinMs !== undefined ? options.retryMinMs : DEFAULT_OPTIONS.retryMinMs,
			retryHashChangedMs: options && options.retryHashChangedMs !== undefined
				? options.retryHashChangedMs
				: DEFAULT_OPTIONS.retryHashChangedMs,
			weakRowMs: options && options.weakRowMs !== undefined ? options.weakRowMs : DEFAULT_OPTIONS.weakRowMs,
			counterMinConfidence: options && options.counterMinConfidence !== undefined
				? options.counterMinConfidence
				: DEFAULT_OPTIONS.counterMinConfidence,
			bloomEvery: options && options.bloomEvery !== undefined ? options.bloomEvery : DEFAULT_OPTIONS.bloomEvery,
			bloomFixMaxGap: options && options.bloomFixMaxGap !== undefined
				? options.bloomFixMaxGap
				: DEFAULT_OPTIONS.bloomFixMaxGap,
			counterConfirmGapMs: options && options.counterConfirmGapMs !== undefined
				? options.counterConfirmGapMs
				: DEFAULT_OPTIONS.counterConfirmGapMs,
		};
		this.leftValue = this.opts.totalSteps;
		this.consumedValue = 0;
		this.seqValue = 0;
		this.initializedValue = true;
		this.phaseValue = 'map';
		this.clearPending();
		this.seenRowKey = '';
		this.seenSince = 0;
		this.seenValid = false;
		this.currentBloomValue = false;
		this.returnRowKey = '';
		this.returnSince = 0;
		this.clearCounterCandidate();
		this.higherRowKey = '';
		this.higherDelta = 0;
		this.higherRowCount = 0;
		this.weakSnapshot = null;
	}

	configure(options?: Partial<D6StepTrackerOptions>): void {
		if (!options) return;
		if (options.totalSteps !== undefined) this.opts.totalSteps = options.totalSteps;
		if (options.settleMs !== undefined) this.opts.settleMs = options.settleMs;
		if (options.retryMinMs !== undefined) this.opts.retryMinMs = options.retryMinMs;
		if (options.retryHashChangedMs !== undefined) this.opts.retryHashChangedMs = options.retryHashChangedMs;
		if (options.weakRowMs !== undefined) this.opts.weakRowMs = options.weakRowMs;
		if (options.counterMinConfidence !== undefined) this.opts.counterMinConfidence = options.counterMinConfidence;
		if (options.bloomEvery !== undefined) this.opts.bloomEvery = options.bloomEvery;
		if (options.bloomFixMaxGap !== undefined) this.opts.bloomFixMaxGap = options.bloomFixMaxGap;
		if (options.counterConfirmGapMs !== undefined) this.opts.counterConfirmGapMs = options.counterConfirmGapMs;
		this.leftValue = clamp(this.leftValue, 0, this.opts.totalSteps);
		this.consumedValue = this.opts.totalSteps - this.leftValue;
		if (this.seqValue < this.consumedValue) this.seqValue = this.consumedValue;
	}

	/**
	 * 重置本局。initialized=false 表示这是中途接手：允许计数器用较低的读数初始化。
	 */
	reset(left?: number, initialized?: boolean, time?: number): void {
		const initialLeft = left === undefined ? this.opts.totalSteps : clamp(left, 0, this.opts.totalSteps);
		this.leftValue = initialLeft;
		this.consumedValue = this.opts.totalSteps - initialLeft;
		this.seqValue = this.consumedValue;
		this.initializedValue = initialized === undefined ? true : !!initialized;
		this.phaseValue = 'map';
		this.clearPending();
		this.seenRowKey = '';
		this.seenSince = time === undefined ? 0 : time;
		this.seenValid = false;
		this.currentBloomValue = false;
		this.returnRowKey = '';
		this.returnSince = 0;
		this.clearCounterCandidate();
		this.higherRowKey = '';
		this.higherDelta = 0;
		this.higherRowCount = 0;
		this.weakSnapshot = null;
	}

	get left(): number {
		return this.leftValue;
	}

	get consumed(): number {
		return this.consumedValue;
	}

	get islandSeq(): number {
		return this.seqValue;
	}

	/** 下一次点击应使用的岛屿序号（重试时不变） */
	get nextIslandSeq(): number {
		return this.seqValue + 1;
	}

	/** 当前地图行对应第几步（0 表示已结束） */
	get stepNo(): number {
		return this.leftValue > 0 ? this.opts.totalSteps - this.leftValue + 1 : 0;
	}

	get pending(): boolean {
		return this.phaseValue === 'pending';
	}

	get committed(): boolean {
		return this.committedValue;
	}

	get initialized(): boolean {
		return this.initializedValue;
	}

	/** 是否有一个偏低读数在等待第二次确认 */
	get counterPending(): boolean {
		return this.counterCandidateCount > 0;
	}

	get phase(): D6StepPhase {
		return this.phaseValue;
	}

	/** 放弃当前读数候选（连续重读失败/换行时调用，避免永远等待） */
	cancelCounterCandidate(): void {
		this.clearCounterCandidate();
		this.clearHigherCandidate();
	}

	/**
	 * 回滚最近一次 weak_row 确认。
	 * 调用方用计数器确认“这次点击没有消耗一步”后调用；回滚后 phase=map，
	 * 步数和岛屿序号恢复到点击前，可以按点击失败重试当前行。
	 */
	revertLastWeakStep(): boolean {
		const snap = this.weakSnapshot;
		if (!snap) return false;
		this.leftValue = clamp(snap.left, 0, this.opts.totalSteps);
		this.consumedValue = this.opts.totalSteps - this.leftValue;
		this.seqValue = snap.seq;
		this.weakSnapshot = null;
		this.clearCounterCandidate();
		this.clearHigherCandidate();
		this.clearPending();
		this.initializedValue = true;
		return true;
	}

	/**
	 * 观测一帧小地图。valid=false 时只刷新稳定状态，不结算待确认步。
	 */
	observeMap(obs: D6StepMapObservation): D6StepUpdate {
		const time = obs.time;
		const beforeLeft = this.leftValue;
		const alerts: string[] = [];

		if (!obs.valid) {
			this.seenValid = false;
			this.seenRowKey = '';
			this.seenSince = time;
			this.currentBloomValue = false;
			this.returnRowKey = '';
			this.returnSince = 0;
			this.clearCounterCandidate();
			this.clearHigherCandidate();
			return this.makeUpdate(beforeLeft, false, false, 'invalid', alerts, time);
		}

		this.currentBloomValue = !!obs.bloom;

		if (obs.rowKey !== this.seenRowKey) {
			this.seenRowKey = obs.rowKey;
			this.seenSince = time;
			this.seenValid = true;
			// 换行后旧的偏低读数候选不再可信，必须在新行重新读两次。
			this.clearCounterCandidate();
		} else if (!this.seenValid) {
			this.seenValid = true;
			this.seenSince = time;
		}
		const stable = this.seenValid && time - this.seenSince >= this.opts.settleMs;

		if (this.phaseValue === 'pending') {
			const elapsed = time - this.pendingTime;
			const sameRow = !!this.pendingRowKey && obs.rowKey === this.pendingRowKey;
			const hashChanged = !!this.pendingHash && !!obs.mapHash && obs.mapHash !== this.pendingHash;

			if (this.committedValue) {
				// 归图也要重新稳定：连续两行结构完全相同时，行指纹不会变化，
				// 不能沿用点击前的稳定时间，否则会在回图动画/输入锁里立刻点击。
				if (obs.rowKey !== this.returnRowKey) {
					this.returnRowKey = obs.rowKey;
					this.returnSince = time;
				}
				const returnStable = time - this.returnSince >= this.opts.settleMs;
				if (returnStable) {
					const evidence = this.evidenceValue || 'island';
					const pendingElapsed = time - this.pendingTime;
					this.consumeStep();
					return this.makeUpdate(beforeLeft, true, false, evidence, alerts, time, true, pendingElapsed);
				}
				return this.makeUpdate(beforeLeft, false, false, 'return_wait', alerts, time, false);
			}

			if (sameRow) {
				const retryAfter = hashChanged ? this.opts.retryHashChangedMs : this.opts.retryMinMs;
				if (stable && elapsed >= retryAfter) {
					this.clearPending();
					if (hashChanged) alerts.push('retry_hash_changed');
					return this.makeUpdate(beforeLeft, false, true, 'click_failed', alerts, time, undefined, elapsed);
				}
				return this.makeUpdate(beforeLeft, false, false, hashChanged ? 'animating' : 'pending', alerts, time);
			}

			// 地图行已变化但没有岛屿证据：先等稳定，超过 weakRowMs 才弱确认。
			// weak 确认可能把“点击失败但画面变了”误算成一步；调用方会用计数器
			// 再次校验，并可通过 revertLastWeakStep() 回滚。
			if (stable && elapsed >= this.opts.weakRowMs) {
				const snapshot = { left: this.leftValue, consumed: this.consumedValue, seq: this.seqValue };
				this.consumeStep();
				this.weakSnapshot = snapshot;
				alerts.push('weak_row_confirm');
				return this.makeUpdate(beforeLeft, true, false, 'weak_row', alerts, time, undefined, elapsed);
			}
			return this.makeUpdate(beforeLeft, false, false, 'row_changed_wait', alerts, time);
		}

		if (stable && obs.bloom) {
			this.applyBloomCheck(alerts);
		}
		return this.makeUpdate(beforeLeft, false, false, 'map', alerts, time);
	}

	/**
	 * 记录一次岛屿界面证据。只标记 committed，真正扣步仍等下一次稳定地图。
	 */
	noteIsland(time: number, source: string): boolean {
		if (this.phaseValue !== 'pending') return false;
		if (this.committedValue) return false;
		this.committedValue = true;
		this.evidenceValue = source || 'island';
		this.returnRowKey = '';
		this.returnSince = 0;
		return true;
	}

	/**
	 * 记录一次已发出的点击。重试时不要重复调用；调用方只能在 phase=map 时调用。
	 */
	noteClick(time: number, rowKey: string, mapHash?: string): void {
		if (this.phaseValue === 'pending') return;
		this.phaseValue = 'pending';
		this.pendingRowKey = rowKey || '';
		this.pendingHash = mapHash || '';
		this.pendingTime = time;
		this.pendingLeft = this.leftValue;
		this.committedValue = false;
		this.evidenceValue = '';
		this.returnRowKey = '';
		this.returnSince = 0;
		this.clearCounterCandidate();
		this.weakSnapshot = null;
	}

	/**
	 * 记录一次回合数字读数。只有 phase=map 且地图已稳定时才允许校准；
	 * 待确认期间只用于判断计数器是否下降（不直接校准）。
	 */
	noteCounter(
		time: number,
		counterLeft: number,
		confidence: number,
		stable: boolean,
		rowKey?: string,
	): D6StepCounterUpdate {
		const beforeLeft = this.leftValue;
		const alerts: string[] = [];
		if (!isFinite(counterLeft)) {
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'invalid', alerts);
		}
		const value = clamp(Math.round(counterLeft), 0, this.opts.totalSteps);
		if (confidence < this.opts.counterMinConfidence) {
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'low_confidence', alerts);
		}

		if (this.phaseValue === 'pending') {
			if (value < this.pendingLeft) {
				// 没有岛屿证据时，计数器下降也要连续一致才确认：
				// 正常 1 步要求两次；大跳变/个位数疑似丢前导 1 时要求三次。
				const drop = this.pendingLeft - value;
				const required = this.counterRequiredReads(drop, value);
				if (!this.committedValue && !this.confirmCounterCandidate(value, time, required)) {
					return this.makeCounterUpdate(beforeLeft, false, false, false, 'counter_drop_wait', alerts);
				}
				this.committedValue = true;
				this.evidenceValue = 'counter';
				// 计数器下降只标记 committed；真正扣步等下一次归图稳定后的 observeMap，
				// 与“下一次地图解析成功才 +1”的语义保持一致。
				return this.makeCounterUpdate(beforeLeft, false, true, false, 'counter_drop_wait', alerts);
			}
			if (value > this.pendingLeft) {
				this.clearCounterCandidate();
				return this.makeCounterUpdate(beforeLeft, false, false, false, 'higher_pending', alerts);
			}
			this.clearCounterCandidate();
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'equal_pending', alerts);
		}

		if (!stable) {
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'unstable', alerts);
		}

		// 绽放行只允许落在 5/10/15/20 步；如果计数器想把已纠偏的绽放步拉回非倍数，
		// 以绽放规则为准（中途接手尚未初始化时除外，此时计数器是唯一绝对信息）。
		if (this.initializedValue && this.currentBloomValue && value !== this.leftValue) {
			const bloomStepNo = this.opts.totalSteps - value + 1;
			const drop = this.leftValue - value;
			if (bloomStepNo % this.opts.bloomEvery !== 0 || drop > 2) {
				this.clearCounterCandidate();
				return this.makeCounterUpdate(beforeLeft, false, false, false, 'bloom_conflict', alerts);
			}
		}

		// 上一局 boss 已把 left 置 0，又出现新的地图：只有接近满步数的读数才当成新一局，
		// 避免 boss 失败回地图时把 0/1 步误判成新局。
		if (this.leftValue <= 0 && value >= this.opts.totalSteps - 1) {
			if (this.confirmCounterCandidate(value, time, 2)) {
				this.applyCalibration(value);
				this.initializedValue = true;
				alerts.push('restart_calibrated');
				return this.makeCounterUpdate(beforeLeft, true, false, false, 'restart', alerts);
			}
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'restart_wait', alerts);
		}

		if (!this.initializedValue) {
			if (value === this.leftValue) {
				this.initializedValue = true;
				this.clearCounterCandidate();
				return this.makeCounterUpdate(beforeLeft, true, false, false, 'init_match', alerts);
			}
			if (value < this.leftValue) {
				const required = this.counterRequiredReads(this.leftValue - value, value);
				if (this.confirmCounterCandidate(value, time, required)) {
					this.applyCalibration(value);
					this.initializedValue = true;
					alerts.push('resume_calibrated');
					return this.makeCounterUpdate(beforeLeft, true, false, false, 'resume', alerts);
				}
				return this.makeCounterUpdate(beforeLeft, false, false, false, 'resume_wait', alerts);
			}
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'higher', alerts);
		}

		if (value === this.leftValue) {
			this.clearCounterCandidate();
			this.clearHigherCandidate();
			return this.makeCounterUpdate(beforeLeft, true, false, false, 'match', alerts);
		}
		if (value < this.leftValue) {
			// 向下校准：普通漏 1~2 步要求连续两次一致；大跳变或个位数疑似丢前导 1 时要求三次。
			this.clearHigherCandidate();
			const drop = this.leftValue - value;
			const required = this.counterRequiredReads(drop, value);
			if (this.confirmCounterCandidate(value, time, required)) {
				this.applyCalibration(value);
				alerts.push(drop === 1 ? 'gap_1' : 'gap_' + drop);
				return this.makeCounterUpdate(beforeLeft, true, false, false, 'lower', alerts);
			}
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'lower_wait', alerts);
		}

		// 计数器比计算值高：可能是旧行读数，也可能是计算多算了一步。
		// - 绽放行：计数器指向 5 的倍数而当前不是，直接按绽放锚点纠正；
		// - 普通行：同一正差值连续跨两个不同地图行才纠正，避免单行旧值误判。
		// 注意：这里不阻塞点击；即使本行没纠正，下一行也会在点击前把步数拉回。
		const higherDelta = value - this.leftValue;
		if (higherDelta > 2 || !rowKey || confidence < 0.8) {
			this.clearHigherCandidate();
			return this.makeCounterUpdate(beforeLeft, false, false, false, 'higher', alerts);
		}
		if (this.initializedValue && this.currentBloomValue) {
			const counterStepNo = this.opts.totalSteps - value + 1;
			if (counterStepNo % this.opts.bloomEvery === 0 && this.stepNo % this.opts.bloomEvery !== 0) {
				this.applyCalibration(value);
				alerts.push('higher_bloom_fix');
				return this.makeCounterUpdate(beforeLeft, true, false, false, 'higher_bloom', alerts);
			}
		}
		if (rowKey !== this.higherRowKey) {
			if (this.higherDelta === higherDelta && this.higherRowCount > 0) {
				this.higherRowCount++;
			} else {
				this.higherRowCount = 1;
				this.higherDelta = higherDelta;
			}
			this.higherRowKey = rowKey;
		} else if (this.higherDelta !== higherDelta) {
			this.higherRowCount = 1;
			this.higherDelta = higherDelta;
		}
		if (this.higherRowCount >= 2) {
			this.applyCalibration(value);
			alerts.push('higher_recover');
			return this.makeCounterUpdate(beforeLeft, true, false, false, 'higher_recover', alerts);
		}
		return this.makeCounterUpdate(beforeLeft, false, false, false, 'higher_wait', alerts);
	}

	/** 偏低读数需要几次一致：大跳变/疑似丢前导 1 时要求三次 */
	private counterRequiredReads(drop: number, value: number): number {
		if (drop > 2) return 3;
		if (this.leftValue >= 10 && value < 10) return 3;
		return 2;
	}

	noteBoss(): void {
		this.clearPending();
		this.clearCounterCandidate();
		this.clearHigherCandidate();
		this.leftValue = 0;
		this.consumedValue = this.opts.totalSteps;
		this.seqValue = Math.max(this.seqValue, this.consumedValue);
		this.initializedValue = true;
	}

	private consumeStep(): void {
		if (this.leftValue > 0) {
			this.leftValue -= 1;
			this.consumedValue = this.opts.totalSteps - this.leftValue;
			if (this.seqValue < this.consumedValue) this.seqValue = this.consumedValue;
		}
		this.initializedValue = true;
		this.clearPending();
		this.clearCounterCandidate();
		this.weakSnapshot = null;
	}

	private applyCalibration(newLeft: number): void {
		this.leftValue = clamp(newLeft, 0, this.opts.totalSteps);
		this.consumedValue = this.opts.totalSteps - this.leftValue;
		if (this.seqValue < this.consumedValue) this.seqValue = this.consumedValue;
		this.initializedValue = true;
		this.clearCounterCandidate();
		this.clearHigherCandidate();
		this.weakSnapshot = null;
	}

	private confirmCounterCandidate(value: number, time: number, requiredCount: number): boolean {
		if (this.counterCandidateValue === value && time - this.counterCandidateTime <= this.opts.counterConfirmGapMs) {
			this.counterCandidateCount++;
		} else {
			this.counterCandidateValue = value;
			this.counterCandidateCount = 1;
		}
		this.counterCandidateTime = time;
		return this.counterCandidateCount >= requiredCount;
	}

	private clearCounterCandidate(): void {
		this.counterCandidateValue = -1;
		this.counterCandidateTime = 0;
		this.counterCandidateCount = 0;
	}

	private clearHigherCandidate(): void {
		this.higherRowKey = '';
		this.higherDelta = 0;
		this.higherRowCount = 0;
	}

	private clearPending(): void {
		this.phaseValue = 'map';
		this.pendingRowKey = '';
		this.pendingHash = '';
		this.pendingTime = 0;
		this.pendingLeft = this.leftValue;
		this.committedValue = false;
		this.evidenceValue = '';
		this.returnRowKey = '';
		this.returnSince = 0;
	}

	private applyBloomCheck(alerts: string[]): void {
		const stepNo = this.stepNo;
		if (stepNo <= 0) return;
		const mod = stepNo % this.opts.bloomEvery;
		if (mod === 0) return;
		const expected = stepNo + (this.opts.bloomEvery - mod);
		const gap = expected - stepNo;
		if (expected <= this.opts.totalSteps && gap <= this.opts.bloomFixMaxGap) {
			const newLeft = this.opts.totalSteps - (expected - 1);
			// 只允许少算方向的纠偏：newLeft < left 表示多消耗了步数。
			if (newLeft < this.leftValue) {
				this.leftValue = newLeft;
				this.consumedValue = this.opts.totalSteps - newLeft;
				if (this.seqValue < this.consumedValue) this.seqValue = this.consumedValue;
				this.initializedValue = true;
				alerts.push('bloom_fix:' + stepNo + '->' + expected);
				// 纠偏后当前行就是预期步，不再重复告警。
				return;
			}
		}
		alerts.push('bloom_mismatch:' + stepNo);
	}

	private makeUpdate(
		beforeLeft: number,
		confirmed: boolean,
		retry: boolean,
		reason: string,
		alerts: string[],
		time: number,
		settledOverride?: boolean,
		elapsedOverride?: number,
	): D6StepUpdate {
		const seenStable = this.seenValid && time - this.seenSince >= this.opts.settleMs;
		const elapsed = elapsedOverride === undefined
			? (this.phaseValue === 'pending' ? time - this.pendingTime : 0)
			: elapsedOverride;
		let waitMs = 0;
		if (this.phaseValue === 'pending') {
			if (this.committedValue) waitMs = Math.max(0, this.opts.settleMs - (time - this.returnSince));
		} else if (this.seenValid) {
			waitMs = Math.max(0, this.opts.settleMs - (time - this.seenSince));
		}
		return {
			left: this.leftValue,
			consumed: this.consumedValue,
			islandSeq: this.seqValue,
			stepNo: this.stepNo,
			phase: this.phaseValue,
			pending: this.phaseValue === 'pending',
			committed: this.committedValue,
			stable: seenStable,
			settled: settledOverride === undefined ? seenStable : settledOverride,
			waitMs: waitMs,
			confirmed: confirmed,
			retry: retry,
			reason: reason,
			evidence: this.evidenceValue,
			elapsed: elapsed,
			alerts: alerts,
			leftBefore: beforeLeft,
		};
	}

	private makeCounterUpdate(
		beforeLeft: number,
		accepted: boolean,
		committed: boolean,
		confirmed: boolean,
		reason: string,
		alerts: string[],
	): D6StepCounterUpdate {
		return {
			accepted: accepted,
			committed: committed,
			confirmed: confirmed,
			left: this.leftValue,
			consumed: this.consumedValue,
			islandSeq: this.seqValue,
			stepNo: this.stepNo,
			leftBefore: beforeLeft,
			leftAfter: this.leftValue,
			reason: reason,
			alerts: alerts,
		};
	}
}
