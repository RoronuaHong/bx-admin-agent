import { createRouter, createWebHistory } from "vue-router";
import { fetchMe } from "./api";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./pages/AgentPortalPage.vue"), meta: { agent: "portal" } },
    { path: "/agents/admin/login", component: () => import("./pages/LoginPage.vue"), meta: { agent: "admin", guestRedirectAuth: "/agents/admin/chat" } },
    { path: "/agents/admin/chat", component: () => import("./pages/ChatPage.vue"), meta: { auth: true, loginPath: "/agents/admin/login", agent: "admin" } },
    { path: "/trace", component: () => import("./pages/TracePage.vue"), meta: { auth: true, loginPath: "/agents/admin/login", agent: "portal", requiredPortalEntry: "trace" } },
    { path: "/agents/admin/trace", redirect: "/trace" },
    { path: "/agents/knowledge", component: () => import("./pages/KnowledgeAgentPage.vue"), meta: { agent: "knowledge" } },
    { path: "/agents/viewing", component: () => import("./pages/ViewingAgentPage.vue"), meta: { agent: "viewing" } },
    { path: "/login", redirect: "/agents/admin/login" },
    { path: "/chat", redirect: "/agents/admin/chat" },
  ],
});

router.beforeEach(async (to) => {
  const needSession = Boolean(to.meta.auth || to.meta.guestRedirectAuth);
  if (!needSession) return true;
  const me = await fetchMe();
  if (to.meta.guestRedirectAuth && me) return { path: String(to.meta.guestRedirectAuth) };
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
