import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import Login from '@/views/Login.vue';
import Home from '@/views/Home.vue';
import ReceiptList from '@/views/ReceiptList.vue';
import ReceiveScan from '@/views/ReceiveScan.vue';
import PutawayList from '@/views/PutawayList.vue';
import PutawayDetail from '@/views/PutawayDetail.vue';
import UdiVerify from '@/views/UdiVerify.vue';
import IssuingList from '@/views/IssuingList.vue';
import IssuingDetail from '@/views/IssuingDetail.vue';
import ShipmentList from '@/views/ShipmentList.vue';
import ShipmentPick from '@/views/ShipmentPick.vue';
import CartonPack from '@/views/CartonPack.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { public: true } },
    { path: '/', name: 'home', component: Home, meta: { title: '收货作业' } },
    { path: '/receipts', name: 'receipts', component: ReceiptList, meta: { title: '收货单' } },
    { path: '/receipts/:id/scan', name: 'receive-scan', component: ReceiveScan, meta: { title: '扫码收货' } },
    { path: '/putaway', name: 'putaway', component: PutawayList, meta: { title: '上架任务' } },
    { path: '/putaway/:id', name: 'putaway-detail', component: PutawayDetail, meta: { title: '上架确认' } },
    { path: '/issuing', name: 'issuing', component: IssuingList, meta: { title: '发料工单' } },
    { path: '/issuing/:id', name: 'issuing-detail', component: IssuingDetail, meta: { title: '发料作业' } },
    { path: '/shipments', name: 'shipments', component: ShipmentList, meta: { title: '成品发运' } },
    { path: '/shipments/:id', name: 'shipment-pick', component: ShipmentPick, meta: { title: '拣货出库' } },
    { path: '/carton/pack', name: 'carton-pack', component: CartonPack, meta: { title: '装箱出码' } },
    { path: '/udi/verify', name: 'udi-verify', component: UdiVerify, meta: { title: 'UDI 扫码复核' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.path === '/login' && auth.isLoggedIn) return { path: '/' };
  document.title = to.meta.title ? `${to.meta.title} · WMS` : 'WMS 收货作业';
  return true;
});

export default router;
