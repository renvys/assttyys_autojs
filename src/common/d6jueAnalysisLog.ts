/**
 * 六道觉多轮分析日志：追加写入设备外部私有目录 d6jue_analysis.log。
 *
 * 格式：[ISO 时间] run=N 事件 key=value key=value ...
 * - 只用于策略分析，不参与任何运行判断；
 * - 写入失败不影响主流程；
 * - 与 d6jue_perf.log 不同，本文件不覆盖，多次运行会按时间顺序累积。
 *
 * 每次脚本进程启动的第一条日志是 session 头，带 ver=<策略版本>，
 * 这样即使没有 run.start 也能判断设备上跑的是哪一版。
 */

import { D6_LOGIC_VERSION } from './d6jueVersion';

const D6_ANALYSIS_ROTATE_BYTES = 5 * 1024 * 1024;

let sessionStarted = false;
let currentRun = 0;

function rotateIfNeeded(path: string): void {
	try {
		const f = new java.io.File(path);
		if (!f.exists() || f.length() < D6_ANALYSIS_ROTATE_BYTES) return;
		const backup = new java.io.File(path + '.1');
		if (backup.exists()) backup.delete();
		f.renameTo(backup);
	} catch (e) {
		// 轮转失败不影响继续追加
	}
}

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
			rotateIfNeeded(path);
			files.append(path, `=== d6jue analysis session ${new Date().toISOString()} ver=${D6_LOGIC_VERSION} ===\n`);
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
