/**
 * 六道觉小地图异常记录：控制台之外再追加写设备文件，便于事后补图标模板。
 *
 * 文件位置：应用外部私有目录下的 d6jue_unknown.log，例如
 * /sdcard/Android/data/com.zzliux.assttyys936debugplayer/files/d6jue_unknown.log
 *
 * 与 d6jue_perf.log 不同：这里只追加、不覆盖，每条记录带 ISO 时间戳，
 * 停止脚本后仍可回溯历史 unknown 记录。
 */

export function d6jueUnknownLog(line: string): void {
	try {
		const dir = context.getExternalFilesDir(null);
		if (!dir) return;
		files.append(
			dir.getAbsolutePath() + '/d6jue_unknown.log',
			`[${new Date().toISOString()}] ${line}\n`,
		);
	} catch (e) {
		// 记录失败不能影响主流程
	}
}
