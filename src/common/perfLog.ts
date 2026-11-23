/**
 * 轻量性能日志：控制台 + 设备文件双写。
 *
 * 文件位置：应用外部私有目录下的 d6jue_perf.log，例如
 * /sdcard/Android/data/com.zzliux.assttyys936debugplayer/files/d6jue_perf.log
 *
 * 追加写入，不覆盖；每次脚本启动写入一条 session 分隔行，便于多轮分析。
 * 每行带 ISO 时间戳，可与 d6jue_analysis.log 对照。
 * session 头带 ver=<策略版本>，用于确认设备上跑的是哪一版。
 * 缓冲区每 20 行或 3 秒落盘一次，避免频繁 I/O 影响计时。
 */

import { D6_LOGIC_VERSION } from './d6jueVersion';

let buffer: string[] = [];
let started = false;
let lastFlush = 0;

function logPath(): string {
	const dir = context.getExternalFilesDir(null);
	if (!dir) throw new Error('external files dir is null');
	return dir.getAbsolutePath() + '/d6jue_perf.log';
}

function flush(): void {
	if (buffer.length === 0) return;
	try {
		files.append(logPath(), buffer.join('\n') + '\n');
	} catch (e) {
		// 忽略日志写入异常，不能影响主流程
	}
	buffer = [];
	lastFlush = new Date().getTime();
}

export function perfLogLine(line: string): void {
	const now = new Date().getTime();
	if (!started) {
		started = true;
		try {
			files.append(logPath(), `--- d6jue perf session ${new Date().toISOString()} ver=${D6_LOGIC_VERSION} ---\n`);
		} catch (e) {
			// 忽略
		}
		lastFlush = now;
	}
	buffer.push(`[${new Date(now).toISOString()}] ${line}`);
	if (buffer.length >= 20 || now - lastFlush >= 3000) flush();
}
