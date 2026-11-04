import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';
import { registerPermissionDirectives } from './directives/permission';
import './styles/main.css';

const app = createApp(App);

// 注册所有 Element Plus 图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component as any);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus);
// v-permission / v-module 必须在 pinia 之后注册（指令内部用 useAuthStore）
registerPermissionDirectives(app);
app.mount('#app');
