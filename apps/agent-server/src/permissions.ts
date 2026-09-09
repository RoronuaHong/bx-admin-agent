import type { SessionUser } from "@bx/shared";
import type { Session } from "./session.js";
import { ownerKeyOf } from "./conversations.js";

export type TraceAccessSource =
  | "anonymous"
  | "default-login"
  | "owner-allowlist"
  | "country-allowlist"
  | "owner-denylist"
  | "country-denylist"
  | "denied-allowlist";

export interface PortalPermissions {
  canViewTrace: boolean;
  traceAccessSource: TraceAccessSource;
  entries: {
    admin: boolean;
    knowledge: boolean;
    viewing: boolean;
    analytics: boolean;
    trace: boolean;
  };
}

export interface TraceAccessPolicy {
  allowedOwners: string[];
  deniedOwners: string[];
  allowedCountries: string[];
}

type SessionLike = Pick<Session, "user" | "country"> | { user?: SessionUser; country?: { id?: string } } | null;

export function resolvePortalPermissions(
  session: SessionLike,
  policy: TraceAccessPolicy,
): PortalPermissions {
  if (!session) {
    return {
      canViewTrace: false,
      traceAccessSource: "anonymous",
      entries: { admin: false, knowledge: true, viewing: true, analytics: true, trace: false },
    };
  }

  const ownerKey = ownerKeyOf(session.user, session.country?.id || "");
  const countryId = String(session.country?.id || "");
  const ownerAllowed = Boolean(ownerKey && policy.allowedOwners.includes(ownerKey));
  const ownerDenied = Boolean(ownerKey && policy.deniedOwners.includes(ownerKey));
  const countryAllowed = Boolean(countryId && policy.allowedCountries.includes(countryId));
  const hasAllowScope = policy.allowedOwners.length > 0 || policy.allowedCountries.length > 0;

  if (ownerDenied) {
    return {
      canViewTrace: false,
      traceAccessSource: "owner-denylist",
      entries: { admin: true, knowledge: true, viewing: true, analytics: true, trace: false },
    };
  }
  if (ownerAllowed) {
    return {
      canViewTrace: true,
      traceAccessSource: "owner-allowlist",
      entries: { admin: true, knowledge: true, viewing: true, analytics: true, trace: true },
    };
  }
  if (countryAllowed) {
    return {
      canViewTrace: true,
      traceAccessSource: "country-allowlist",
      entries: { admin: true, knowledge: true, viewing: true, analytics: true, trace: true },
    };
  }
  if (hasAllowScope) {
    return {
      canViewTrace: false,
      traceAccessSource: policy.allowedOwners.length > 0 ? "denied-allowlist" : "country-denylist",
      entries: { admin: true, knowledge: true, viewing: true, analytics: true, trace: false },
    };
  }
  return {
    canViewTrace: true,
    traceAccessSource: "default-login",
    entries: { admin: true, knowledge: true, viewing: true, analytics: true, trace: true },
  };
}
