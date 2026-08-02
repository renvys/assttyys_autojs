import { IFunc } from './IFunc';

export interface IScheme {
    /**
     * 方案的不可变标识。number 仅用于兼容升级前的存量数据，持久化时会迁移为 UUID。
     */
    id: string | number;
    schemeName: string;
    groupNames?: string[];
    inner?: boolean;
    star?: boolean;
    hidden?: boolean;

    /**
     * 功能id的清单
     */
    list: number[];
    config?: {
        [key: number]: {
            [key: string]: string | boolean | number | string[]
        }
    };
    commonConfig?: {
        [key: string]: string | boolean | number
    };
    funcList?: IFunc[];
}