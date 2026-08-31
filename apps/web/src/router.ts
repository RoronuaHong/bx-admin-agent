import { createRouter, createWebHistory } from "vue-router";
import LoginPage from "./pages/LoginPage.vue";
import ChatPage from "./pages/ChatPage.vue";
import { fetchMe } from "./api";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginPage },
    { path: "/chat", component: ChatPage, meta: { auth: true } },
    { path: "/", redirect: "/chat" },
  ],
});

router.beforeEach(async (to) => {
  if (!to.meta.auth) return true;
  const me = await fetchMe();
  if (!me) return { path: "/login" };
  return true;
});
