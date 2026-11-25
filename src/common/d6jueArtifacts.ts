/**
 * 六道觉调试产物清理。
 *
 * 六道觉运行时会为补取色/补模板保存 d6jue_*.png，perf 日志也会按轮次累积；
 * 这些文件默认不清，长时间挂机会把应用外部私有目录堆到几百 MB。
 * 每次开局前做一次轻量清理：
 * - 截图按文件名里的毫秒时间戳排序，只保留最近 D6_KEEP_SHOTS 张；
 * - d6jue_perf.log 超过 D6_PERF_MAX_SIZE 时删除（纯性能数据，策略数据在 analysis 日志）；
 * - d6jue_analysis.log / d6jue_unknown.log 是分析依据，不自动删除。
 *
 * 清理失败不影响主流程。
 */

import { isD6DebugMode } from './d6jueVersion';

const D6_KEEP_SHOTS = 60;
const D6_PERF_MAX_SIZE = 2 * 1024 * 1024;

let pruned = false;

// 截图名都以 _<毫秒时间戳>.png 结尾；解析失败按最旧处理
function shotTime(name: string): number {
	const m = /_(\d{10,})\.png$/.exec(name);
	return m ? parseInt(m[1], 10) : 0;
}

function fileSize(path: string): number {
	try {
		return new java.io.File(path).length();
	} catch (e) {
		return 0;
	}
}

export function d6juePruneArtifacts(): void {
	if (!isD6DebugMode()) return;
	// 每个脚本进程只清理一次，多次开局不重复扫目录
	if (pruned) return;
	pruned = true;
	try {
		const dir = context.getExternalFilesDir(null);
		if (!dir) return;
		const base = dir.getAbsolutePath();
		let removedShots = 0;
		const shots: string[] = [];
		const names = files.listDir(base) as string[];
		for (let i = 0; i < names.length; i++) {
			if (/^d6jue_.*\.png$/.test(names[i])) shots.push(names[i]);
		}
		if (shots.length > D6_KEEP_SHOTS) {
			shots.sort((a, b) => shotTime(b) - shotTime(a));
			for (let i = D6_KEEP_SHOTS; i < shots.length; i++) {
				try {
					files.remove(base + '/' + shots[i]);
					removedShots++;
				} catch (e) {
					// 单个文件删除失败继续
				}
			}
		}
		const perf = base + '/d6jue_perf.log';
		if (fileSize(perf) > D6_PERF_MAX_SIZE) {
			try {
				files.remove(perf);
			} catch (e) {
				// 忽略
			}
		}
		if (removedShots > 0) {
			console.log(`[d6jue-artifacts] 清理旧截图 ${removedShots} 张`);
		}
	} catch (e) {
		// 清理失败不影响主流程
	}
}
