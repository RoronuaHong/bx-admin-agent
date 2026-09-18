import { createRouter, createWebHistory } from "vue-router";
import ChatPage from "./pages/ChatPage.vue";
import MoviePage from "./pages/MoviePage.vue";

// 多 Agent 路由（领域适配指南 §8.2）：门户 `/` + 各 Agent 路由。
// 观影助手是面向消费者的独立形态（无侧栏 / 模型选择器 / 工具菜单），用独立的 MoviePage 承载干净 UI；
// 通用助手仍走 ChatPage（含侧栏与全部工具能力）。
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./pages/PortalPage.vue") },
    { path: "/chat", component: ChatPage },
    { path: "/movie", component: MoviePage },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
