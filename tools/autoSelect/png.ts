import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import type { ImageDataLike } from '../../src/common/autoSelect';

export interface LoadedImage extends ImageDataLike {
    /** 来源文件路径，便于日志和排查 */
    path: string;
}

function walkPng(dir: string, out: string[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkPng(fullPath, out);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
            out.push(fullPath);
        }
    }
}

/**
 * 把文件/目录列表展开成 PNG 文件列表。
 * 目录会递归扫描，结果去重并排序。
 */
export function collectPngs(input: string | string[], baseDir: string): string[] {
    const inputs = Array.isArray(input) ? input : [input];
    const files = new Set<string>();

    for (const item of inputs) {
        const absolute = path.resolve(baseDir, item);
        if (!fs.existsSync(absolute)) {
            throw new Error(`样本路径不存在：${absolute}`);
        }
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            const found: string[] = [];
            walkPng(absolute, found);
            if (found.length === 0) {
                throw new Error(`目录下没有 PNG：${absolute}`);
            }
            found.forEach(file => files.add(file));
        } else if (stat.isFile()) {
            if (!absolute.toLowerCase().endsWith('.png')) {
                throw new Error(`不是 PNG 文件：${absolute}`);
            }
            files.add(absolute);
        }
    }

    return Array.from(files).sort();
}

export function loadPng(file: string): LoadedImage {
    const png = PNG.sync.read(fs.readFileSync(file));
    const pixelCount = png.width * png.height;
    let data: Uint8Array | Uint8ClampedArray;

    if (png.data.length === pixelCount * 4) {
        data = png.data;
    } else if (png.data.length === pixelCount * 3) {
        // 少数 PNG 解码后是 RGB；统一转成 RGBA，核心模块按 4 通道读取
        const rgba = new Uint8ClampedArray(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
            rgba[i * 4] = png.data[i * 3];
            rgba[i * 4 + 1] = png.data[i * 3 + 1];
            rgba[i * 4 + 2] = png.data[i * 3 + 2];
            rgba[i * 4 + 3] = 255;
        }
        data = rgba;
    } else {
        throw new Error(
            `不支持的 PNG 通道数：${file}（data.length=${png.data.length}, ` +
            `${png.width}x${png.height}）`,
        );
    }

    return {
        width: png.width,
        height: png.height,
        data,
        path: file,
    };
}

export function loadImages(input: string | string[], baseDir: string): LoadedImage[] {
    return collectPngs(input, baseDir).map(loadPng);
}
