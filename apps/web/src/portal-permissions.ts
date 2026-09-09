export type PortalEntryKey = "admin" | "knowledge" | "viewing" | "analytics" | "trace";

export type TraceAccessSource =
  | "anonymous"
  | "default-login"
  | "owner-allowlist"
  | "country-allowlist"
  | "owner-denylist"
  | "country-denylist"
  | "denied-allowlist";

export type PortalEntries = Record<PortalEntryKey, boolean>;

export function hasPortalEntryAccess(
  entries: PortalEntries | null | undefined,
  entry: PortalEntryKey,
): boolean {
  return Boolean(entries?.[entry]);
}
