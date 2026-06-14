import { Script } from '@/system/script';
import { IFuncOrigin, IFuncOperatorOrigin, IFuncOperator } from '@/interface/IFunc';
// const normal = -1; //定义常量
const left = 0;
const center = 1;
const right = 2;

export class Func029 implements IFuncOrigin {
	id = 29;
	name = '庭院进入探索地图';
	desc = '请使用默认庭院皮肤，启用该功能后在庭院下会自动进入探索地图界面';
	operator: IFuncOperatorOrigin[] = [{
		// 庭院未打开菜单
		desc: '页面是否为庭院_菜单未展开_只支持默认庭院皮肤与默认装饰',
		oper: [
			[right, 1280, 720, 0, 0, 32, 63, 1200]
		]
	}, { // 庭院已打开菜单
		desc: '页面是否为庭院_菜单已展开_只支持默认庭院皮肤与默认装饰'
	}, {
		// 庭院已打开菜单，另外一种图标
		desc: '页面是否为庭院_菜单已展开_另一种图标_御祝图标_只支持默认庭院皮肤与默认装饰'
	}, {
		// 庭院已打开菜单，另另外一种图标
		desc: '庭院已打开菜单_另另外一种图标'
	}, { // 4 龙珏庭院_探索灯笼
		desc: [1280, 720,
			[
				[left, 0, 0, 0x9bc0ee], // 随便填的，为了不报错
			]
		],
		oper: [
			[center, 1280, 720, 550, 130, 600, 180, 1000], // ocr识别区域1
			[center, 1280, 720, 559, 142, 583, 175, 1000], // 龙珏庭院ocr识别后点击区域
			[center, 1280, 720, 592, 195, 621, 221, 1000], // 茨球庭院ocr识别后点击区域
		]
	}, { // 5突破界面，关闭突破界面
		desc: '突破界面',
		oper: [
			[center, 1280, 720, 1187, 112, 1228, 150, 1000],
		]
	}]
	operatorFunc(thisScript: Script, thisOperator: IFuncOperator[]): boolean {
		if (thisScript.oper({
			name: '庭院判断',
			operator: [{
				desc: thisOperator[0].desc
			}, {
				desc: thisOperator[1].desc
			}, {
				desc: thisOperator[2].desc
			}, {
				desc: thisOperator[3].desc
			}]
		})) {
			const point = thisScript.findMultiColor('庭院_探索灯笼');
			if (point) {
				const oper = [
					[point.x, point.y, point.x + thisOperator[0].oper[0][2], point.y + thisOperator[0].oper[0][3], thisOperator[0].oper[0][4]]
				];
				thisScript.regionClick(oper);
				return true;
			}
			// 龙珏庭院
			const temp = thisScript.findText('探', 0, thisOperator[4].oper[0], '包含');
			if (temp.length > 0) {
				thisScript.regionClick([thisOperator[4].oper[1]]);
				return true;
			}
			// 茨球庭院
			if (thisScript.oper({
				name: '茨球庭院识别',
				operator: [{ desc: '茨球庭院-町中定位' }]
			})) {
				thisScript.regionClick([thisOperator[4].oper[2]]);
				return true;
			}
			return false;
		}
		if (thisScript.oper({
			name: '突破界面',
			operator: [thisOperator[5]]
		})) {
			return true;
		}
		return false;
	}
}