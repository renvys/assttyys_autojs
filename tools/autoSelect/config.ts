import * as fs from 'fs';
import * as path from 'path';
import type { AutoSelectOptionsInput, AutoSelectWeights, Rect } from '../../src/common/autoSelect';

export type RegionTuple = [number, number, number, number];

export interface StateConfig {
    /** 状态名，用于输出文件名和日志 */
    name: string;
    /**
     * 识别范围（开发坐标，x0/y0/x1/y1 含边界）。
     * 不填则继承顶层 region；显式 null 表示全屏。
     */
    region?: RegionTuple | null;
    /** 正样本文件或目录（相对配置文件所在目录） */
    positives: string | string[];
    /** 负样本文件或目录（相对配置文件所在目录） */
    negatives: string | string[];
    /** 覆盖全局/顶层的选点参数 */
    options?: Omit<AutoSelectOptionsInput, 'region'>;
}

export interface AutoSelectConfigFile {
    /** 开发分辨率，默认 [1280, 720] */
    dev?: [number, number];
    /** 所有状态默认的识别范围 */
    region?: RegionTuple | null;
    similar?: number;
    gridStep?: number;
    border?: number;
    regionPadding?: number;
    maxPoints?: number;
    minDistance?: number;
    positiveTolerance?: number;
    flatTolerance?: number;
    negativeMargin?: number;
    /** 需要排除的子区域（开发坐标） */
    masks?: Rect[];
    weights?: Partial<AutoSelectWeights>;
    states: StateConfig[];
}

export interface LoadedConfig {
    file: string;
    baseDir: string;
    config: AutoSelectConfigFile;
}

export function loadConfig(file: string): LoadedConfig {
    const absolute = path.resolve(file);
    if (!fs.existsSync(absolute)) {
        throw new Error(`配置文件不存在：${absolute}`);
    }

    let parsed: AutoSelectConfigFile;
    try {
        parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch (error) {
        throw new Error(`配置文件不是合法 JSON：${absolute}\n${String(error)}`);
    }

    if (!parsed || !Array.isArray(parsed.states) || parsed.states.length === 0) {
        throw new Error('配置文件缺少 states 数组，或 states 为空');
    }

    const names = new Set<string>();
    parsed.states.forEach((state, index) => {
        if (!state || typeof state.name !== 'string' || state.name.trim() === '') {
            throw new Error(`states[${index}] 缺少 name`);
        }
        if (names.has(state.name)) {
            throw new Error(`states 中存在重复 name：${state.name}`);
        }
        names.add(state.name);
        if (!state.positives || (Array.isArray(state.positives) && state.positives.length === 0)) {
            throw new Error(`states[${index}] (${state.name}) 缺少 positives`);
        }
        if (!state.negatives || (Array.isArray(state.negatives) && state.negatives.length === 0)) {
            throw new Error(`states[${index}] (${state.name}) 缺少 negatives`);
        }
    });

    return {
        file: absolute,
        baseDir: path.dirname(absolute),
        config: parsed,
    };
}

export function resolveRegion(region?: RegionTuple | null): Rect | null {
    if (region === undefined || region === null) return null;
    if (!Array.isArray(region) || region.length !== 4) {
        throw new Error('region 必须是 [x0, y0, x1, y1]');
    }
    const [x0, y0, x1, y1] = region;
    [x0, y0, x1, y1].forEach(value => {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            throw new Error('region 的四个值都必须是数字');
        }
    });
    return { x0, y0, x1, y1 };
}

/** 去掉 undefined，避免覆盖默认值 */
export function compact<T extends object>(value: T): Partial<T> {
    const result: Partial<T> = {};
    (Object.keys(value) as (keyof T)[]).forEach(key => {
        if (value[key] !== undefined) {
            result[key] = value[key];
        }
    });
    return result;
}
