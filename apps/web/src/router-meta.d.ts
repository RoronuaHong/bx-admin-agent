import "vue-router";

declare module "vue-router" {
  interface RouteMeta {
    auth?: boolean;
    guestRedirectAuth?: string;
    loginPath?: string;
    agent?: "portal" | "admin" | "knowledge" | "viewing";
    requiredPermission?: "canViewTrace";
  }
}

export {};
