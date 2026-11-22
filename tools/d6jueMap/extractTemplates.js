#!/usr/bin/env node
/**
 * 从 1280x720 截图里提取六道觉小地图图标模板（24x24 灰度）。
 *
 * 用途：游戏更新图标、或需要为宁息/绽放等新岛屿补模板时，生成
 * src/common/d6jueMap.ts 里 RAW_ICON_TEMPLATES 需要的十六进制数据。
 *
 * 用法：
 *   node tools/d6jueMap/extractTemplates.js templates.json
 *
 * templates.json:
 * {
 *   "templates": [
 *     { "key": "ningxi_bright", "type": "宁息", "file": "samples/map.png", "x": 1090, "y": 138 },
 *     { "key": "ningxi_dark",   "type": "宁息", "file": "samples/map2.png", "x": 1167, "y": 55 }
 *   ]
 * }
 *
 * - file：1280x720 截图路径（相对配置文件所在目录）
 * - x/y：图标中心在 1280x720 坐标下的位置，可直接参考同列已有图标的坐标
 * - size：可选，默认 24
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function usage() {
	console.log('用法: node tools/d6jueMap/extractTemplates.js <templates.json>');
	process.exit(1);
}

const configPath = process.argv[2];
if (!configPath) usage();
const configFull = path.resolve(configPath);
const configDir = path.dirname(configFull);
const config = JSON.parse(fs.readFileSync(configFull, 'utf8'));
const templates = config.templates || [];
if (!templates.length) {
	console.error('配置里没有 templates');
	process.exit(1);
}

const cache = {};
function loadPng(file) {
	const full = path.resolve(configDir, file);
	if (!cache[full]) cache[full] = PNG.sync.read(fs.readFileSync(full));
	return cache[full];
}

function extract(item) {
	const size = item.size || 24;
	const png = loadPng(item.file);
	const half = size >> 1;
	let hex = '';
	for (let dy = 0; dy < size; dy++) {
		for (let dx = 0; dx < size; dx++) {
			const x = item.x - half + dx;
			const y = item.y - half + dy;
			if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
				hex += '00';
				continue;
			}
			const i = (y * png.width + x) * 4;
			const gray = Math.round(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]);
			hex += gray.toString(16).padStart(2, '0');
		}
	}
	return { key: item.key, type: item.type, size, hex };
}

const lines = templates.map(item => {
	const t = extract(item);
	return `\t{ key: '${t.key}', type: '${t.type}', size: ${t.size}, data: '${t.hex}' },`;
});

console.log('// 复制到 src/common/d6jueMap.ts 的 RAW_ICON_TEMPLATES：');
console.log(lines.join('\n'));
console.log('\n// 建议把同一岛屿的亮/暗模板都补齐；未匹配到任何模板的节点会记为 unknown。');
