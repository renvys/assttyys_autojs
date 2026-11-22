import * as fs from 'fs';
import * as path from 'path';
import {
    anchorName,
    autoSelect,
    toHexColor,
    formatDesc,
    validateSelection,
    type AutoSelectOptionsInput,
    type AutoSelectPoint,
    type AutoSelectResult,
    type Rect,
    type ValidationResult,
} from '../../src/common/autoSelect';
import {
    compact,
    loadConfig,
    resolveRegion,
    type AutoSelectConfigFile,
    type RegionTuple,
    type StateConfig,
} from './config';
import { loadImages, type LoadedImage } from './png';
import { writePreview } from './preview';

interface CliArgs {
    config?: string;
    state?: string;
    region?: string;
    positive: string[];
    negative: string[];
    out?: string;
    name?: string;
    similar?: number;
    maxPoints?: number;
    fullScreen: boolean;
    json: boolean;
    preview: boolean;
    help: boolean;
}

interface StateReport {
    state: string;
    passed: boolean;
    region: Rect | null;
    positives: number;
    negatives: number;
    points: (AutoSelectPoint & { anchorName: string })[];
    coveredNegatives: number[];
    uncoveredNegatives: number[];
    warnings: string[];
    validation: ValidationResult;
    outputs: {
        desc?: string;
        report: string;
        preview?: string;
    };
}

function parseNumber(value: string, name: string): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        throw new Error(`${name} 需要是数字，实际为 ${value}`);
    }
    return num;
}

function parseRegion(value: string): RegionTuple {
    const parts = value.split(',').map(item => Number(item.trim()));
    if (parts.length !== 4 || parts.some(item => !Number.isFinite(item))) {
        throw new Error('--region 格式应为 x0,y0,x1,y1，例如 100,200,500,400');
    }
    return [parts[0], parts[1], parts[2], parts[3]];
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        positive: [],
        negative: [],
        fullScreen: false,
        json: false,
        preview: true,
        help: false,
    };

    const needValue = (index: number, name: string): string => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`${name} 缺少参数值`);
        }
        return value;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--config':
                args.config = needValue(i, '--config');
                i++;
                break;
            case '--state':
                args.state = needValue(i, '--state');
                i++;
                break;
            case '--region':
                args.region = needValue(i, '--region');
                i++;
                break;
            case '--positive':
                args.positive.push(needValue(i, '--positive'));
                i++;
                break;
            case '--negative':
                args.negative.push(needValue(i, '--negative'));
                i++;
                break;
            case '--out':
                args.out = needValue(i, '--out');
                i++;
                break;
            case '--name':
                args.name = needValue(i, '--name');
                i++;
                break;
            case '--similar':
                args.similar = parseNumber(needValue(i, '--similar'), '--similar');
                i++;
                break;
            case '--max-points':
                args.maxPoints = parseNumber(needValue(i, '--max-points'), '--max-points');
                i++;
                break;
            case '--full-screen':
                args.fullScreen = true;
                break;
            case '--json':
                args.json = true;
                break;
            case '--no-preview':
                args.preview = false;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                throw new Error(`未知参数：${arg}`);
        }
    }

    if (args.region && args.fullScreen) {
        throw new Error('--region 和 --full-screen 不能同时使用');
    }
    return args;
}

function printHelp(): void {
    console.log(`自动选点工具

用法：
  npm run auto-select -- --config tools/autoSelect/config.json
  npm run auto-select -- --positive <目录/文件> --negative <目录/文件> [选项]

选项：
  --config <file>        配置文件；配置里的样本路径相对配置文件目录
  --state <name>         只处理配置中的某个状态
  --region <x0,y0,x1,y1> 识别范围（开发坐标）；强烈建议指定
  --full-screen          不限制范围，扫描全屏
  --positive <path>      正样本目录或 PNG（可重复）
  --negative <path>      负样本目录或 PNG（可重复）
  --name <name>          无配置文件时的状态名
  --similar <n>          多点比色相似度，默认 93
  --max-points <n>       最多选点数，默认 8
  --out <dir>            输出目录，默认 tools/autoSelect/out
  --json                 以 JSON 输出报告（便于 AI/脚本处理）
  --no-preview           不生成预览图
  --help                 显示帮助

示例：
  npm run auto-select -- --positive samples/323/buff --negative samples/323/other --region 150,300,1130,650 --name 六道觉_选buff
`);
}

function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'state';
}

function formatRegion(region: Rect | null): string {
    if (!region) return '全屏';
    return `[${region.x0}, ${region.y0}, ${region.x1}, ${region.y1}]`;
}

function buildOptions(
    baseOptions: AutoSelectOptionsInput,
    state: StateConfig,
    config: AutoSelectConfigFile | null,
    dev: [number, number],
    regionTuple: RegionTuple | null | undefined,
    args: CliArgs,
): AutoSelectOptionsInput {
    const stateOptions = compact(state.options || {});
    const options: AutoSelectOptionsInput = {
        ...baseOptions,
        ...stateOptions,
        devWidth: dev[0],
        devHeight: dev[1],
        region: resolveRegion(regionTuple),
    };

    if (config?.weights || state.options?.weights) {
        options.weights = {
            ...((config && config.weights) || {}),
            ...((state.options && state.options.weights) || {}),
        };
    }
    if (args.similar !== undefined) {
        options.similar = args.similar;
    }
    if (args.maxPoints !== undefined) {
        options.maxPoints = args.maxPoints;
    }
    return options;
}

function formatPoint(point: AutoSelectPoint, negativeCount: number): string {
    return `[${anchorName(point.anchor)}, ${point.x}, ${point.y}, ${toHexColor(point.color)}]` +
        ` 稳定度=${point.stability} 最接近负样本=${point.worstNegativeSimilarity}` +
        ` 覆盖=${point.covered.length}/${negativeCount}`;
}

function processState(
    state: StateConfig,
    config: AutoSelectConfigFile | null,
    baseDir: string,
    dev: [number, number],
    baseOptions: AutoSelectOptionsInput,
    args: CliArgs,
    outDir: string,
    cliWarnings: string[],
): StateReport {
    let regionTuple: RegionTuple | null | undefined;
    if (args.region) {
        regionTuple = parseRegion(args.region);
    } else if (args.fullScreen) {
        regionTuple = null;
    } else if (state.region !== undefined) {
        regionTuple = state.region;
    } else if (config?.region !== undefined) {
        regionTuple = config.region;
    } else {
        regionTuple = null;
        cliWarnings.push('未指定识别范围，将扫描全屏；建议先用 AI/人工确认 region。');
    }

    const positivesInput = args.positive.length > 0 ? args.positive : state.positives;
    const negativesInput = args.negative.length > 0 ? args.negative : state.negatives;

    const positives: LoadedImage[] = loadImages(positivesInput, baseDir);
    const negatives: LoadedImage[] = loadImages(negativesInput, baseDir);
    if (positives.length === 0) throw new Error('没有正样本');
    if (negatives.length === 0) throw new Error('没有负样本');

    const negativePaths = new Set(negatives.map(image => image.path));
    const overlap = positives
        .map(image => image.path)
        .filter(imagePath => negativePaths.has(imagePath));
    if (overlap.length > 0) {
        cliWarnings.push(`正负样本有重复文件，可能导致无法区分：${overlap.slice(0, 5).join(', ')}`);
    }

    const options = buildOptions(baseOptions, state, config, dev, regionTuple, args);
    const result: AutoSelectResult = autoSelect(positives, negatives, options);
    const validation = validateSelection(result.points, positives, negatives, result.options);

    const passed = result.points.length > 0
        && result.uncoveredNegatives.length === 0
        && validation.falsePositiveNegatives.length === 0
        && validation.falseNegativePositives.length === 0;

    const safeName = safeFileName(state.name);
    const reportPath = path.join(outDir, `${safeName}.report.json`);
    const descPath = path.join(outDir, `${safeName}.desc.txt`);
    const previewPath = path.join(outDir, `${safeName}.preview.png`);

    const header = [
        `// state: ${state.name}`,
        `// region: ${formatRegion(result.options.region)}`,
        `// positives: ${positives.length}, negatives: ${negatives.length}`,
        `// points: ${result.points.length}, uncovered negatives: ${result.uncoveredNegatives.length}`,
        `// validation: positives ${validation.falseNegativePositives.length === 0 ? 'pass' : 'fail'}, ` +
        `negatives ${validation.falsePositiveNegatives.length === 0 ? 'pass' : 'fail'}`,
        `// passed: ${passed}`,
    ].join('\n');
    fs.writeFileSync(descPath, `${header}\n${formatDesc(result)}\n`, 'utf8');

    const report = {
        state: state.name,
        passed,
        region: result.options.region,
        positives: positives.map(image => image.path),
        negatives: negatives.map(image => image.path),
        options: result.options,
        points: result.points.map(point => ({
            ...point,
            anchorName: anchorName(point.anchor),
        })),
        coveredNegatives: result.coveredNegatives,
        uncoveredNegatives: result.uncoveredNegatives,
        warnings: [...cliWarnings, ...result.warnings],
        validation,
        outputs: {
            desc: descPath,
            report: reportPath,
            preview: args.preview ? previewPath : undefined,
        },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    if (args.preview) {
        writePreview(
            positives[0],
            result.options.region,
            result.points,
            result.options.devWidth,
            result.options.devHeight,
            previewPath,
        );
    }

    return {
        state: state.name,
        passed,
        region: result.options.region,
        positives: positives.length,
        negatives: negatives.length,
        points: result.points.map(point => ({
            ...point,
            anchorName: anchorName(point.anchor),
        })),
        coveredNegatives: result.coveredNegatives,
        uncoveredNegatives: result.uncoveredNegatives,
        warnings: [...cliWarnings, ...result.warnings],
        validation,
        outputs: report.outputs,
    };
}

function main(): void {
    let args: CliArgs;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`[错误] ${(error as Error).message}`);
        printHelp();
        process.exitCode = 2;
        return;
    }

    if (args.help) {
        printHelp();
        return;
    }

    let loaded;
    try {
        if (args.config) {
            loaded = loadConfig(args.config);
        }
    } catch (error) {
        console.error(`[错误] ${(error as Error).message}`);
        process.exitCode = 2;
        return;
    }

    const config = loaded ? loaded.config : null;
    const baseDir = loaded ? loaded.baseDir : process.cwd();
    const dev: [number, number] = config?.dev || [1280, 720];
    if (
        !Array.isArray(dev) || dev.length !== 2
        || !Number.isFinite(dev[0]) || !Number.isFinite(dev[1])
    ) {
        console.error('[错误] dev 必须是 [width, height]');
        process.exitCode = 2;
        return;
    }

    let states: StateConfig[];
    if (config) {
        states = config.states;
        if (args.state) {
            states = states.filter(state => state.name === args.state);
            if (states.length === 0) {
                console.error(`[错误] 配置中没有状态：${args.state}`);
                console.error('可用状态：' + config.states.map(state => state.name).join('、'));
                process.exitCode = 2;
                return;
            }
        }
    } else {
        if (args.positive.length === 0 || args.negative.length === 0) {
            console.error('[错误] 无配置文件时必须提供 --positive 和 --negative');
            printHelp();
            process.exitCode = 2;
            return;
        }
        states = [{
            name: args.name || 'state',
            positives: args.positive,
            negatives: args.negative,
        }];
    }

    const baseOptions: AutoSelectOptionsInput = compact({
        devWidth: dev[0],
        devHeight: dev[1],
        similar: config?.similar,
        gridStep: config?.gridStep,
        border: config?.border,
        regionPadding: config?.regionPadding,
        maxPoints: config?.maxPoints,
        minDistance: config?.minDistance,
        positiveTolerance: config?.positiveTolerance,
        flatTolerance: config?.flatTolerance,
        negativeMargin: config?.negativeMargin,
        masks: config?.masks,
    });
    if (config?.weights) {
        baseOptions.weights = config.weights;
    }

    const outDir = path.resolve(process.cwd(), args.out || 'tools/autoSelect/out');
    fs.mkdirSync(outDir, { recursive: true });

    const reports: StateReport[] = [];
    let hasFailure = false;

    for (const state of states) {
        const cliWarnings: string[] = [];
        try {
            const report = processState(
                state,
                config,
                baseDir,
                dev,
                baseOptions,
                args,
                outDir,
                cliWarnings,
            );
            reports.push(report);
            if (!report.passed) hasFailure = true;

            if (!args.json) {
                console.log(`\n=== ${report.state} ===`);
                console.log(
                    `正样本 ${report.positives}, 负样本 ${report.negatives}, ` +
                    `识别范围 ${formatRegion(report.region)}`,
                );
                if (report.points.length === 0) {
                    console.log('未选出任何点');
                } else {
                    console.log(`选中 ${report.points.length} 个点:`);
                    report.points.forEach((point, index) => {
                        console.log(`  ${index + 1}. ${formatPoint(point, report.negatives)}`);
                    });
                }
                console.log(
                    `验证: 正样本 ` +
                    `${report.positives - report.validation.falseNegativePositives.length}/${report.positives} 通过, ` +
                    `负样本 ` +
                    `${report.negatives - report.validation.falsePositiveNegatives.length}/${report.negatives} 拒绝, ` +
                    `未覆盖 ${report.uncoveredNegatives.length}`,
                );
                if (report.validation.falsePositiveNegatives.length > 0) {
                    console.log(`  误命中负样本下标: ${report.validation.falsePositiveNegatives.join(', ')}`);
                }
                if (report.validation.falseNegativePositives.length > 0) {
                    console.log(`  漏识别正样本下标: ${report.validation.falseNegativePositives.join(', ')}`);
                }
                report.warnings.forEach(warning => console.log(`  [警告] ${warning}`));
                console.log(`输出: ${report.outputs.desc}`);
                console.log(`报告: ${report.outputs.report}`);
                if (report.outputs.preview) {
                    console.log(`预览: ${report.outputs.preview}`);
                }
            }
        } catch (error) {
            hasFailure = true;
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[失败] ${state.name}: ${message}`);
        }
    }

    if (args.json) {
        console.log(JSON.stringify(reports, null, 2));
    } else {
        console.log(`\n共处理 ${reports.length} 个状态，${hasFailure ? '存在失败' : '全部通过'}。`);
    }

    if (hasFailure) {
        process.exitCode = 1;
    }
}

main();
