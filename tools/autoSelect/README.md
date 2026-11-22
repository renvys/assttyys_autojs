# 自动选点辅助工具（autoSelect）

本项目内的锚点比色辅助工具：先由 AI 或人工确认一个**识别范围**，再在范围内根据正/负样本自动选点，并按线上 AND 语义验证。

- 核心逻辑：`src/common/autoSelect.ts`（纯 TS，无 DOM/Auto.js 依赖，可被本项目或其他工具复用）
- 离线 CLI：`tools/autoSelect/cli.ts`（读取 PNG、生成报告/desc/预览图）

## 工作流

1. **准备样本**
   - 同一状态的多张截图放 `positives` 目录（建议 3~5 张稳定帧）。
   - 其他易混状态的截图放 `negatives` 目录（至少 1 张，建议把相邻状态都放进来）。
   - 截图建议 1280×720 或 1920×1080 的 16:9；项目截图默认 1280×720。

2. **确认识别范围**
   - AI：把一张目标状态截图交给 AI，让它在 1280×720 坐标下返回区分度最高的 UI 元素矩形 `[x0, y0, x1, y1]`。
   - 人工：直接量取或根据 UI 布局填写同一个矩形。
   - 如果截图不是 1280×720（例如 1920×1080），`region` 仍按 1280×720 开发坐标填写：截图坐标 × (1280 / 截图宽)。
   - 范围只用于“找候选点”，不会写进最终 desc；最终 desc 仍然是全局锚点坐标。

3. **写配置**
   - 参考 `config.example.json`，把 `region`、`positives`、`negatives` 填好。
   - 样本路径相对配置文件所在目录。

4. **运行**
   ```bash
   npm run auto-select -- --config tools/autoSelect/config.json
   ```

5. **确认结果**
   - `out/<state>.preview.png`：绿色框是识别范围，橙色十字是自动选出的点。先看这张图确认范围和点是否落在预期 UI 上。
   - `out/<state>.report.json`：每个点的稳定度、最接近的负样本相似度、覆盖了哪些负样本，以及验证结果。
   - `out/<state>.desc.txt`：可直接粘贴到 `multiDetectColors.ts` 或 func 的 `operator.desc`。

6. **上机复核**
   - 把 desc 接入功能后，用 `drawFloaty` 看实际命中点；必要时微调 `region`/参数重跑。

## 运行时使用

核心逻辑在 `src/common/autoSelect.ts`，也可以被 Auto.js 运行时直接 import。位图转换用 `src/common/autoSelectBitmap.ts`：

```ts
import { autoSelect } from '@/common/autoSelect';
import { bitmapToImageData } from '@/common/autoSelectBitmap';

const positive = bitmapToImageData(script.helperBridge.helper.GetBitmap());
const result = autoSelect([positive], negatives, {
    region: { x0: 150, y0: 300, x1: 1130, y1: 650 },
});
```

离线 CLI 只是在这个核心外面加了 PNG 读取、配置、预览图和报告输出。

## 配置格式

```json
{
  "dev": [1280, 720],
  "region": [0, 0, 1279, 719],
  "similar": 93,
  "gridStep": 4,
  "border": 8,
  "regionPadding": 2,
  "maxPoints": 8,
  "minDistance": 80,
  "states": [
    {
      "name": "六道觉_选buff界面",
      "region": [150, 300, 1130, 650],
      "positives": "samples/323/buff/pos",
      "negatives": "samples/323/buff/neg",
      "options": {
        "maxPoints": 8
      }
    }
  ]
}
```

- `dev`：开发分辨率，默认 `[1280, 720]`。
- `region`：默认识别范围；state 里的 `region` 会覆盖它，显式 `null` 表示全屏。
- `regionPadding`：距离识别范围边缘的最小距离，默认 2。范围很小时可设为 0。
- `border`：距离屏幕边缘的最小距离，默认 8。
- `options`：可覆盖任意 `AutoSelectOptions` 字段（`similar`、`gridStep`、`maxPoints`、`minDistance`、`positiveTolerance`、`flatTolerance`、`negativeMargin`、`masks`、`anchorZones` 等）。

## CLI 选项

```text
--config <file>         配置文件
--state <name>          只处理某个状态
--region <x0,y0,x1,y1>  覆盖识别范围（开发坐标）
--full-screen           扫描全屏（不推荐）
--positive <path>       正样本目录/PNG，可重复
--negative <path>       负样本目录/PNG，可重复
--name <name>           无配置文件时的状态名
--similar <n>           相似度，默认 93
--max-points <n>        最多选几个点
--out <dir>             输出目录，默认 tools/autoSelect/out
--json                  输出 JSON 报告，便于 AI/脚本处理
--no-preview            不生成预览图
--help                  帮助
```

无配置文件时示例：

```bash
npm run auto-select -- \
  --positive samples/323/buff/pos \
  --negative samples/323/buff/neg \
  --region 150,300,1130,650 \
  --name 六道觉_选buff界面
```

## 选点与验证规则

- 候选点只在 `region` 内扫描，并避开 `border`/`regionPadding`/`masks`。
- 正样本各通道取中位数，要求所有正样本偏差 ≤ `positiveTolerance`（默认 8）。
- 3×3 邻域要求平坦 ≤ `flatTolerance`（默认 6），透明像素直接跳过。
- 负样本通道差 > `线上容差 + negativeMargin` 才算“该点拒绝了这个负样本”。`similar=93` 时线上容差是 18，默认余量 15，即差 > 33 才计入覆盖。
- 用贪心集合覆盖选点；每个点尽量稳定、平坦、分散，并覆盖不同的负样本。
- `validateSelection` 按线上 AND 语义复核：
  - 正样本：所有点都通过；
  - 负样本：至少一个点失败；
  - 负样本全部点都通过 = 误命中，退出码为 1。

## 注意事项

- 识别范围要覆盖**能区分状态**的 UI，而不是整块背景；范围太窄可能无法区分某个负样本。
- 正样本要干净；带弹窗、切页动画、伤害数字的帧会过滤掉大量候选点。
- 非 16:9 截图会 warning：ScriptLib 的 `left/center/right` x 使用高度比例，非 16:9 下锚点换算会偏。
- 完全相同的两个状态颜色上不可分，会出现在 `uncoveredNegatives`，需要 OCR、多点找色或合并逻辑。
- 自动选点结果是候选初稿，最终仍建议上机用 `drawFloaty` 复核。

## 测试

```bash
npm run test:auto-select
```

覆盖：范围内选点、窄范围漏负样本、无效范围、范围小于边框、2x 分辨率映射、缺少正/负样本、完全相同的负样本、坐标换算、desc 导出。
