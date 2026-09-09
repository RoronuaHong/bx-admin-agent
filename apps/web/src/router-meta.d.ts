import "vue-router";
import type { PortalEntryKey } from "./portal-permissions";

declare module "vue-router" {
  interface RouteMeta {
    auth?: boolean;
    guestRedirectAuth?: string;
    loginPath?: string;
    agent?: "portal" | "admin" | "knowledge" | "viewing" | "analytics";
    requiredPermission?: "canViewTrace";
    requiredPortalEntry?: PortalEntryKey;
  }
}

export {};
