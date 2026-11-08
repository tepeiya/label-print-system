<template>
  <div class="insp-inner">
    <!-- 未选中 -->
    <div v-if="!sel.length" class="insp-empty">
      <div class="ie-icon">⌖</div>
      <div class="ie-t">在画布上点选元素即可编辑属性</div>
      <div class="ie-sub">
        Shift + 点击 = 多选<br>
        拖动空白处 = 框选<br>
        双击文本 = 直接改写内容
      </div>
    </div>

    <!-- 多选：只做批量排版 -->
    <FGroup v-else-if="sel.length > 1" :title="`${sel.length} 个元素被选中`">
      <FRow>
        <FBtn @click="store.alignSelected('left')">左对齐</FBtn>
        <FBtn @click="store.alignSelected('hcenter')">水平居中</FBtn>
      </FRow>
      <FRow>
        <FBtn @click="store.alignSelected('top')">顶对齐</FBtn>
        <FBtn @click="store.alignSelected('vcenter')">垂直居中</FBtn>
      </FRow>
      <FRow>
        <FBtn @click="store.distributeSelected('h')">水平等距</FBtn>
        <FBtn @click="store.distributeSelected('v')">垂直等距</FBtn>
      </FRow>
      <FRow>
        <FBtn @click="store.matchSizeSelected('w')">同宽</FBtn>
        <FBtn @click="store.matchSizeSelected('h')">同高</FBtn>
      </FRow>
      <FRow>
        <FBtn @click="store.groupSelected()">组合 (Ctrl+G)</FBtn>
        <FBtn @click="store.ungroupSelected()">取消组合</FBtn>
      </FRow>
      <FRow>
        <FBtn @click="store.duplicateSelected()">复制</FBtn>
        <FBtn kind="danger" @click="store.removeElements()">删除</FBtn>
      </FRow>
    </FGroup>

    <!-- 单选 -->
    <template v-else>
      <div class="insp-head">
        <span class="type-badge">{{ TYPE_LABELS[el!.type] }}</span>
        <span class="insp-id">{{ el!.id.slice(-8) }}</span>
        <FBtn @click="store.duplicateSelected()">复制</FBtn>
        <FBtn kind="danger" @click="store.removeElements()">删除</FBtn>
      </div>

      <FGroup title="位置与尺寸">
        <FRow>
          <FField label="X (mm)"><FNum :model-value="r2v(el!.x)" :step="0.5" @update:model-value="set({ x: r2v($event) })" /></FField>
          <FField label="Y (mm)"><FNum :model-value="r2v(el!.y)" :step="0.5" @update:model-value="set({ y: r2v($event) })" /></FField>
        </FRow>
        <FRow>
          <FField label="宽 (mm)"><FNum :model-value="r2v(el!.w)" :step="0.5" :min="1" @update:model-value="set({ w: Math.max(1, r2v($event)) })" /></FField>
          <FField label="高 (mm)"><FNum :model-value="r2v(el!.h)" :step="0.5" :min="1" @update:model-value="set({ h: Math.max(1, r2v($event)) })" /></FField>
        </FRow>
        <FRow>
          <FLabel text="旋转" />
          <FSelect
            :model-value="el!.rotation ?? 0"
            :options="ROT_OPTIONS"
            @update:model-value="set({ rotation: Number($event) })"
          />
          <FLabel text="层级" />
          <FNum :model-value="el!.zIndex ?? 1" :step="1" @update:model-value="set({ zIndex: Math.round($event) })" />
        </FRow>
      </FGroup>

      <FGroup title="外观与输出">
        <FRow>
          <FLabel text="透明度" />
          <FSlider :model-value="el!.opacity ?? 1" @update:model-value="set({ opacity: $event })" />
          <span class="f-hint">{{ Math.round((el!.opacity ?? 1) * 100) }}%</span>
        </FRow>
        <FRow>
          <FCheck text="打印输出" :model-value="el!.visible !== false" @update:model-value="set({ visible: $event })" />
          <FCheck text="锁定位置（不可拖动）" :model-value="!!el!.locked" @update:model-value="set({ locked: $event })" />
        </FRow>
        <FField label="打印条件">
          <FText :model-value="el!.printIf ?? ''" placeholder="如: price > 10" @update:model-value="set({ printIf: $event })" />
        </FField>
      </FGroup>

      <!-- ------------------------------ 文本 ------------------------------ -->
      <template v-if="el!.type === 'text'">
        <FGroup title="文本内容">
          <FArea :model-value="el!.text ?? ''" :rows="3" placeholder="支持 {{变量}} 占位" @update:model-value="set({ text: $event })" />
          <FRow>
            <FCheck text="自动换行" :model-value="el!.font?.wrap !== false" @update:model-value="setFont({ wrap: $event })" />
          </FRow>
        </FGroup>
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ 矩形 ------------------------------ -->
      <template v-else-if="el!.type === 'rect'">
        <FGroup title="矩形样式">
          <FRow>
            <FLabel text="填充" />
            <FColor :model-value="el!.fill ?? '#ffffff'" @update:model-value="set({ fill: $event })" />
            <FLabel text="圆角 mm" />
            <FNum :model-value="el!.cornerRadius ?? 0" :step="0.25" :min="0" @update:model-value="set({ cornerRadius: r2v($event) })" />
          </FRow>
        </FGroup>
        <StrokeFields :el="el!" />
      </template>

      <!-- ------------------------------ 椭圆 ------------------------------ -->
      <template v-else-if="el!.type === 'ellipse'">
        <FGroup title="椭圆样式">
          <FRow>
            <FLabel text="填充" />
            <FColor :model-value="el!.fill ?? '#ffffff'" @update:model-value="set({ fill: $event })" />
          </FRow>
        </FGroup>
        <StrokeFields :el="el!" />
      </template>

      <!-- ------------------------------ 直线 ------------------------------ -->
      <template v-else-if="el!.type === 'line'">
        <FGroup title="直线端点">
          <FRow>
            <FField label="终点 X (mm)"><FNum :model-value="el!.x2 ?? el!.x" :step="0.5" @update:model-value="set({ x2: r2v($event) })" /></FField>
            <FField label="终点 Y (mm)"><FNum :model-value="el!.y2 ?? el!.y" :step="0.5" @update:model-value="set({ y2: r2v($event) })" /></FField>
          </FRow>
        </FGroup>
        <StrokeFields :el="el!" title="线条" />
      </template>

      <!-- ------------------------------ 表格 ------------------------------ -->
      <template v-else-if="el!.type === 'table'">
        <FGroup title="表格结构">
          <FRow>
            <FLabel text="行" />
            <FNum :model-value="el!.rows ?? 1" :step="1" :min="1" @update:model-value="set({ rows: Math.max(1, Math.round($event)) })" />
            <FLabel text="列" />
            <FNum :model-value="el!.cols ?? 1" :step="1" :min="1" @update:model-value="set({ cols: Math.max(1, Math.round($event)) })" />
          </FRow>
          <FRow>
            <FCheck text="表格线" :model-value="el!.showBorder !== false" @update:model-value="set({ showBorder: $event })" />
            <FCheck text="首行表头" :model-value="!!el!.headerRow" @update:model-value="set({ headerRow: $event })" />
          </FRow>
          <FRow>
            <FLabel text="线宽 mm" />
            <FNum :model-value="el!.borderWidth ?? 0.2" :step="0.05" :min="0" @update:model-value="set({ borderWidth: r2v($event) })" />
            <FLabel text="线色" />
            <FColor :model-value="el!.borderColor ?? '#333333'" @update:model-value="set({ borderColor: $event })" />
          </FRow>
          <FRow>
            <FLabel text="表头底色" />
            <FColor :model-value="el!.headerBg ?? '#f2f2f2'" @update:model-value="set({ headerBg: $event })" />
          </FRow>
        </FGroup>
        <FontFields :el="el!" :weight="false" />
        <CellsEditor :el="el!" />
      </template>

      <!-- ------------------------------ 图片 ------------------------------ -->
      <FGroup v-else-if="el!.type === 'image'" title="图片">
        <FArea :model-value="el!.src ?? ''" :rows="4" placeholder="data:image/png;base64,... 或 http 图片地址" @update:model-value="set({ src: $event })" />
        <FRow>
          <FBtn @click="pickImage">📁 选择本地图片</FBtn>
          <FBtn @click="set({ src: '' })">清空</FBtn>
        </FRow>
      </FGroup>

      <!-- ------------------------------ 一维码 ------------------------------ -->
      <FGroup v-else-if="el!.type === 'barcode'" title="一维码内容">
        <FRow>
          <FLabel text="码制" />
          <FSelect :model-value="bc!.sym ?? 'CODE128'" :options="bcSymOptions" @update:model-value="setBarcode({ sym: $event })" />
        </FRow>
        <!-- 码制能力受限（走位图 / 只能预览）：capNote 的小字说明，不弹窗、不拦截，口径见 barcode-caps.ts -->
        <span v-for="(line, i) in bcCapHint" :key="`cap${i}`" class="f-hint f-hint-warn">⚠ {{ line }}</span>
        <FField label="内容">
          <FText :model-value="bc!.content ?? ''" placeholder="支持 {{变量}}" @update:model-value="setBarcode({ content: $event })" />
        </FField>
        <span class="f-hint" :class="{ 'f-hint-bad': !bcCheck.ok }">
          {{ bcCheck.ok ? (bcCheck.note ? `✓ ${bcCheck.note}` : '') : `✗ ${bcCheck.error}` }}
        </span>
        <span v-if="bcWarn" class="f-hint f-hint-warn">⚠ {{ bcWarn }}</span>
        <FRow>
          <FLabel text="模块宽 mm" />
          <FNum :model-value="bc!.moduleWidthMm ?? 0.25" :step="0.01" :min="0.05" @update:model-value="setBarcode({ moduleWidthMm: r2v($event) })" />
          <FLabel text="宽窄比" />
          <FNum :model-value="bc!.wideRatio ?? 2.5" :step="0.1" :min="1.5" @update:model-value="setBarcode({ wideRatio: r2v($event) })" />
        </FRow>
        <FRow>
          <FLabel text="条码高 mm" />
          <FNum :model-value="bc!.heightMm ?? 9" :step="0.5" :min="2" @update:model-value="setBarcode({ heightMm: r2v($event) })" />
          <FLabel text="静区 mm" />
          <FNum :model-value="bc!.quietZoneMm ?? 2" :step="0.5" :min="0" @update:model-value="setBarcode({ quietZoneMm: r2v($event) })" />
        </FRow>
        <FRow>
          <FCheck text="显示明文" :model-value="!!bc!.showText" @update:model-value="setBarcode({ showText: $event })" />
          <FSelect
            :model-value="bc!.textPosition ?? 'bottom'"
            :options="[['bottom', '文在下'], ['top', '文在上']]"
            @update:model-value="setTextPos($event)"
          />
        </FRow>
        <FRow>
          <FLabel text="明文号 (mm)" />
          <FNum :model-value="bc!.textFont?.size ?? 2.4" :step="0.1" :min="1" @update:model-value="setBarcodeTextFont({ size: r2v($event) })" />
        </FRow>
        <FRow>
          <FCheck text="校验位（自动追加）" :model-value="bc!.checksum !== false" @update:model-value="setBarcode({ checksum: $event })" />
        </FRow>
      </FGroup>

      <!-- ------------------------------ 二维码 ------------------------------ -->
      <FGroup v-else-if="el!.type === 'qrcode'" title="二维码内容">
        <FRow>
          <FLabel text="码制" />
          <FSelect :model-value="qr!.sym ?? 'QRCODE'" :options="qrSymOptions" @update:model-value="setQr({ sym: $event })" />
        </FRow>
        <!-- 同「一维码」：受限码制给一行 capNote 小字，取值集合不变 -->
        <span v-for="(line, i) in qrCapHint" :key="`cap${i}`" class="f-hint f-hint-warn">⚠ {{ line }}</span>
        <FField label="内容">
          <FText :model-value="qr!.content ?? ''" placeholder="支持 {{变量}}" @update:model-value="setQr({ content: $event })" />
        </FField>
        <span class="f-hint" :class="{ 'f-hint-bad': !qrCheck.ok }">
          {{ qrCheck.ok ? (qrCheck.note ? `✓ ${qrCheck.note}` : '') : `✗ ${qrCheck.error}` }}
        </span>
        <FRow>
          <FLabel text="模块 mm" />
          <FNum :model-value="qr!.moduleSizeMm ?? 0.4" :step="0.02" :min="0.1" @update:model-value="setQr({ moduleSizeMm: r2v($event) })" />
          <FLabel text="静区 mm" />
          <FNum :model-value="qr!.quietZoneMm ?? 2" :step="0.5" :min="0" @update:model-value="setQr({ quietZoneMm: r2v($event) })" />
        </FRow>
        <FRow>
          <FLabel text="纠错" />
          <FSelect
            :model-value="qr!.ecc ?? 'M'"
            :options="[['L', 'L 低 7%'], ['M', 'M 中 15%'], ['Q', 'Q 较高 25%'], ['H', 'H 高 30%']]"
            @update:model-value="setQrEcc($event)"
          />
        </FRow>
      </FGroup>

      <!-- ------------------------------ 公式 ------------------------------ -->
      <template v-else-if="el!.type === 'formula'">
        <FGroup title="公式">
          <FArea
            :model-value="el!.formula?.expr ?? ''"
            :rows="3"
            placeholder="如: {{price}} * {{qty}}"
            @update:model-value="setFormula({ expr: $event })"
          />
          <span class="f-hint">支持 + - * / % 括号 比较 &amp;&amp; || 与函数 {{ FORMULA_FUNCTIONS.join(' ') }}</span>
          <span v-if="formulaError" class="f-hint f-hint-bad">✗ {{ formulaError }}</span>
        </FGroup>
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ 流水号 ------------------------------ -->
      <template v-else-if="el!.type === 'serial'">
        <FGroup title="流水号">
          <FField label="序列名">
            <FText :model-value="se!.sequenceRef ?? 'default'" @update:model-value="setSerial({ sequenceRef: $event })" />
          </FField>
          <FRow>
            <FLabel text="位数" />
            <FNum :model-value="se!.digits ?? 5" :step="1" :min="1" @update:model-value="setSerial({ digits: Math.max(1, Math.round($event)) })" />
            <FLabel text="起始" />
            <FNum :model-value="store.serialStart" :step="1" :min="1" @update:model-value="store.serialStart = Math.max(1, Math.round($event))" />
          </FRow>
          <FRow>
            <FLabel text="前缀" />
            <FText :model-value="se!.prefix ?? ''" placeholder="SN-" @update:model-value="setSerial({ prefix: $event })" />
          </FRow>
          <FRow>
            <FLabel text="后缀" />
            <FText :model-value="se!.suffix ?? ''" placeholder="A" @update:model-value="setSerial({ suffix: $event })" />
          </FRow>
        </FGroup>
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ 日期 ------------------------------ -->
      <template v-else-if="el!.type === 'datetime'">
        <FGroup title="日期时间">
          <FField label="格式串">
            <FText
              :model-value="dt!.pattern ?? ''"
              placeholder="YYYY-MM-DD HH:mm:ss"
              @update:model-value="setDatetime({ pattern: $event })"
            />
          </FField>
          <span class="f-hint">可用: YYYY 年 · MM 月 · DD 日 · HH 时 · mm 分 · ss 秒</span>
          <FRow>
            <FLabel text="取值" />
            <FSelect
              :model-value="dt!.source ?? 'print'"
              :options="[['print', '打印时刻'], ['now', '预览时刻']]"
              @update:model-value="setDatetime({ source: $event })"
            />
          </FRow>
        </FGroup>
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ 系统变量 ------------------------------ -->
      <template v-else-if="el!.type === 'sysvar'">
        <FGroup title="系统变量">
          <FField label="键名">
            <FSelect
              :model-value="sv!.key ?? 'printDate'"
              :options="SYSVAR_KEYS"
              @update:model-value="set({ sysvar: { key: $event } })"
            />
          </FField>
        </FGroup>
        <FontFields :el="el!" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// PropsPanel.vue —— 属性面板（inspector.js#propertiesView + specificView 的版式）
//   字段矩阵与原生版逐条对齐，缺一个字段同一份模板在两边就能编辑出不同结果。
//   写入一律走 store.updateElement（实时、不入历史），历史由 COMMIT_KEY 的
//   begin/end 在控件层收口，所以「拖一次滑块」= 一条 undo。
// =============================================================================
import { computed } from 'vue';
import { useDesignerStore } from '../store';
import { BARCODE_SYMS, QRCODE_SYMS, SYSVAR_KEYS, TYPE_LABELS } from '../model';
import { capHint, capOptions } from '../barcode-caps';
import type { PrintProtocol } from '../barcode-caps';
import {
  FORMULA_FUNCTIONS, buildContext, evalFormula, interpolate, sampleRowOf,
} from '../engine/context';

import { barcodeNaturalWidth, validateBarcodeText } from '../engine/barcode';
import { r2 } from '../engine/util';
import type { BarcodeSpec, ElementData, QrcodeSpec } from '../types';
import FArea from './fields/FArea.vue';
import FBtn from './fields/FBtn.vue';
import FCheck from './fields/FCheck.vue';
import FColor from './fields/FColor.vue';
import FField from './fields/FField.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FRow from './fields/FRow.vue';
import FSelect from './fields/FSelect.vue';
import FSlider from './fields/FSlider.vue';
import FText from './fields/FText.vue';
import FontFields from './FontFields.vue';
import StrokeFields from './StrokeFields.vue';
import CellsEditor from './CellsEditor.vue';

const store = useDesignerStore();

const ROT_OPTIONS: Array<[number, string]> = [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']];

const sel = computed(() => store.selectedElements);
const el = computed(() => (sel.value.length === 1 ? sel.value[0] : undefined));

const bc = computed<BarcodeSpec | undefined>(() => el.value?.barcode);
const qr = computed<QrcodeSpec | undefined>(() => el.value?.qrcode);
const se = computed(() => el.value?.serial);
const dt = computed(() => el.value?.datetime);
const sv = computed(() => el.value?.sysvar);

/** 原生版只截两位小数展示，输入时也按同一口径回写 */
const r2v = (v: number) => r2(v);

function set(patch: Partial<ElementData>) {
  if (el.value) store.updateElement(el.value.id, patch);
}

function setFont(patch: Record<string, unknown>) {
  set({ font: { ...(el.value?.font ?? {}), ...patch } } as Partial<ElementData>);
}

function setBarcode(patch: Partial<BarcodeSpec>) {
  set({ barcode: { ...(bc.value ?? {}), ...patch } });
}

function setBarcodeTextFont(patch: { size?: number; family?: string }) {
  setBarcode({ textFont: { ...(bc.value?.textFont ?? {}), ...patch } });
}

function setQr(patch: Partial<QrcodeSpec>) {
  set({ qrcode: { ...(qr.value ?? {}), ...patch } });
}

/** 下拉给回来的是字符串，这里收敛到 spec 的联合类型（取值集合与原生版一致） */
function setTextPos(v: string) {
  setBarcode({ textPosition: v === 'top' ? 'top' : 'bottom' });
}

function setQrEcc(v: string) {
  setQr({ ecc: v === 'L' || v === 'Q' || v === 'H' ? v : 'M' });
}

function setFormula(patch: Record<string, unknown>) {
  set({ formula: { ...(el.value?.formula ?? {}), ...patch } } as Partial<ElementData>);
}

function setSerial(patch: Record<string, unknown>) {
  set({ serial: { ...(se.value ?? {}), ...patch } } as Partial<ElementData>);
}

function setDatetime(patch: Record<string, unknown>) {
  set({ datetime: { ...(dt.value ?? {}), ...patch } } as Partial<ElementData>);
}

// --------------------------- 条码预检 ---------------------------
/** 预检用的数据上下文：和画布同一份示例行，所见即所检 */
const previewCtx = buildContext(store.template, sampleRowOf(store.template), { serialNo: store.serialStart });

const bcCheck = computed(() => validateBarcodeText(bc.value?.sym ?? 'CODE128', bc.value?.content ?? ''));
const qrCheck = computed(() => validateBarcodeText(qr.value?.sym ?? 'QRCODE', qr.value?.content ?? ''));

const bcWarn = computed(() => {
  if (!el.value || el.value.type !== 'barcode') return '';
  const nat = barcodeNaturalWidth(bc.value, interpolate(bc.value?.content ?? '', previewCtx));
  return nat != null && nat > (el.value.w ?? 0) + 0.01
    ? `条码自然宽度 ${nat.toFixed(1)}mm 大于元素宽度 ${el.value.w}mm，可能被压缩变形（建议加宽元素或减小模块宽）`
    : '';
});

const formulaError = computed(() => {
  if (!el.value || el.value.type !== 'formula') return '';
  const expr = el.value.formula?.expr ?? '';
  if (!expr.trim()) return '';
  return evalFormula(expr, previewCtx) == null
    ? '公式无法求值，画布上会显示默认值或 #公式错误'
    : '';
});

// --------------------------- 码制能力标记 ---------------------------
// 下拉后缀与小字说明都来自 barcode-caps.ts（与 backend/core/barcode-caps.ts 等价的副本）。
// designer store 里没有打印机/协议概念（协议只在导出指令时由调用方指定），
// 所以这里传 undefined，走「zpl/tspl 取最差情况」口径 —— 详见 barcode-caps.ts 文件头注释。
// 日后接入打印机选择器，只需把它的 protocol 传给 symProtocol，判定表不用动。
const symProtocol: PrintProtocol | undefined = undefined;

const bcSymOptions = computed(() => capOptions(BARCODE_SYMS, symProtocol));
const qrSymOptions = computed(() => capOptions(QRCODE_SYMS, symProtocol));
const bcCapHint = computed(() => capHint(bc.value?.sym ?? 'CODE128', symProtocol));
const qrCapHint = computed(() => capHint(qr.value?.sym ?? 'QRCODE', symProtocol));

// --------------------------- 本地图片 → data URL ---------------------------
function pickImage() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => set({ src: String(reader.result ?? '') });
    reader.readAsDataURL(f);
  };
  inp.click();
}
</script>
