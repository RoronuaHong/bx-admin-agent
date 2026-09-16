import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: () => import("./pages/ChatPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/chat" },
  ],
});
