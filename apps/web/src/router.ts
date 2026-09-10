import { createRouter, createWebHistory } from "vue-router";
import { fetchMe } from "./api";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./pages/AgentPortalPage.vue"), meta: { agent: "portal" } },
    { path: "/agents/admin/login", component: () => import("./pages/LoginPage.vue"), meta: { agent: "admin", guestRedirectAuth: "/agents/admin/chat" } },
    {
      path: "/trace/login",
      component: () => import("./pages/LoginPage.vue"),
      // Trace 观察者登录：复用运营账密 API，但入口/文案独立，不与后台工作台混用
      meta: { agent: "trace", purpose: "trace", guestRedirectAuth: "/trace" },
    },
    { path: "/agents/admin/chat", component: () => import("./pages/ChatPage.vue"), meta: { auth: true, loginPath: "/agents/admin/login", agent: "admin" } },
    { path: "/trace", component: () => import("./pages/TracePage.vue"), meta: { auth: true, loginPath: "/trace/login", agent: "portal", requiredPortalEntry: "trace" } },
    { path: "/agents/admin/trace", redirect: "/trace" },
    { path: "/agents/knowledge", component: () => import("./pages/KnowledgeAgentPage.vue"), meta: { agent: "knowledge" } },
    { path: "/agents/viewing", component: () => import("./pages/ViewingAgentPage.vue"), meta: { agent: "viewing" } },
    {
      path: "/analytics",
      component: () => import("./pages/AnalyticsAgentPage.vue"),
      // 问数可匿名使用；已登录时会话走 Mongo（与后台同 cookie），未登录仅本地缓存
      meta: { agent: "analytics" },
    },
    { path: "/agents/analytics", redirect: "/analytics" },
    { path: "/login", redirect: "/agents/admin/login" },
    { path: "/chat", redirect: "/agents/admin/chat" },
  ],
});

router.beforeEach(async (to) => {
  const needSession = Boolean(to.meta.auth || to.meta.guestRedirectAuth);
  if (!needSession) return true;
  const me = await fetchMe();
  if (to.meta.guestRedirectAuth && me) {
    const next = typeof to.query.next === "string" && to.query.next.startsWith("/") ? to.query.next : "";
    return { path: next || String(to.meta.guestRedirectAuth) };
  }
  if (!to.meta.auth) return true;
  if (!me) return { path: String(to.meta.loginPath || "/agents/admin/login"), query: { next: to.fullPath } };
  if (to.meta.requiredPortalEntry && !me.permissions.entries?.[to.meta.requiredPortalEntry]) {
    return {
      path: "/",
      query: {
        denied: String(to.meta.requiredPortalEntry === "trace" ? "canViewTrace" : to.meta.requiredPortalEntry),
        deniedSource: me.permissions.traceAccessSource,
        deniedFrom: to.path,
      },
    };
  }
  if (to.meta.requiredPermission && !me.permissions?.[to.meta.requiredPermission]) {
    return { path: "/" };
  }
  return true;
});
