<template>
  <div class="page">
    <div class="page-head">
      <h2>打印机</h2>
      <div class="head-actions">
        <el-button v-if="agentRelease.available" type="success" @click="agentHelp = true">一键安装本地代理</el-button>
        <el-button v-else :loading="downloading" @click="downloadAgent">下载本地代理</el-button>
        <el-button type="primary" @click="openCreate">+ 添加打印机</el-button>
      </div>
    </div>

    <el-table :data="list" v-loading="loading" border stripe>
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column prop="type" label="通道" width="130">
        <template #default="{ row }">
          <el-tag :type="typeTag(row.type)">{{ typeLabel(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="规格" min-width="200">
        <template #default="{ row }">
          {{ row.dpi }}dpi · {{ row.labelWidthMm }}×{{ row.labelHeightMm }}mm
          <span v-if="row.type === 'raw_tcp'"> · {{ row.connection?.host }}:{{ row.connection?.port ?? 9100 }}</span>
          <span v-if="row.connection?.protocol"> · {{ row.connection.protocol.toUpperCase() }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="isDefault" label="默认" width="80" align="center">
        <template #default="{ row }">{{ row.isDefault ? '✓' : '' }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="320" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" @click="calibrate(row)">校准</el-button>
          <el-button size="small" @click="test(row)" :loading="row._testing">连通测试</el-button>
          <el-button size="small" type="primary" @click="testPrint(row)" :loading="row._testingPrint">测试打印</el-button>
          <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 编辑/新增 -->
    <el-dialog v-model="dialog" :title="editing ? '编辑打印机' : '添加打印机'" width="560px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：前台斑马 ZT230" />
        </el-form-item>
        <el-form-item label="打印通道">
          <el-select v-model="form.type" style="width: 100%">
            <el-option label="网络打印机 (raw_tcp, 9100 直连)" value="raw_tcp" />
            <el-option label="浏览器打印 (browser)" value="browser" />
            <el-option label="服务端出图 (image / PDF)" value="image" />
            <el-option label="本地代理 (windows_spooler)" value="windows_spooler" />
          </el-select>
        </el-form-item>

        <template v-if="form.type === 'raw_tcp' || form.type === 'windows_spooler'">
          <el-form-item label="主机/IP" v-if="form.type === 'raw_tcp'">
            <el-input v-model="form.host" placeholder="192.168.1.50" />
          </el-form-item>
          <el-form-item label="端口" v-if="form.type === 'raw_tcp'">
            <el-input-number v-model="form.port" :min="1" :max="65535" />
          </el-form-item>
          <el-form-item label="驱动名" v-if="form.type === 'windows_spooler'">
            <el-input v-model="form.driverName" placeholder="本地代理所用 Windows 驱动名" />
          </el-form-item>
          <el-form-item label="指令协议" v-if="form.type === 'raw_tcp'">
            <el-select v-model="form.protocol" style="width: 100%">
              <el-option label="ZPL (斑马)" value="zpl" />
              <el-option label="TSPL (台半等)" value="tspl" />
            </el-select>
          </el-form-item>
          <el-form-item label="标签间隙(mm)" v-if="form.type === 'raw_tcp'">
            <el-input-number v-model="form.gapMm" :min="0" :step="0.5" />
          </el-form-item>
        </template>

        <el-form-item label="分辨率 dpi">
          <el-input-number v-model="form.dpi" :min="72" :max="1200" />
        </el-form-item>
        <el-form-item label="标签宽(mm)">
          <el-input-number v-model="form.labelWidthMm" :min="5" :max="300" :step="1" />
        </el-form-item>
        <el-form-item label="标签高(mm)">
          <el-input-number v-model="form.labelHeightMm" :min="5" :max="300" :step="1" />
        </el-form-item>
        <el-form-item label="旋转">
          <el-select v-model="form.orientation" style="width: 100%">
            <el-option label="0°" :value="0" />
            <el-option label="90°" :value="90" />
            <el-option label="180°" :value="180" />
            <el-option label="270°" :value="270" />
          </el-select>
        </el-form-item>
        <el-form-item label="偏移 X(mm)">
          <el-input-number v-model="form.offsetXMm" :step="0.5" />
        </el-form-item>
        <el-form-item label="偏移 Y(mm)">
          <el-input-number v-model="form.offsetYMm" :step="0.5" />
        </el-form-item>
        <el-form-item label="浓度" v-if="form.type === 'raw_tcp'">
          <el-input-number v-model="form.density" :min="0" :max="15" />
        </el-form-item>
        <el-form-item label="速度" v-if="form.type === 'raw_tcp'">
          <el-input-number v-model="form.speed" :min="0" :max="15" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 校准 -->
    <el-dialog v-model="calibDialog" title="校准（偏移/浓度/速度）" width="460px">
      <el-form :model="calibForm" label-width="120px">
        <el-form-item label="偏移 X(mm)">
          <el-input-number v-model="calibForm.offsetXMm" :step="0.5" />
        </el-form-item>
        <el-form-item label="偏移 Y(mm)">
          <el-input-number v-model="calibForm.offsetYMm" :step="0.5" />
        </el-form-item>
        <el-form-item label="浓度" v-if="calibPrinter?.type === 'raw_tcp'">
          <el-input-number v-model="calibForm.density" :min="0" :max="15" />
        </el-form-item>
        <el-form-item label="速度" v-if="calibPrinter?.type === 'raw_tcp'">
          <el-input-number v-model="calibForm.speed" :min="0" :max="15" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="calibDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCalibrate">保存校准</el-button>
      </template>
    </el-dialog>

    <!-- 测试指令预览 -->
    <el-dialog v-model="cmdDialog" title="测试标签指令" width="680px">
      <pre class="cmd">{{ cmdText }}</pre>
    </el-dialog>

    <!-- 本地代理：一键安装 -->
    <el-dialog v-model="agentHelp" title="安装本地打印代理" width="660px">
      <p class="agent-lead">
        在<b>装打印机的那台 Windows</b> 上，用<b>管理员身份</b>打开 PowerShell，粘贴下面这一行、回车。
        剩下的它自己做完 —— 下载、装程序、建配置、存密码、开机自启。
      </p>
      <div class="agent-cmdbox">
        <pre class="cmd one-liner">{{ setupCommand }}</pre>
        <el-button type="primary" size="small" @click="copySetupCommand">复制命令</el-button>
      </div>
      <p class="agent-lead">跑起来后只需要回答三件事：</p>
      <ol class="agent-steps">
        <li>租户代码（不知道直接回车，默认 <code>default</code>）</li>
        <li>代理用的账号和密码（建议单开一个 operator 账号）</li>
        <li>把哪几台打印队列交给代理（回车=全部）</li>
      </ol>
      <p class="agent-lead">
        装完<b>不用再去建打印机</b> —— 代理注册时会把选中的队列自动变成这个列表里的「本地代理」打印机，
        驱动名、通道都已填好，直接在设计器里选它就能打。
      </p>
      <el-collapse class="agent-manual">
        <el-collapse-item title="想手动装？下载整包自己跑脚本（IT 统一分发时用）" name="manual">
          <p class="agent-lead">
            包里有 <code>LabelFlow.PrintAgent.exe</code> + <code>install\install-agent.ps1</code>，
            <code>--doctor</code> 可做体检，<code>--once --dry-run</code> 可演练。
          </p>
          <el-button :loading="downloading" @click="downloadAgent">
            下载安装包 {{ agentRelease.available ? `v${agentRelease.version}（${agentSizeText}）` : '' }}
          </el-button>
        </el-collapse-item>
      </el-collapse>
      <template #footer>
        <el-button @click="agentHelp = false">关闭</el-button>
        <el-button type="primary" @click="copySetupCommand">复制并关掉</el-button>
      </template>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  apiListPrinters, apiCreatePrinter, apiUpdatePrinter, apiDeletePrinter,
  apiCalibratePrinter, apiTestPrinter, apiTestPrintPrinter, apiTestCommandsPrinter,
  apiGetPrintAgentRelease, apiDownloadPrintAgent,
} from '@/api';

const list = ref<any[]>([]);
const loading = ref(false);

const dialog = ref(false);
const editing = ref<number | null>(null);
const saving = ref(false);
const form = reactive({
  name: '', type: 'raw_tcp', host: '', port: 9100, protocol: 'zpl', gapMm: 2,
  driverName: '', dpi: 203, labelWidthMm: 40, labelHeightMm: 30, orientation: 0,
  offsetXMm: 0, offsetYMm: 0, density: undefined as number | undefined, speed: undefined as number | undefined,
});

// ---- 本地打印代理下载 ----
const agentRelease = ref<any>({ available: false });
const downloading = ref(false);
const agentHelp = ref(false);
const agentSizeText = computed(() => {
  const b = Number(agentRelease.value?.sizeBytes || 0);
  if (!b) return '';
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(0)}MB` : `${(b / 1024).toFixed(0)}KB`;
});
// 安装脚本提示里用当前租户信息，减少租户自己算

// 一行命令：服务端按请求 Host 生成脚本，这里用同源地址（前后端分域名时租户改一下）
const setupCommand = computed(() => `irm ${location.origin}/api/v1/agent/setup.ps1 | iex`);

async function copySetupCommand() {
  const text = setupCommand.value;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('no clipboard');
    ElMessage.success('命令已复制，到客户机管理员 PowerShell 里粘贴执行');
  } catch {
    // 非 https / 无剪贴板权限时兜底：选中文本让用户自己 Ctrl+C
    ElMessageBox.alert(text, '请手动复制（Ctrl+C）', { confirmButtonText: '知道了' });
  }
}

async function loadRelease() {
  try { agentRelease.value = (await apiGetPrintAgentRelease()) || { available: false }; }
  catch { agentRelease.value = { available: false }; }
}

async function downloadAgent() {
  if (!agentRelease.value?.available) {
    ElMessage.warning(agentRelease.value?.reason || '发行包未就位，请联系管理员运行 scripts/print-agent-release.sh');
    return;
  }
  downloading.value = true;
  try {
    const blob: any = await apiDownloadPrintAgent();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = agentRelease.value.fileName || 'labelflow-print-agent.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    ElMessage.success('已开始下载');
  } finally { downloading.value = false; }
}

const calibDialog = ref(false);
const calibPrinter = ref<any>(null);
const calibForm = reactive({ offsetXMm: 0, offsetYMm: 0, density: undefined as number | undefined, speed: undefined as number | undefined });

const cmdDialog = ref(false);
const cmdText = ref('');

function typeLabel(t: string) {
  return { raw_tcp: '网络打印机', browser: '浏览器', image: '服务端出图', windows_spooler: '本地代理' }[t] || t;
}
function typeTag(t: string): any {
  return { raw_tcp: 'warning', browser: 'success', image: 'info', windows_spooler: 'primary' }[t] || 'info';
}
function buildConnection() {
  if (form.type === 'raw_tcp') {
    return { host: form.host, port: form.port, protocol: form.protocol, gapMm: form.gapMm };
  }
  if (form.type === 'windows_spooler') {
    return { driverName: form.driverName };
  }
  return {};
}

async function load() {
  loading.value = true;
  try { list.value = (await apiListPrinters()) || []; }
  finally { loading.value = false; }
}

function resetForm() {
  Object.assign(form, {
    name: '', type: 'raw_tcp', host: '', port: 9100, protocol: 'zpl', gapMm: 2,
    driverName: '', dpi: 203, labelWidthMm: 40, labelHeightMm: 30, orientation: 0,
    offsetXMm: 0, offsetYMm: 0, density: undefined, speed: undefined,
  });
}

function openCreate() { editing.value = null; resetForm(); dialog.value = true; }

function openEdit(row: any) {
  editing.value = row.id;
  Object.assign(form, {
    name: row.name, type: row.type, dpi: row.dpi, labelWidthMm: row.labelWidthMm,
    labelHeightMm: row.labelHeightMm, orientation: row.orientation ?? 0,
    offsetXMm: row.offsetXMm ?? 0, offsetYMm: row.offsetYMm ?? 0,
    density: row.density ?? undefined, speed: row.speed ?? undefined,
    host: row.connection?.host || '', port: row.connection?.port ?? 9100,
    protocol: row.connection?.protocol || 'zpl', gapMm: row.connection?.gapMm ?? 2,
    driverName: row.connection?.driverName || '',
  });
  dialog.value = true;
}

async function save() {
  if (!form.name) { ElMessage.warning('请填写名称'); return; }
  saving.value = true;
  const payload = {
    name: form.name, type: form.type, dpi: form.dpi, labelWidthMm: form.labelWidthMm,
    labelHeightMm: form.labelHeightMm, orientation: form.orientation,
    offsetXMm: form.offsetXMm, offsetYMm: form.offsetYMm,
    density: form.density, speed: form.speed, connection: buildConnection(),
  };
  try {
    if (editing.value) await apiUpdatePrinter(editing.value, payload);
    else await apiCreatePrinter(payload);
    ElMessage.success('已保存');
    dialog.value = false;
    load();
  } finally { saving.value = false; }
}

async function remove(row: any) {
  await ElMessageBox.confirm(`确认删除打印机「${row.name}」？`, '删除', { type: 'warning' });
  await apiDeletePrinter(row.id);
  ElMessage.success('已删除');
  load();
}

async function test(row: any) {
  row._testing = true;
  try {
    const r: any = await apiTestPrinter(row.id);
    if (r?.ok) ElMessage.success(`连通正常（${r.roundtripMs}ms）`);
    else ElMessage.error(`连通失败：${r?.error || '未知'}`);
  } finally { row._testing = false; }
}

async function testPrint(row: any) {
  if (row.type === 'browser' || row.type === 'windows_spooler') {
    ElMessage.info('该通道不支持服务端测试打印（由前端/本地代理完成）');
    return;
  }
  row._testingPrint = true;
  try {
    const r: any = await apiTestPrintPrinter(row.id);
    if (r?.ok) ElMessage.success('测试标签已下发');
    else ElMessage.error(`测试打印失败：${r?.error || '未知'}`);
  } finally { row._testingPrint = false; }
}

function calibrate(row: any) {
  calibPrinter.value = row;
  Object.assign(calibForm, {
    offsetXMm: row.offsetXMm ?? 0, offsetYMm: row.offsetYMm ?? 0,
    density: row.density ?? undefined, speed: row.speed ?? undefined,
  });
  calibDialog.value = true;
}

async function saveCalibrate() {
  if (!calibPrinter.value) return;
  saving.value = true;
  try {
    await apiCalibratePrinter(calibPrinter.value.id, { ...calibForm });
    ElMessage.success('校准已保存');
    calibDialog.value = false;
    load();
  } finally { saving.value = false; }
}

async function showCommands(row: any) {
  const r: any = await apiTestCommandsPrinter(row.id);
  cmdText.value = r?.text || '';
  cmdDialog.value = true;
}

onMounted(() => { load(); loadRelease(); });
// 暴露给模板（测试指令按钮可选）
defineExpose({ showCommands });
</script>

<style scoped>
.page { padding: 16px 20px; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.agent-steps { line-height: 1.9; padding-left: 18px; }
.agent-steps .cmd.small { margin: 6px 0 0; font-size: 12px; padding: 8px 10px; max-height: none; background: #f5f7fa; color: #303133; border: 1px solid #e4e7ed; }
.agent-tip { color: #909399; font-size: 12px; line-height: 1.8; margin-top: 8px; }
.agent-lead { line-height: 1.8; margin: 0 0 10px; }
.agent-cmdbox { display: flex; align-items: center; gap: 10px; margin: 10px 0 14px; }
.cmd.one-liner { flex: 1; margin: 0; padding: 10px 12px; max-height: none; background: #0d1117; color: #7ee787; white-space: pre-wrap; word-break: break-all; font-size: 13px; }
.agent-manual { margin-top: 14px; }
.cmd { background: #0d1117; color: #c9d1d9; padding: 12px; border-radius: 6px; max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
</style>
