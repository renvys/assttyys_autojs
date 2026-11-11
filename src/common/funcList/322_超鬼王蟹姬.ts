import { IFuncOrigin, IFuncOperatorOrigin, IFuncOperator } from '@/interface/IFunc';
import { Script } from '@/system/script';

const left = 0;
const right = 2;

export class Func322 implements IFuncOrigin {
	id = 322;
	name = '超鬼王蟹姬';
	desc = '识别召唤蟹姬或挑战蟹姬后点击自定义坐标，召唤和挑战分别点击5次未开始时停止脚本';
	config = [{
		desc: '',
		config: [{
			name: 'xy',
			desc: '点击坐标范围，格式为：左上角x,左上角y,右下角x,右下角y，例：1134,590,1225,645',
			type: 'text',
			default: '1134,590,1225,645',
			value: null,
		}]
	}]
	operator: IFuncOperatorOrigin[] = [{ // 召唤蟹姬
		desc: [1280, 720,
			[
				[left, 177, 181, 0xcba9b2],
				[left, 177, 207, 0xcba9b2],
				[left, 200, 167, 0xcca8b2],
				[left, 156, 167, 0xcba9b2],
				[right, 1088, 517, 0xfff8e9],
				[right, 1071, 519, 0x9d2c2c],
				[right, 1074, 508, 0xf7e4c1],
				[right, 1180, 619, 0xe5dac4],
			]
		],
	}, { // 挑战蟹姬
		desc: [1280, 720,
			[
				[left, 91, 178, 0xfff8e9],
				[left, 51, 186, 0xa13133],
				[left, 125, 187, 0xb3302b],
				[right, 1181, 608, 0xe1d6bf],
				[right, 1192, 653, 0xe4d8c1],
			]
		],
	}];
	operatorFunc(thisScript: Script, thisOperator: IFuncOperator[]): boolean {
		const thisConf = thisScript.scheme.config['322'];
		const curCnt = { summon: 0, challenge: 0 };
		const maxCount = 5;
		for (;;) {
			let action: 'summon' | 'challenge';
			if (thisScript.oper({
				name: '召唤蟹姬',
				operator: [thisOperator[0]]
			})) {
				action = 'summon';
			} else if (thisScript.oper({
				name: '挑战蟹姬',
				operator: [thisOperator[1]]
			})) {
				action = 'challenge';
			} else {
				break;
			}
			if (curCnt[action] >= maxCount) {
				thisScript.myToast(`连续执行${maxCount}次${action === 'summon' ? '召唤' : '挑战'}后未开始，脚本自动停止`);
				thisScript.doPush(thisScript, { text: `[${thisScript.schemeHistory.map(item => item.schemeName).join('、')}]已停止，请查看。`, before() { thisScript.myToast('脚本即将停止，正在上传数据'); } });
				thisScript.stop();
				sleep(2000);
				return false;
			}
			const xy = String(thisConf.xy).split(',');
			if (xy.length !== 4) {
				thisScript.myToast('自定义坐标格式定义错误，请检查');
				return true;
			}
			const inX1 = parseInt(xy[0]);
			const inY1 = parseInt(xy[1]);
			const inX2 = parseInt(xy[2]);
			const inY2 = parseInt(xy[3]);
			if (Number.isNaN(inX1) || Number.isNaN(inY1) || Number.isNaN(inX2) || Number.isNaN(inY2)) {
				thisScript.myToast('自定义坐标格式定义错误，请检查');
				return true;
			}
			const oper = [
				[inX1, inY1, inX2, inY2, 1000]
			];
			thisScript.regionClick(oper);
			curCnt[action]++;
			thisScript.keepScreen();
		}
		return !!(curCnt.summon || curCnt.challenge);
	}
}
