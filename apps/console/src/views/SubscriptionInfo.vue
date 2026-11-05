<template>
  <div>
    <div class="page-header">
      <h2>🎫 我的订阅</h2>
    </div>

    <el-row :gutter="16" style="margin-bottom: 16px;">
      <el-col :span="10">
        <el-card shadow="hover">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>当前套餐</span>
              <el-tag :type="planTagType" size="large">{{ plan?.code || '—' }}</el-tag>
            </div>
          </template>
          <div v-if="plan">
            <h3 style="margin: 0 0 8px; font-size: 20px;">{{ plan.name }}</h3>
            <p style="color: #666; margin: 0 0 16px;">{{ plan.description }}</p>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="状态">
                <el-tag :type="sub?.status === 'active' ? 'success' : 'warning'" size="small">
                  {{ sub?.status || '—' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="开始时间">
                {{ formatDate(sub?.startedAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="到期时间">
                {{ sub?.endsAt ? formatDate(sub.endsAt) : '长期有效' }}
              </el-descriptions-item>
              <el-descriptions-item label="试用到期" v-if="tenant?.trialEndsAt">
                {{ formatDate(tenant.trialEndsAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="席位上限" v-if="tenant?.seatLimit">
                {{ tenant.seatLimit }}
              </el-descriptions-item>
            </el-descriptions>
          </div>
          <el-empty v-else description="加载中..." />
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card shadow="hover">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>已开通模块 ({{ modules.length }})</span>
            </div>
          </template>
          <div v-if="modules.length">
            <el-table :data="modules" size="small" stripe>
              <el-table-column label="" width="60">
                <template #default="{ row }">
                  <span style="font-size: 20px;">{{ row.icon || '📦' }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="name" label="模块名" width="160" />
              <el-table-column prop="code" label="代码" width="140">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain">{{ row.code }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="description" label="说明" />
              <el-table-column label="类型" width="80">
                <template #default="{ row }">
                  <el-tag v-if="row.isCore" type="warning" size="small" effect="light">核心</el-tag>
                  <el-tag v-else type="info" size="small" effect="plain">附加</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-else description="暂无开通模块" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 用量 -->
    <el-card shadow="hover" v-if="usage">
      <template #header>用量概览</template>
      <el-row :gutter="16">
        <el-col :span="6">
          <!-- P3 起 printJobs.used 的口径是「张数」（usage_daily 的 print_labels 聚合），不再是任务数 -->
          <el-statistic title="本月打印（张）" :value="usage.printJobs?.used || 0">
            <template #suffix>
              <span style="font-size: 14px; color: #999;">
                / {{ usage.printJobs?.limit === -1 ? '∞' : usage.printJobs?.limit }}
              </span>
            </template>
          </el-statistic>
        </el-col>
        <el-col :span="6">
          <el-statistic title="AI 生成次数" :value="usage.aiGenerations?.used || 0">
            <template #suffix>
              <span style="font-size: 14px; color: #999;">
                / {{ usage.aiGenerations?.limit === -1 ? '∞' : usage.aiGenerations?.limit }} /月
              </span>
            </template>
          </el-statistic>
        </el-col>
      </el-row>
    </el-card>

    <!-- 升级引导（docs/11 §11.10「未订阅模块有升级引导」）：
         套餐目录是平台侧数据，租户端只有 /platform/plans 且要 admin，这里只给文字引导。 -->
    <el-alert type="info" :closable="false" style="margin-top: 16px;" v-if="notOpen.length">
      <template #title>
        想用的功能还没开通：{{ notOpen.join('、') }}。
        模块在接口层由订阅守卫拦截（后端返回 4031），前端点进去会看到「模块未订阅」页面。
      </template>
      <div style="margin-top: 6px;">
        开通方式：联系平台管理员为当前租户订阅对应模块，或升级套餐。
        <span v-if="!auth.isAdmin">当前角色只能看到自己已订阅的模块，需要联系管理员。</span>
      </div>
    </el-alert>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { apiSubscription, apiSubscriptionUsage } from '@/api';
import { useAuthStore } from '@/store/auth';
import { MODULE_LABELS, moduleName } from '@/constants/modules';

const auth = useAuthStore();
const sub = ref<any>(null);
const plan = ref<any>(null);
const modules = ref<any[]>([]);
const usage = ref<any>(null);

const tenant = computed(() => auth.tenant);

/** 目录里有、当前租户没订阅的模块 —— 只做文案提示，权限判定一律以后端为准 */
const notOpen = computed(() =>
  Object.keys(MODULE_LABELS).filter((c) => !auth.hasModule(c)).map(moduleName),
);

const planTagType = computed(() => {
  const code = plan.value?.code;
  if (code === 'ENTERPRISE') return 'danger';
  if (code === 'PRO') return 'warning';
  return 'info';
});

function formatDate(d?: string | Date | null) {
  if (!d) return '-';
  return new Date(d).toLocaleString('zh-CN');
}

async function load() {
  try {
    const res: any = await apiSubscription();
    sub.value = res.subscription;
    plan.value = res.plan;
    // P1：后端 /subscription 已带 moduleDetails（名称/图标/说明/是否核心）；
    // 拿不到时退回用 code 占位，保证老后端也不会白屏。
    modules.value = res.moduleDetails?.length
      ? res.moduleDetails
      : (res.modules || []).map((code: string) => ({
          code, name: code, icon: '📦', description: '-', isCore: false,
        }));
  } catch { /* 拦截器已弹 */ }

  try {
    usage.value = await apiSubscriptionUsage();
  } catch { /* 忽略 */ }
}

onMounted(load);
</script>
