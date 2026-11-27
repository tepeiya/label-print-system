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
        <FBtn @click="store.alignSelected('right')">右对齐</FBtn>
      </FRow>
      <FRow>
        <FBtn @click="store.alignSelected('top')">顶对齐</FBtn>
        <FBtn @click="store.alignSelected('vcenter')">垂直居中</FBtn>
        <FBtn @click="store.alignSelected('bottom')">底对齐</FBtn>
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

      <!-- 一键把当前内容变成变量占位，原内容存为示例值 -->
      <div class="insp-bind">
        <FBtn kind="primary" :disabled="!bindPlan?.ok" @click="makeVariable">一键设为变量</FBtn>
        <div class="bind-hint" :class="{ 'is-warn': bindPlan && !bindPlan.ok }">{{ bindHint }}</div>
      </div>

      <FGroup title="位置与尺寸" collapsible store-key="pos">
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

      <!-- 第二层：弧形排布（文本/一维码）—— SVG 导出走真曲线，指令通道退化为直线 -->
      <FGroup v-if="isCurvable" title="弧形排布" collapsible advanced store-key="curve" default-collapsed>
        <FRow>
          <FCheck
            text="沿弧线排布"
            :model-value="!!el!.curve?.enabled"
            @update:model-value="setCurve({ enabled: $event, radiusMm: el!.curve?.radiusMm ?? Math.max(el!.w, 20), sweepDeg: el!.curve?.sweepDeg ?? 60, direction: el!.curve?.direction ?? 'up' })"
          />
        </FRow>
        <template v-if="el!.curve?.enabled">
          <FRow>
            <FField label="半径 (mm)"><FNum :model-value="el!.curve?.radiusMm ?? 20" :step="1" :min="1" @update:model-value="setCurve({ radiusMm: Math.max(1, r2v($event)) })" /></FField>
            <FField label="弧度 (°)"><FNum :model-value="el!.curve?.sweepDeg ?? 60" :step="5" :min="10" :max="180" @update:model-value="setCurve({ sweepDeg: Math.max(10, Math.min(180, r2v($event))) })" /></FField>
          </FRow>
          <FRow>
            <FLabel text="拱向" />
            <FSelect
              :model-value="el!.curve?.direction ?? 'up'"
              :options="[['up', '向上拱'], ['down', '向下拱']]"
              @update:model-value="setCurve({ direction: $event as 'up' | 'down' })"
            />
          </FRow>
          <div class="f-hint">弧形为 SVG 矢量曲线；ZPL/TSPL/EPL 指令通道不支持，将退化为直线打印</div>
        </template>
      </FGroup>

      <FGroup title="外观与输出" collapsible advanced store-key="appearance" default-collapsed>
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
        <FGroup title="文本内容" collapsible store-key="content">
          <FRow>
            <FLabel text="内容来源" />
            <FSelect
              :model-value="el!.bindId ?? ''"
              :options="bindOptions"
              @update:model-value="set({ bindId: String($event ?? '') || undefined })"
            />
          </FRow>
          <span v-if="el!.bindId" class="f-hint">✓ 内容跟随绑定条码：改码即改字，不会出现「码对了字没改」</span>
          <span v-else class="f-hint">绑定条码 = 这段文字永远等于码里真正编进去的内容（GS1/UDI 的 HRI 明文）</span>
          <FArea
            :model-value="el!.text ?? ''"
            :rows="3"
            :placeholder="el!.bindId ? '已绑定条码，此处内容会被覆盖' : '支持 {{变量}} 占位'"
            @update:model-value="set({ text: $event })"
          />
          <FRow>
            <FCheck text="自动换行" :model-value="el!.font?.wrap !== false" @update:model-value="setFont({ wrap: $event })" />
          </FRow>
        </FGroup>
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ 富文本（第四层） ------------------------------ -->
      <template v-else-if="el!.type === 'richtext'">
        <RichTextEditor :el="el!" />
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ DB 字段（第四层） ------------------------------ -->
      <template v-else-if="el!.type === 'dbField'">
        <DbFieldEditor :el="el!" />
        <FontFields :el="el!" />
      </template>

      <!-- ------------------------------ 矩形 ------------------------------ -->
      <template v-else-if="el!.type === 'rect'">
        <FGroup title="矩形样式" collapsible store-key="rect">
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
        <FGroup title="椭圆样式" collapsible store-key="ellipse">
          <FRow>
            <FLabel text="填充" />
            <FColor :model-value="el!.fill ?? '#ffffff'" @update:model-value="set({ fill: $event })" />
          </FRow>
        </FGroup>
        <StrokeFields :el="el!" />
      </template>

      <!-- ------------------------------ 直线 ------------------------------ -->
      <template v-else-if="el!.type === 'line'">
        <FGroup title="直线端点" collapsible store-key="line">
          <FRow>
            <FField label="终点 X (mm)"><FNum :model-value="el!.x2 ?? el!.x" :step="0.5" @update:model-value="set({ x2: r2v($event) })" /></FField>
            <FField label="终点 Y (mm)"><FNum :model-value="el!.y2 ?? el!.y" :step="0.5" @update:model-value="set({ y2: r2v($event) })" /></FField>
          </FRow>
        </FGroup>
        <StrokeFields :el="el!" title="线条" />
      </template>

      <!-- ------------------------------ 表格 ------------------------------ -->
      <template v-else-if="el!.type === 'table'">
        <FGroup title="表格结构" collapsible store-key="table">
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
      <FGroup v-else-if="el!.type === 'image'" title="图片" collapsible store-key="image">
        <FArea :model-value="el!.src ?? ''" :rows="4" placeholder="data:image/png;base64,... 或 http 图片地址" @update:model-value="set({ src: $event })" />
        <FRow>
          <FBtn @click="pickImage">📁 选择本地图片</FBtn>
          <FBtn @click="set({ src: '' })">清空</FBtn>
        </FRow>
      </FGroup>

      <!-- ------------------------------ 一维码 ------------------------------ -->
      <FGroup v-else-if="el!.type === 'barcode'" title="一维码内容" collapsible store-key="barcode">
        <FRow>
          <FLabel text="码制" />
          <FSelect :model-value="bc!.sym ?? 'CODE128'" :options="BARCODE_SYM_OPTIONS" @update:model-value="setBarcode({ sym: $event })" />
        </FRow>
        <FField label="内容">
          <FText :model-value="bc!.content ?? ''" placeholder="支持 {{变量}}" @update:model-value="setBarcode({ content: $event })" />
        </FField>
        <span class="f-hint" :class="{ 'f-hint-bad': !bcCheck.ok }">
          {{ bcCheck.ok ? (bcCheck.note ? `✓ ${bcCheck.note}` : '') : `✗ ${bcCheck.error}` }}
        </span>
        <span v-if="bcSizeText" class="f-hint">{{ bcSizeText }}</span>
        <span v-if="bcWarn" class="f-hint f-hint-warn">⚠ {{ bcWarn }}</span>
        <FRow>
          <FLabel text="模块宽 mm" />
          <FNum :model-value="bc!.moduleWidthMm ?? 0.25" :step="0.01" :min="0.15" @update:model-value="setBarcode({ moduleWidthMm: r2v($event) })" />
          <FLabel text="宽窄比" />
          <FNum :model-value="bc!.wideRatio ?? 2.5" :step="0.1" :min="1.5" @update:model-value="setBarcode({ wideRatio: r2v($event) })" />
        </FRow>
        <FRow>
          <FLabel text="条码高 mm" />
          <FNum :model-value="bc!.heightMm ?? 9" :step="0.5" :min="6" @update:model-value="setBarcode({ heightMm: r2v($event) })" />
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
      <FGroup v-else-if="el!.type === 'qrcode'" title="二维码内容" collapsible store-key="qrcode">
        <FRow>
          <FLabel text="码制" />
          <FSelect :model-value="qr!.sym ?? 'QRCODE'" :options="QRCODE_SYM_OPTIONS" @update:model-value="setQr({ sym: $event })" />
        </FRow>
        <!-- 内容可能上千字符（URL / JSON / GS1 串），单行 input 看不见后半段，
             所以这里用可调高的多行框；但它仍是「一条数据」，noNewline 见 fields/FArea.vue -->
        <FField label="内容" class="f-field-top">
          <FArea
            :model-value="qr!.content ?? ''"
            :rows="6"
            no-newline
            placeholder="支持 {{变量}}；内容再长也不用回车分段"
            @update:model-value="setQr({ content: $event })"
            @normalize="onQrNormalize"
          />
        </FField>
        <span v-if="qrLen" class="f-hint">内容 {{ qrLen }} 字符（软换行只是显示，数据里不换行）</span>
        <span v-if="qrNotice" class="f-hint f-hint-warn">⚠ {{ qrNotice }}</span>
        <span v-if="qrSizeText" class="f-hint">{{ qrSizeText }}</span>
        <span v-if="qrWarn" class="f-hint f-hint-warn">⚠ {{ qrWarn }}</span>
        <span class="f-hint" :class="{ 'f-hint-bad': !qrCheck.ok }">
          {{ qrCheck.ok ? (qrCheck.note ? `✓ ${qrCheck.note}` : '') : `✗ ${qrCheck.error}` }}
        </span>
        <FRow v-if="isMatrixQr">
          <FLabel text="GS1" />
          <FCheck
            text="GS1 DataMatrix（UDI 必须开）"
            :model-value="!!qr!.gs1"
            @update:model-value="setQr({ gs1: $event })"
          />
        </FRow>
        <span v-if="qrGs1Hint" class="f-hint f-hint-warn">⚠ {{ qrGs1Hint }}</span>
        <span v-else-if="isMatrixQr && qr!.gs1" class="f-hint">✓ 按 GS1 规则编码：扫码枪解出带括号 AI，可入 UDI 台账</span>
        <FRow>
          <FLabel text="模块 mm" />
          <FNum :model-value="qr!.moduleSizeMm ?? 0.4" :step="0.02" :min="0.25" @update:model-value="setQr({ moduleSizeMm: r2v($event) })" />
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
        <FGroup title="公式" collapsible store-key="formula">
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
        <FGroup title="流水号" collapsible store-key="serial">
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
        <FGroup title="日期时间" collapsible store-key="datetime">
          <FField label="格式串">
            <FText
              :model-value="dt!.pattern ?? ''"
              placeholder="YYYY-MM-DD HH:mm:ss"
              @update:model-value="setDatetime({ pattern: $event })"
            />
          </FField>
          <span class="f-hint">可用: YYYY 年 · MM 月 · DD 日 · HH 时 · mm 分 · ss 秒</span>
          <FField label="日期偏移">
            <FText
              :model-value="dt!.offset ?? ''"
              placeholder="如 +3d / -1M / +1y / +1M15d"
              @update:model-value="setDatetime({ offset: $event })"
            />
          </FField>
          <span class="f-hint">相对当前取值偏移：y 年 · M 月 · w 周 · d 天 · h 时 · m 分，可叠加如 +1M15d</span>
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
        <FGroup title="系统变量" collapsible store-key="sysvar">
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
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useDesignerStore } from '../store';
import { BARCODE_SYM_OPTIONS, QRCODE_SYM_OPTIONS, SYSVAR_KEYS, TYPE_LABELS } from '../model';
import {
  FORMULA_FUNCTIONS, buildContext, evalFormula, interpolate, sampleRowOf,
} from '../engine/context';

import { barcodeNaturalWidth, makeQrSvg, validateBarcodeText } from '../engine/barcode';
import { planElementVariable } from '../engine/element-variable';
import { useElementVariable } from '../useElementVariable';
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
import RichTextEditor from './RichTextEditor.vue';
import DbFieldEditor from './DbFieldEditor.vue';

const store = useDesignerStore();

const ROT_OPTIONS: Array<[number, string]> = [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']];

const sel = computed(() => store.selectedElements);
const el = computed(() => (sel.value.length === 1 ? sel.value[0] : undefined));

// 一键设为变量：按钮提示直接预演结果（变量名 / 绑定位置 / 不能绑的原因）
const bindPlan = computed(() => (el.value ? planElementVariable(el.value, store.variables.map((v) => v.name)) : null));
const bindHint = computed(() => {
  const p = bindPlan.value;
  if (!p) return '';
  if (!p.ok) return p.reason;
  return `将生成 {{${p.name}}}${p.slot ? `（${p.slot}）` : ''}，示例值取当前内容`;
});
const { makeVariableFromElement } = useElementVariable();
function makeVariable() {
  if (el.value) makeVariableFromElement(el.value.id);
}

const bc = computed<BarcodeSpec | undefined>(() => el.value?.barcode);
const qr = computed<QrcodeSpec | undefined>(() => el.value?.qrcode);
/** GS1 开关只对 DataMatrix 有意义（QR/PDF417 没有 GS1 模式） */
const isMatrixQr = computed(() => {
  const sym = String(qr.value?.sym ?? '');
  return sym === 'DATAMATRIX' || sym === 'DATAMATRIX_RECT';
});
/** GS1 模式下内容必须是带括号 HRI，给一条即时提示 */
const qrGs1Hint = computed(() => {
  const c = String(qr.value?.content ?? '');
  if (!qr.value?.gs1) return '';
  const ok = /^\(0[1-9]|^\(1[0-9]|^\(2[0-9]|^\(3[0-9]/.test(c.trim());
  return ok ? '' : 'GS1 模式内容需以带括号 AI 开头，如 (01){{gtin}}(17){{expiry}}(10){{lot}}';
});
/** 第二层：弧形排布仅对文本类与一维码有意义 */
const isCurvable = computed(() => {
  const t = el.value?.type;
  return t === 'text' || t === 'barcode' || t === 'formula' || t === 'serial' || t === 'datetime' || t === 'sysvar';
});
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

/** 第二层：合并写入弧形排布配置（不覆盖未传入的字段） */
function setCurve(patch: Partial<NonNullable<ElementData['curve']>>) {
  set({ curve: { ...(el.value?.curve ?? {}), ...patch } } as Partial<ElementData>);
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

// HRI 绑定候选：本模板里的条码/二维码，选中后文本内容跟随该码
const bindOptions = computed<Array<[string, string]>>(() => {
  const els = (store.template?.elements ?? []) as any[];
  const opts: Array<[string, string]> = [['', '自己输入']];
  for (const e of els) {
    if (e.type !== 'barcode' && e.type !== 'qrcode') continue;
    if (!e.id || e.id === el.value?.id) continue;
    const raw = String((e.type === 'barcode' ? e.barcode?.content : e.qrcode?.content) ?? '');
    const kind = e.type === 'barcode' ? '1D' : '2D';
    const label = `${e.name || kind}：${raw.slice(0, 14)}${raw.length > 14 ? '…' : ''}`;
    opts.push([e.id, label]);
  }
  return opts;
});

const bcCheck = computed(() => validateBarcodeText(bc.value?.sym ?? 'CODE128', bc.value?.content ?? ''));
const qrCheck = computed(() => validateBarcodeText(qr.value?.sym ?? 'QRCODE', qr.value?.content ?? ''));

const qrLen = computed(() => (qr.value?.content ?? '').length);

/** 换行挡在输入侧，但挡了就要说：粘贴里有几个控制字符就报几个，不静默改用户的数据 */
const qrNotice = ref('');
let qrNoticeTimer: ReturnType<typeof setTimeout> | undefined;
function onQrNormalize(n: number) {
  clearTimeout(qrNoticeTimer);
  qrNotice.value = `内容有 ${n} 个换行/控制字符，已整理成单行（换行按空格接续）：ZPL/TSPL 指令按行切分，^FD…^FS 里带换行会让打印机把后半段当新指令读，只有位图通道能原样承载。`;
  qrNoticeTimer = setTimeout(() => { qrNotice.value = ''; }, 8000);
}
// 换元素时这条提示就与当前内容无关了，别挂在下一个二维码下面
watch(() => el.value?.id, () => { qrNotice.value = ''; });
onBeforeUnmount(() => clearTimeout(qrNoticeTimer));

/** 一维：编码后真实宽度（含静区）与元素框的对比 —— 内容变长会直接变宽，这才是溢出源头 */
const bcSizeText = computed(() => {
  if (!el.value || el.value.type !== 'barcode') return '';
  const content = interpolate(bc.value?.content ?? '', previewCtx);
  if (!content || /\{\{/.test(content)) return '';
  const nat = barcodeNaturalWidth(bc.value, content);
  if (nat == null) return '';
  const box = el.value.w ?? 0;
  const over = nat > box + 0.01 ? ` → 超出 ${(nat - box).toFixed(1)}mm` : '';
  return `编码后宽 ${nat.toFixed(1)}mm（含静区）· 元素框 ${box}mm${over}`;
});

const bcWarn = computed(() => {
  if (!el.value || el.value.type !== 'barcode') return '';
  const msgs: string[] = [];
  const xdim = bc.value?.moduleWidthMm ?? 0.25;
  // 与后端 barcode-guard 同一口径：<0.19mm 打印前自检会直接拦下
  if (xdim < 0.19) msgs.push(`模块宽 ${xdim}mm 低于可扫下限 0.19mm，打印前自检会拦截（发不出去）`);
  else if (xdim < 0.25) msgs.push(`模块宽 ${xdim}mm 偏小，GS1 建议 ≥0.25mm、医疗 UDI ≥0.495mm`);
  const h = bc.value?.heightMm ?? 9;
  if (h < 6) msgs.push(`条高 ${h}mm 低于 6mm，扫描枪容错窗口不足`);
  const nat = barcodeNaturalWidth(bc.value, interpolate(bc.value?.content ?? '', previewCtx));
  if (nat != null && nat > (el.value.w ?? 0) + 0.01) {
    const realX = xdim * ((el.value.w ?? 0) / nat);
    msgs.push(`自然宽 ${nat.toFixed(1)}mm 超出元素宽 ${el.value.w}mm，压扁后实际模块约 ${realX.toFixed(3)}mm（建议加宽元素或减小模块宽）`);
  }
  return msgs.join('；');
});

/** 二维：元素框小于自然尺寸时模块被等比缩小，实际密度可能跌出可扫范围 */
/** 二维：内容长度决定版本（模块数），框不变时模块会被压小 —— 提前把两个数摆出来 */
const qrSizeText = computed(() => {
  if (!el.value || el.value.type !== 'qrcode') return '';
  const content = interpolate(qr.value?.content ?? '', previewCtx);
  if (!content || /\{\{/.test(content)) return '';
  const nat = makeQrSvg(qr.value, content).naturalWmm;
  if (!nat) return '';
  const box = Math.min(el.value.w ?? 0, el.value.h ?? 0);
  if (!box) return `内容 ${content.length} 字符 · 自然尺寸 ${nat.toFixed(1)}mm（含静区）`;
  const ratio = box / nat;
  const real = (qr.value?.moduleSizeMm ?? 0.4) * Math.min(1, ratio);
  return `内容 ${content.length} 字符 · 编码后 ${nat.toFixed(1)}mm（含静区）· 元素框 ${box}mm`
    + (ratio < 0.999 ? ` → 实际模块 ${real.toFixed(3)}mm` : '');
});

const qrWarn = computed(() => {
  if (!el.value || el.value.type !== 'qrcode') return '';
  const size = qr.value?.moduleSizeMm ?? 0.4;
  const content = interpolate(qr.value?.content ?? '', previewCtx);
  if (!content || /\{\{/.test(content)) return '';
  const msgs: string[] = [];
  if (size < 0.3) msgs.push(`模块 ${size}mm 低于可扫下限 0.30mm，打印前自检会拦截（发不出去）`);
  else if (size < 0.495) msgs.push(`模块 ${size}mm 偏小，医疗 UDI 要求 ≥0.495mm`);
  const nat = makeQrSvg(qr.value, content).naturalWmm;
  const box = Math.min(el.value.w ?? 0, el.value.h ?? 0);
  if (nat > 0 && box > 0 && box + 0.01 < nat) {
    const realModule = size * (box / nat);
    msgs.push(`元素框 ${box}mm 小于自然尺寸 ${nat.toFixed(1)}mm，实际模块约 ${realModule.toFixed(3)}mm`);
  }
  return msgs.join('；');
});

const formulaError = computed(() => {
  if (!el.value || el.value.type !== 'formula') return '';
  const expr = el.value.formula?.expr ?? '';
  if (!expr.trim()) return '';
  return evalFormula(expr, previewCtx) == null
    ? '公式无法求值，画布上会显示默认值或 #公式错误'
    : '';
});

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
