<template>
  <div class="page">
    <div class="page-head">
      <h2>UDI 批次赋码打印</h2>
      <div class="head-actions">
        <el-tag size="small" type="info">一箱 N 件：单件标 N 张 + 箱标 1 张</el-tag>
        <span class="hint">编号与装箱关系同一次写入台账</span>
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon class="tip">
      <template #title>
        每件一条 UDI（DI 相同、批号/有效期相同、序列号不同），箱一条 SSCC。
        点「试算」只生成号段与 SSCC、不写库不打印；点「生成并打印」会先写台账，再下发两个打印任务。
      </template>
    </el-alert>

    <el-form :model="form" label-width="110px" class="pack-form">
      <el-divider content-position="left">产品与批次</el-divider>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item label="DI（GTIN）">
            <el-input v-model="form.gtin" placeholder="14 位 GTIN，如 06901234567892" maxlength="14" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="批号">
            <el-input v-model="form.lot" placeholder="如 L2612A" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="有效期">
            <el-date-picker v-model="form.expiry" type="date" value-format="YYYY-MM-DD" placeholder="不填则码里不带 (17)" style="width: 100%" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item label="生产日期">
            <el-date-picker v-model="form.production" type="date" value-format="YYYY-MM-DD" placeholder="可选" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="件数">
            <el-input-number v-model="form.qty" :min="1" :max="meta?.maxUnitQty ?? 500" :disabled="form.serialMode === 'list'" />
            <span class="hint inline">上限 {{ meta?.maxUnitQty ?? 500 }}</span>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="工单号">
            <el-input v-model="form.workOrderNo" placeholder="可选，写进 UDI 事件" clearable />
          </el-form-item>
        </el-col>
      </el-row>

      <el-divider content-position="left">序列号</el-divider>
      <el-form-item label="编号方式">
        <el-radio-group v-model="form.serialMode">
          <el-radio-button value="auto">连续起号</el-radio-button>
          <el-radio-button value="list">逐件清单</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-row v-if="form.serialMode === 'auto'" :gutter="16">
        <el-col :span="8">
          <el-form-item label="起始序列号">
            <el-input v-model="form.serialFrom" placeholder="SN0001 或 0001" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="补零位数">
            <el-input-number v-model="form.padding" :min="0" :max="20" placeholder="按起始号位数" />
          </el-form-item>
        </el-col>
        <el-col :span="8" class="preview-col">
          <span class="hint">起号会按位数递增；溢出（9999 起 3 件）直接拒，不会静默进位</span>
        </el-col>
      </el-row>
      <el-form-item v-else label="序列号清单">
        <el-input v-model="form.serialList" type="textarea" :rows="4" placeholder="一行一个，顺序即件序，重复号会被拦住" />
      </el-form-item>

      <el-divider content-position="left">箱码与模板</el-divider>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item label="箱码 SSCC">
            <el-input v-model="form.sscc" :placeholder="`留空自动生成（前缀 ${meta?.prefix?.prefix ?? '—'}）`" maxlength="18" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="单件模板">
            <el-select v-model="form.unitTemplateCode" placeholder="选单件标签模板（不含箱标）" style="width: 100%" filterable>
              <el-option v-for="t in meta?.unitTemplates ?? []" :key="t.id" :value="t.code ?? `#${t.id}`"
                :label="`${t.name}${t.code ? ' · ' + t.code : '（无编码）'}`" />
            </el-select>
            <span v-if="meta && !meta.unitTemplates.length" class="hint inline error">没有单件模板，先去模板库导入 UDI 单件标签</span>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="箱标模板">
            <el-select v-model="form.cartonTemplateCode" placeholder="不选则只出单件标" style="width: 100%" filterable clearable>
              <el-option-group label="箱级模板">
                <el-option v-for="t in meta?.cartonTemplates ?? []" :key="t.id" :value="t.code ?? `#${t.id}`"
                  :label="`${t.name}${t.code ? ' · ' + t.code : ''}`" />
              </el-option-group>
              <el-option-group label="其他模板（变量可能对不上，慎用）">
                <el-option v-for="t in otherTemplates" :key="t.id" :value="t.code ?? `#${t.id}`"
                  :label="`${t.name}${t.code ? ' · ' + t.code : ''}`" />
              </el-option-group>
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item label="打印机">
            <el-select v-model="form.printerId" placeholder="正式打印必选" style="width: 100%" clearable>
              <el-option v-for="p in printers" :key="p.id" :value="p.id" :label="p.name" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="单件份数">
            <el-input-number v-model="form.copiesUnit" :min="1" :max="20" />
            <span class="hint inline">通常 1</span>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="箱标份数">
            <el-input-number v-model="form.copiesCarton" :min="1" :max="20" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-collapse v-model="advancedOpen">
        <el-collapse-item title="模板附加字段（模板里的 {{productName}} 等文本变量）" name="extra">
          <el-input v-model="form.extraText" type="textarea" :rows="4"
            placeholder="变量名=值，一行一个，例如：&#10;productName=一次性使用无菌注射器 带针&#10;spec=5mL 0.7×32TW.LB&#10;manufacturer=湖南某某医疗器械有限公司" />
          <span class="hint">这些值会附到每一行数据上；模板里引用但这里没给的变量会被后端点名（GS1 段为空会导致编码失败）</span>
        </el-collapse-item>
      </el-collapse>

      <div class="actions">
        <el-button :loading="trying" @click="run(true)">试算（不写库、不打印）</el-button>
        <el-button type="primary" :loading="running" @click="run(false)">生成并打印</el-button>
      </div>
    </el-form>

    <el-card v-if="result" class="result" shadow="never">
      <template #header>
        <span>执行结果{{ result.dryRun ? '（试算）' : '' }}</span>
      </template>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="DI">{{ result.gtin14 }}</el-descriptions-item>
        <el-descriptions-item label="批号">{{ result.lot }}</el-descriptions-item>
        <el-descriptions-item label="有效期（GS1）">{{ result.expiryGs1 || '—' }}<span v-if="result.expiryIso"> · {{ result.expiryIso }}</span></el-descriptions-item>
        <el-descriptions-item label="件数">{{ result.unitCount }}</el-descriptions-item>
        <el-descriptions-item label="箱码 SSCC">
          {{ result.sscc }} <el-tag size="small" :type="result.ssccAuto ? 'success' : 'info'">{{ result.ssccAuto ? '自动生成' : '手填' }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="号段">{{ result.serialRange }}</el-descriptions-item>
        <el-descriptions-item label="台账登记" :span="2">
          <template v-if="result.registered">
            新建 {{ result.registered.created }} 件 · 已存在 {{ result.registered.existed }} 件 · 失败 {{ result.registered.failed }} 件
          </template>
          <template v-else>未写库（试算）</template>
        </el-descriptions-item>
        <el-descriptions-item v-if="!result.dryRun" label="打印任务" :span="2">
          单件标：<b>{{ result.unitJobId ?? '—' }}</b>　箱标：<b>{{ result.cartonJobId ?? '—' }}</b>
          <el-button link type="primary" @click="$router.push('/print-jobs')">去打印任务</el-button>
        </el-descriptions-item>
      </el-descriptions>
      <el-alert v-if="result.warnings?.length" type="warning" :closable="false" class="warn">
        <div v-for="(w, i) in result.warnings" :key="i">⚠ {{ w }}</div>
      </el-alert>
      <div class="serials" v-if="result.unitSerials?.length">
        <span class="hint">本次号段（前 20）：</span>
        <el-tag v-for="s in result.unitSerials.slice(0, 20)" :key="s" size="small" class="sn">{{ s }}</el-tag>
        <span v-if="result.unitSerials.length > 20" class="hint">… 共 {{ result.unitSerials.length }} 件</span>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiListPrinters } from '@/api/index';
import { apiPackPrint, apiPackPrintMeta, type PackPrintBody, type PackPrintMeta, type PackPrintResult } from '@/api/udi-pack-print';

const meta = ref<PackPrintMeta | null>(null);
const printers = ref<any[]>([]);
const advancedOpen = ref<string[]>([]);
const trying = ref(false);
const running = ref(false);
const result = ref<PackPrintResult | null>(null);

const form = reactive({
  gtin: '',
  lot: '',
  expiry: '',
  production: '',
  qty: 10,
  workOrderNo: '',
  serialMode: 'auto' as 'auto' | 'list',
  serialFrom: 'SN0001',
  padding: undefined as number | undefined,
  serialList: '',
  sscc: '',
  unitTemplateCode: '' as string,
  cartonTemplateCode: '' as string,
  printerId: undefined as number | undefined,
  copiesUnit: 1,
  copiesCarton: 1,
  extraText: '',
});

// 除「箱级模板」以外、用户仍可能手工选的其余模板（例如把通用箱标签拿来用）
const otherTemplates = computed(() => {
  const cartonIds = new Set((meta.value?.cartonTemplates ?? []).map((t) => t.id));
  return (meta.value?.allTemplates ?? []).filter((t) => !cartonIds.has(t.id));
});

function parseExtra(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of form.extraText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function buildBody(dryRun: boolean): PackPrintBody {
  const serial: PackPrintBody['serial'] =
    form.serialMode === 'auto'
      ? { mode: 'auto', from: form.serialFrom.trim(), count: form.qty, ...(form.padding ? { padding: form.padding } : {}) }
      : { mode: 'list', list: form.serialList.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };

  const unitTpl = form.unitTemplateCode.startsWith('#')
    ? { unitTemplateId: Number(form.unitTemplateCode.slice(1)) }
    : { unitTemplateCode: form.unitTemplateCode || undefined };
  const cartonTpl = !form.cartonTemplateCode
    ? {}
    : form.cartonTemplateCode.startsWith('#')
      ? { cartonTemplateId: Number(form.cartonTemplateCode.slice(1)) }
      : { cartonTemplateCode: form.cartonTemplateCode };

  return {
    gtin: form.gtin.trim(),
    lot: form.lot.trim(),
    expiry: form.expiry || undefined,
    production: form.production || undefined,
    qty: form.serialMode === 'auto' ? form.qty : undefined,
    serial,
    sscc: form.sscc.trim() || undefined,
    workOrderNo: form.workOrderNo.trim() || undefined,
    printerId: dryRun ? undefined : form.printerId,
    copiesUnit: form.copiesUnit,
    copiesCarton: form.copiesCarton,
    dryRun,
    register: !dryRun,
    fieldMap: { extra: parseExtra() },
    ...unitTpl,
    ...cartonTpl,
  };
}

async function run(dryRun: boolean) {
  if (!form.gtin.trim()) return ElMessage.warning('先填 DI（GTIN）');
  if (!form.lot.trim()) return ElMessage.warning('批号不能为空');
  if (!dryRun && !form.printerId) return ElMessage.warning('正式打印必须选打印机');
  if (!form.unitTemplateCode) return ElMessage.warning('选一个单件标签模板');
  const flag = dryRun ? trying : running;
  flag.value = true;
  try {
    result.value = await apiPackPrint(buildBody(dryRun));
    ElMessage.success(dryRun ? '试算通过，看下方号段与 SSCC' : '已生成：台账 + 打印任务');
  } catch (e: any) {
    ElMessage.error(e?.message || '执行失败');
  } finally {
    flag.value = false;
  }
}

onMounted(async () => {
  try {
    meta.value = await apiPackPrintMeta();
    const first = meta.value.unitTemplates?.[0];
    if (first) form.unitTemplateCode = first.code ?? `#${first.id}`;
    const carton = meta.value.cartonTemplates?.[0];
    if (carton) form.cartonTemplateCode = carton.code ?? `#${carton.id}`;
  } catch (e: any) {
    ElMessage.warning('读取 UDI 模板清单失败：' + (e?.message || e));
  }
  try {
    const list: any = await apiListPrinters();
    printers.value = Array.isArray(list) ? list : list?.items ?? [];
  } catch { printers.value = []; }
});
</script>

<style scoped>
.page { padding: 16px 20px 40px; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 18px; }
.head-actions { display: flex; align-items: center; gap: 10px; }
.tip { margin-bottom: 14px; }
.pack-form { max-width: 1100px; }
.hint { color: #8a8f99; font-size: 12px; }
.hint.inline { margin-left: 8px; }
.hint.inline.error { color: #d9534f; }
.preview-col { display: flex; align-items: center; }
.actions { margin: 18px 0 8px; display: flex; gap: 10px; }
.result { max-width: 1100px; margin-top: 8px; }
.warn { margin-top: 12px; }
.serials { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sn { font-family: ui-monospace, Menlo, monospace; }
</style>
