import * as fs from 'fs';
import { PNG } from 'pngjs';
import { mapPoint, type AutoSelectPoint, type Rect } from '../../src/common/autoSelect';
import type { LoadedImage } from './png';

type Rgba = [number, number, number, number];

function setPixel(png: PNG, x: number, y: number, color: Rgba): void {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const index = (y * png.width + x) * 4;
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = color[3];
}

function drawRect(
    png: PNG,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Rgba,
    thickness = 2,
): void {
    for (let i = 0; i < thickness; i++) {
        for (let x = x0; x <= x1; x++) {
            setPixel(png, x, y0 + i, color);
            setPixel(png, x, y1 - i, color);
        }
        for (let y = y0; y <= y1; y++) {
            setPixel(png, x0 + i, y, color);
            setPixel(png, x1 - i, y, color);
        }
    }
}

function drawCross(png: PNG, x: number, y: number, size: number, color: Rgba): void {
    for (let d = -size; d <= size; d++) {
        setPixel(png, x + d, y, color);
        setPixel(png, x, y + d, color);
    }
    // 中心点加粗，方便在缩略图里定位
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            setPixel(png, x + dx, y + dy, color);
        }
    }
}

/**
 * 生成一张预览图：
 * - 绿色框：AI/人工确认的识别范围；
 * - 橙色十字：自动选出的点。
 *
 * 用于人工确认范围是否合理，以及点是否落在预期的 UI 上。
 */
export function writePreview(
    image: LoadedImage,
    region: Rect | null,
    points: AutoSelectPoint[],
    devWidth: number,
    devHeight: number,
    outPath: string,
): void {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data);

    if (region) {
        const scaleX = image.width / devWidth;
        const scaleY = image.height / devHeight;
        const x0 = Math.round(region.x0 * scaleX);
        const y0 = Math.round(region.y0 * scaleY);
        const x1 = Math.round(region.x1 * scaleX);
        const y1 = Math.round(region.y1 * scaleY);
        drawRect(png, x0, y0, x1, y1, [0, 255, 0, 255], 2);
    }

    for (const point of points) {
        const mapped = mapPoint(
            point.anchor,
            point.x,
            point.y,
            devWidth,
            devHeight,
            image.width,
            image.height,
        );
        drawCross(png, mapped.x, mapped.y, 6, [255, 128, 0, 255]);
    }

    fs.writeFileSync(outPath, PNG.sync.write(png));
}
