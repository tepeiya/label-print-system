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
          <el-statistic title="打印任务" :value="usage.printJobs?.used || 0">
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
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { apiSubscription, apiSubscriptionUsage } from '@/api';

const sub = ref<any>(null);
const plan = ref<any>(null);
const modules = ref<any[]>([]);
const usage = ref<any>(null);

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
    // 从 plan.modules 展开到详细信息（平台 modules 列表暂不缓存，这里先用 code 做占位）
    modules.value = (res.modules || []).map((code: string) => ({
      code, name: code, icon: '📦', description: '-', isCore: false,
    }));
  } catch { /* 拦截器已弹 */ }

  try {
    usage.value = await apiSubscriptionUsage();
  } catch { /* 忽略 */ }
}

onMounted(load);
</script>
