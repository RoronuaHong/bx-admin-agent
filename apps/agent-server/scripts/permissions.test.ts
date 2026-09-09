/**
 * 门户权限策略单元闸门（零外部依赖）。
 * 运行：tsx scripts/permissions.test.ts
 */
import { resolvePortalPermissions } from "../src/permissions.ts";

const results: Array<{ name: string; ok: boolean }> = [];

function assert(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} | [permissions] ${name}`);
}

const indiaAlice = {
  user: { loginName: "alice", name: "Alice" },
  country: { id: "india" },
};

const brazilBob = {
  user: { loginName: "bob", name: "Bob" },
  country: { id: "brazil" },
};

assert(
  "匿名默认拒绝",
  (() => {
    const r = resolvePortalPermissions(null, {
      allowedOwners: [],
      deniedOwners: [],
      allowedCountries: [],
    });
    return !r.canViewTrace && r.traceAccessSource === "anonymous";
  })(),
);

assert(
  "无策略时按登录态放行",
  (() => {
    const r = resolvePortalPermissions(indiaAlice, {
      allowedOwners: [],
      deniedOwners: [],
      allowedCountries: [],
    });
    return r.canViewTrace && r.entries.admin && r.entries.knowledge && r.entries.viewing && r.entries.analytics && r.entries.trace && r.traceAccessSource === "default-login";
  })(),
);

assert(
  "owner denylist 优先于其他规则",
  (() => {
    const r = resolvePortalPermissions(indiaAlice, {
      allowedOwners: ["india:alice"],
      deniedOwners: ["india:alice"],
      allowedCountries: ["india"],
    });
    return !r.canViewTrace && r.traceAccessSource === "owner-denylist";
  })(),
);

assert(
  "owner allowlist 命中放行",
  (() => {
    const r = resolvePortalPermissions(indiaAlice, {
      allowedOwners: ["india:alice"],
      deniedOwners: [],
      allowedCountries: [],
    });
    return r.canViewTrace && r.traceAccessSource === "owner-allowlist";
  })(),
);

assert(
  "owner allowlist 未命中拒绝",
  (() => {
    const r = resolvePortalPermissions(brazilBob, {
      allowedOwners: ["india:alice"],
      deniedOwners: [],
      allowedCountries: [],
    });
    return !r.canViewTrace && r.traceAccessSource === "denied-allowlist";
  })(),
);

assert(
  "国家线白名单命中放行",
  (() => {
    const r = resolvePortalPermissions(indiaAlice, {
      allowedOwners: [],
      deniedOwners: [],
      allowedCountries: ["india"],
    });
    return r.canViewTrace && r.traceAccessSource === "country-allowlist";
  })(),
);

assert(
  "国家线白名单未命中拒绝",
  (() => {
    const r = resolvePortalPermissions(brazilBob, {
      allowedOwners: [],
      deniedOwners: [],
      allowedCountries: ["india"],
    });
    return !r.canViewTrace && r.traceAccessSource === "country-denylist";
  })(),
);

assert(
  "owner 未命中但国家线命中时仍放行",
  (() => {
    const r = resolvePortalPermissions(indiaAlice, {
      allowedOwners: ["brazil:bob"],
      deniedOwners: [],
      allowedCountries: ["india"],
    });
    return r.canViewTrace && r.traceAccessSource === "country-allowlist";
  })(),
);

assert(
  "组合 allow 全未命中时拒绝",
  (() => {
    const r = resolvePortalPermissions(brazilBob, {
      allowedOwners: ["india:alice"],
      deniedOwners: [],
      allowedCountries: ["india"],
    });
    return !r.canViewTrace && r.traceAccessSource === "denied-allowlist";
  })(),
);

const failed = results.filter((r) => !r.ok);
console.log(`\npermissions: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
