import {
    ANCHOR,
    autoSelect,
    DEFAULT_AUTO_SELECT_OPTIONS,
    formatDesc,
    mapPoint,
    scriptLibRound,
    toDesc,
    toHexColor,
    validateSelection,
    type AutoSelectResult,
    type ImageDataLike,
} from '../../../src/common/autoSelect';

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}（实际 ${String(actual)}，期望 ${String(expected)}）`);
    }
}

type RGB = [number, number, number];

function clampChannel(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function makeImage(
    width: number,
    height: number,
    painter: (x: number, y: number) => RGB,
): ImageDataLike {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = painter(x, y);
            const index = (y * width + x) * 4;
            data[index] = r;
            data[index + 1] = g;
            data[index + 2] = b;
            data[index + 3] = 255;
        }
    }
    return { width, height, data };
}

function seededNoise(seed: number, amplitude: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return (state % (amplitude * 2 + 1)) - amplitude;
    };
}

/**
 * 64x36 测试图：
 * - (10,10)-(13,13) 是状态补丁；
 * - (40,14)-(55,25) 是动态噪声区；
 * - 其余区域是稳定背景。
 */
function makeState(background: RGB, patch: RGB, seed: number): ImageDataLike {
    const noise = seededNoise(seed, 3);
    return makeImage(64, 36, (x, y) => {
        let [r, g, b] = background;
        if (x >= 10 && x < 14 && y >= 10 && y < 14) {
            [r, g, b] = patch;
        }
        if (x >= 40 && x < 56 && y >= 14 && y < 26) {
            r += noise();
            g += noise();
            b += noise();
        }
        return [clampChannel(r), clampChannel(g), clampChannel(b)];
    });
}

function scaleImage(image: ImageDataLike, factor: number): ImageDataLike {
    return makeImage(image.width * factor, image.height * factor, (x, y) => {
        const sourceX = Math.floor(x / factor);
        const sourceY = Math.floor(y / factor);
        const index = (sourceY * image.width + sourceX) * 4;
        return [image.data[index], image.data[index + 1], image.data[index + 2]];
    });
}

function assertPoint(
    actual: { x: number; y: number },
    expectedX: number,
    expectedY: number,
    message: string,
): void {
    assertEqual(actual.x, expectedX, `${message} x`);
    assertEqual(actual.y, expectedY, `${message} y`);
}

const TEST_OPTIONS = {
    devWidth: 64,
    devHeight: 36,
    gridStep: 1,
    border: 2,
    maxPoints: 4,
    minDistance: 8,
    positiveTolerance: 2,
    flatTolerance: 2,
    negativeMargin: 10,
    similar: 93,
};

const BACKGROUND: RGB = [20, 30, 40];
const RED: RGB = [200, 40, 40];
const BLUE: RGB = [40, 40, 200];
const GRAY: RGB = [100, 100, 100];

function makeSamples() {
    const positives = [
        makeState(BACKGROUND, RED, 1),
        makeState(BACKGROUND, RED, 2),
        makeState(BACKGROUND, RED, 3),
    ];
    const negatives = [
        makeState(BACKGROUND, BLUE, 4),
        makeState(GRAY, RED, 5),
    ];
    return { positives, negatives };
}

function testRegionSelection(): void {
    const { positives, negatives } = makeSamples();
    const result = autoSelect(positives, negatives, {
        ...TEST_OPTIONS,
        region: { x0: 8, y0: 8, x1: 20, y1: 20 },
    });

    assert(result.points.length >= 2, `至少需要两个点，实际 ${result.points.length}`);
    assert(
        result.points.every(point => point.x >= 8 && point.x <= 20 && point.y >= 8 && point.y <= 20),
        '所有点都必须落在识别范围内',
    );
    assertEqual(result.uncoveredNegatives.length, 0, '范围内的点应覆盖所有负样本');

    const patchPoint = result.points.find(point =>
        point.x >= 10 && point.x < 14 && point.y >= 10 && point.y < 14
    );
    if (!patchPoint) throw new Error('应选中补丁内的点');
    assertEqual(patchPoint.color, 0xc82828, '补丁点颜色');

    const validation = validateSelection(result.points, positives, negatives, result.options);
    assertEqual(validation.falseNegativePositives.length, 0, '正样本不应漏识别');
    assertEqual(validation.falsePositiveNegatives.length, 0, '负样本不应误命中');
}

function testNarrowRegionMissesNegative(): void {
    const { positives, negatives } = makeSamples();
    const result = autoSelect(positives, negatives, {
        ...TEST_OPTIONS,
        regionPadding: 0,
        region: { x0: 10, y0: 10, x1: 13, y1: 13 },
    });

    assert(result.points.length > 0, '窄范围内仍应能选出补丁点');
    assert(
        result.points.every(point => point.x >= 10 && point.x <= 13 && point.y >= 10 && point.y <= 13),
        '点都应在窄范围内',
    );
    // N2 在补丁处也是红色，窄范围内没有可与 N2 区分的点
    assert(result.uncoveredNegatives.indexOf(1) !== -1, '应报告 N2 无法区分');
}

function testRegionWithoutPatch(): void {
    const { positives, negatives } = makeSamples();
    const result = autoSelect(positives, negatives, {
        ...TEST_OPTIONS,
        region: { x0: 30, y0: 5, x1: 38, y1: 12 },
    });

    assert(
        result.points.every(point => point.x >= 30 && point.x <= 38 && point.y >= 5 && point.y <= 12),
        '点都应落在指定范围',
    );
    // 该范围只有背景，N1 背景与正样本相同，无法区分
    assert(result.uncoveredNegatives.indexOf(0) !== -1, '应报告 N1 无法区分');
}

function testInvalidRegion(): void {
    const { positives, negatives } = makeSamples();
    const result = autoSelect(positives, negatives, {
        ...TEST_OPTIONS,
        region: { x0: 20, y0: 20, x1: 10, y1: 10 },
    });

    assertEqual(result.points.length, 0, '无效范围不应产出点');
    assert(
        result.warnings.some(warning => warning.indexOf('识别范围无效') !== -1),
        '应提示识别范围无效',
    );
}

function testRegionSmallerThanBorder(): void {
    const { positives, negatives } = makeSamples();
    const result = autoSelect(positives, negatives, {
        ...TEST_OPTIONS,
        border: 8,
        region: { x0: 0, y0: 0, x1: 5, y1: 5 },
    });

    assertEqual(result.points.length, 0, '范围被 border 裁掉后不应产出点');
    assert(
        result.warnings.some(warning => warning.indexOf('没有可扫描区域') !== -1),
        '应提示没有可扫描区域',
    );
}

function testMultiResolution(): void {
    const { positives, negatives } = makeSamples();
    const scaledPositives = positives.map(image => scaleImage(image, 2));
    const scaledNegatives = negatives.map(image => scaleImage(image, 2));

    const result = autoSelect(scaledPositives, scaledNegatives, {
        ...TEST_OPTIONS,
        region: { x0: 8, y0: 8, x1: 20, y1: 20 },
    });

    assertEqual(result.uncoveredNegatives.length, 0, '2x 图应覆盖所有负样本');
    const patchPoint = result.points.find(point =>
        point.x >= 10 && point.x < 14 && point.y >= 10 && point.y < 14
    );
    if (!patchPoint) throw new Error('2x 图应映射回开发坐标的补丁点');

    const validation = validateSelection(
        result.points,
        scaledPositives,
        scaledNegatives,
        result.options,
    );
    assertEqual(validation.falseNegativePositives.length, 0, '2x 正样本不应漏识别');
    assertEqual(validation.falsePositiveNegatives.length, 0, '2x 负样本不应误命中');
}

function testNoSamples(): void {
    const { positives, negatives } = makeSamples();
    const noNegatives = autoSelect(positives, [], TEST_OPTIONS);
    assertEqual(noNegatives.points.length, 0, '没有负样本不应产出点');
    assert(
        noNegatives.warnings.some(warning => warning.indexOf('负样本') !== -1),
        '应提示缺少负样本',
    );

    const noPositives = autoSelect([], negatives, TEST_OPTIONS);
    assertEqual(noPositives.points.length, 0, '没有正样本不应产出点');
    assert(
        noPositives.warnings.some(warning => warning.indexOf('正样本') !== -1),
        '应提示缺少正样本',
    );
}

function testIdenticalNegative(): void {
    const { positives, negatives } = makeSamples();
    const identical = autoSelect(positives, [positives[0]], {
        ...TEST_OPTIONS,
        region: { x0: 8, y0: 8, x1: 20, y1: 20 },
    });
    assertEqual(identical.points.length, 0, '完全相同的负样本无法区分');
    assert(identical.uncoveredNegatives.indexOf(0) !== -1, '应报告相同负样本未覆盖');

    const mixed = autoSelect(positives, [positives[0], negatives[0]], {
        ...TEST_OPTIONS,
        region: { x0: 8, y0: 8, x1: 20, y1: 20 },
    });
    assert(mixed.points.length > 0, '仍应覆盖可区分的负样本');
    assert(mixed.uncoveredNegatives.indexOf(0) !== -1, '相同负样本仍应未覆盖');
    assertEqual(mixed.uncoveredNegatives.indexOf(1), -1, '可区分负样本应被覆盖');
}

function testMappingAndRounding(): void {
    assertEqual(scriptLibRound(0.5), 0, '0.5 应四舍六入五成双到 0');
    assertEqual(scriptLibRound(1.5), 2, '1.5 应四舍六入五成双到 2');
    assertEqual(scriptLibRound(2.5), 2, '2.5 应四舍六入五成双到 2');
    assertEqual(scriptLibRound(0.51), 1, '0.51 应进位');
    assertEqual(scriptLibRound(0.49), 0, '0.49 应舍去');

    assertPoint(mapPoint(ANCHOR.LEFT, 0, 0, 1280, 720, 1280, 720), 0, 0, 'left 左上角');
    assertPoint(mapPoint(ANCHOR.LEFT, 640, 360, 1280, 720, 1920, 1080), 960, 540, 'left 1080p');
    assertPoint(mapPoint(ANCHOR.CENTER, 640, 360, 1280, 720, 1920, 1080), 960, 540, 'center 1080p');
    assertPoint(mapPoint(ANCHOR.RIGHT, 640, 360, 1280, 720, 1920, 1080), 960, 540, 'right 1080p');
    assertPoint(mapPoint(ANCHOR.TOP, 640, 360, 1280, 720, 1920, 1080), 960, 540, 'top 1080p');
    assertPoint(mapPoint(ANCHOR.MIDDLE, 640, 360, 1280, 720, 1920, 1080), 960, 540, 'middle 1080p');
    assertPoint(mapPoint(ANCHOR.BOTTOM, 640, 360, 1280, 720, 1920, 1080), 960, 540, 'bottom 1080p');
}

function testFormatting(): void {
    const result: AutoSelectResult = {
        points: [{
            anchor: ANCHOR.LEFT,
            x: 10,
            y: 10,
            color: 0xc82828,
            stability: 100,
            worstNegativeSimilarity: 50,
            flatness: 0,
            coveredMinDiff: 100,
            covered: [0],
            score: 1,
        }],
        positives: 1,
        negatives: 1,
        coveredNegatives: [0],
        uncoveredNegatives: [],
        warnings: [],
        options: DEFAULT_AUTO_SELECT_OPTIONS,
    };

    assertEqual(toHexColor(0xc82828), '0xc82828', '颜色格式');
    const desc = toDesc(result);
    assertEqual(desc.desc[0], 1280, 'desc 开发宽度');
    assertEqual(desc.desc[1], 720, 'desc 开发高度');
    assertEqual(desc.desc[2][0][0], 'left', 'desc 锚点名称');

    const formatted = formatDesc(result);
    assert(formatted.indexOf('[left, 10, 10, 0xc82828]') !== -1, '代码片段格式');
}

function main(): void {
    testRegionSelection();
    testNarrowRegionMissesNegative();
    testRegionWithoutPatch();
    testInvalidRegion();
    testRegionSmallerThanBorder();
    testMultiResolution();
    testNoSamples();
    testIdenticalNegative();
    testMappingAndRounding();
    testFormatting();
    console.log('autoSelect core tests passed');
}

main();
