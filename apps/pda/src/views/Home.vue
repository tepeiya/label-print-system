<template>
  <div>
    <div class="pda-header">
      <div class="lf-mark">LF</div>
      <div class="title">移动作业台</div>
      <div class="who">{{ auth.displayName || '作业员' }}</div>
      <button class="btn ghost" style="min-height:34px;padding:0 12px;font-size:13px" @click="onLogout">退出</button>
    </div>
    <div class="pda-body">
      <div class="card hero">
        <div class="card-t">租户 {{ auth.tenantCode || 'default' }} · 仓库现场</div>
        <div class="card-v">收货上架 · 发料发运 · UDI 复核</div>
        <div class="flow">
          <span class="step">扫码收货</span>
          <span class="arrow">›</span>
          <span class="step">上架确认</span>
          <span class="arrow">›</span>
          <span class="step">补打标签</span>
        </div>
      </div>

      <div class="section-title">作业入口</div>
      <div class="menu-grid">
        <button class="menu-tile" @click="router.push('/receipts')">
          <span class="ic">收</span>
          <span class="nm">收货单</span>
          <span class="ds">选单扫码收货、建单、过账</span>
        </button>
        <button class="menu-tile" @click="router.push('/putaway')">
          <span class="ic">架</span>
          <span class="nm">上架任务</span>
          <span class="ds">库位推荐确认、完成上架</span>
        </button>
        <button class="menu-tile" @click="router.push('/issuing')">
          <span class="ic">发</span>
          <span class="nm">发料作业</span>
          <span class="ds">工单齐套、扫码发料、退料冲销</span>
        </button>
        <button class="menu-tile" @click="router.push('/shipments')">
          <span class="ic">运</span>
          <span class="nm">成品发运</span>
          <span class="ds">发放货单拣货、扫码核对、出库过账、签收</span>
        </button>
        <button class="menu-tile" @click="router.push('/carton/pack')">
          <span class="ic">箱</span>
          <span class="nm">装箱出码</span>
          <span class="ds">按箱规装满箱 + 尾箱，一箱一码并打箱标</span>
        </button>
        <button class="menu-tile" @click="router.push('/udi/verify')">
          <span class="ic">DI</span>
          <span class="nm">UDI 复核</span>
          <span class="ds">扫 GS1 DataMatrix，比对 DI/PI 与批号序列号</span>
        </button>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-t">作业提示</div>
        <div class="muted" style="line-height:1.85">
          · 进入收货单后点「扫码收货」，对准条码自动识别<br />
          · 盲收可直接扫 SKU，按单收请选对应行号<br />
          · 同一批次重复扫码会累加数量，超收会标红提示<br />
          · 扫码成功有提示音与振动反馈<br />
          · 发料扫箱码时填「包数」，过账会按每箱件数折算扣减
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';

const router = useRouter();
const auth = useAuthStore();

function onLogout() {
  auth.logout();
  router.replace('/login');
}
</script>
