import type { ImageDataLike } from './autoSelect';

// Auto.js 运行时注入的 Java 桥；单独做类型检查时也可能没有全局声明
declare const java: any;

/**
 * 把 Android Bitmap 转成 autoSelect 需要的 RGBA 像素结构。
 *
 * 用法（Auto.js 运行时）：
 * const bitmap = script.helperBridge.helper.GetBitmap();
 * const image = bitmapToImageData(bitmap);
 * const result = autoSelect([image], [otherImage], { region: { ... } });
 *
 * 注意：调用方负责 bitmap.recycle()；本函数只读取像素，不回收原图。
 */
export function bitmapToImageData(bitmap: any): ImageDataLike {
	const width = bitmap.getWidth();
	const height = bitmap.getHeight();
	const pixels = java.lang.reflect.Array.newInstance(java.lang.Integer.TYPE, width * height);
	bitmap.getPixels(pixels, 0, width, 0, 0, width, height);

	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < pixels.length; i++) {
		const color = pixels[i];
		data[i * 4] = (color >> 16) & 0xff;
		data[i * 4 + 1] = (color >> 8) & 0xff;
		data[i * 4 + 2] = color & 0xff;
		data[i * 4 + 3] = (color >>> 24) & 0xff;
	}

	return { width, height, data };
}
