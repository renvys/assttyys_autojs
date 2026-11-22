/**
 * 六道觉多轮分析日志：追加写入设备外部私有目录 d6jue_analysis.log。
 *
 * 格式：[ISO 时间] run=N 事件 key=value key=value ...
 * - 只用于策略分析，不参与任何运行判断；
 * - 写入失败不影响主流程；
 * - 与 d6jue_perf.log 不同，本文件不覆盖，多次运行会按时间顺序累积。
 *
 * 建议每轮开始前删除旧文件，或直接按时间戳截取本轮数据。
 */

let sessionStarted = false;
let currentRun = 0;

export function d6jueAnalysisSetRun(run: number): void {
	currentRun = run || 0;
}

export function d6jueAnalysisPath(): string {
	try {
		const dir = context.getExternalFilesDir(null);
		if (!dir) return '';
		return dir.getAbsolutePath() + '/d6jue_analysis.log';
	} catch (e) {
		return '';
	}
}

export function d6jueAnalysisLog(event: string, data?: { [key: string]: string | number | boolean }): void {
	try {
		const path = d6jueAnalysisPath();
		if (!path) return;
		if (!sessionStarted) {
			sessionStarted = true;
			files.append(path, `=== d6jue analysis session ${new Date().toISOString()} ===\n`);
		}
		const parts: string[] = [];
		if (data) {
			for (const key in data) {
				if (Object.prototype.hasOwnProperty.call(data, key)) {
					const value = data[key];
					parts.push(`${key}=${value === undefined || value === null ? '' : value}`);
				}
			}
		}
		files.append(path, `[${new Date().toISOString()}] run=${currentRun} ${event}${parts.length ? ' ' + parts.join(' ') : ''}\n`);
	} catch (e) {
		// 分析日志写入失败不影响主流程
	}
}
