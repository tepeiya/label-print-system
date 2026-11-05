import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';
import { registerPermissionDirectives } from './directives/permission';
import { loadBranding } from './composables/branding';
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

// 白标（D6）：不 await —— 拉不到品牌就用出厂外观，不能让白标请求阻塞首屏。
// 命中域名时它只改 CSS 变量/标题/favicon，不改任何路由与权限判断。
void loadBranding();
