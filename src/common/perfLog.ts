/**
 * 轻量性能日志：控制台 + 设备文件双写。
 *
 * 文件位置：应用外部私有目录下的 d6jue_perf.log，例如
 * /sdcard/Android/data/com.zzliux.assttyys936debugplayer/files/d6jue_perf.log
 *
 * 每次脚本启动时第一次写入会覆盖旧文件，便于只分析最近一轮。
 * 缓冲区每 20 行或 3 秒落盘一次，避免频繁 I/O 影响计时。
 */

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
			files.write(logPath(), `--- d6jue perf ${new Date().toISOString()} ---\n`);
		} catch (e) {
			// 忽略
		}
		lastFlush = now;
	}
	buffer.push(line);
	if (buffer.length >= 20 || now - lastFlush >= 3000) flush();
}
