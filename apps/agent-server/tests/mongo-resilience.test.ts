// Mongo 存储层韧性回归（2026-11-05 事故的固化用例）。
//
// 那天 Mongo 侧出问题（MONGO_URI 少了凭据），现象是：接口一律 500 INTERNAL_ERROR，
// 根因被淹没；恢复靠重启进程。本文件把「当时缺的那几道防线」逐条钉死：
//  ① 单例并发：并发首次调用只建一个 client（不重复握手、不重复建连接池）。
//  ② 连接失败进冷却：30s 内不重连（别把 Mongo 打挂），且冷却期内快速失败（不拖慢接口）。
//  ③ 连上 ≠ 能用：ping 自检失败（凭据不对）也算不可用，且错误直接点名凭据/authSource。
//  ④ 死连接不复用：client 报 close 后单例被丢弃，下次调用重建连接（Mongo 恢复后能自愈）。
//  ⑤ 凭据明确错误 fail-fast：不再每 30s 空转重试（重试对配置错误无意义）。
//  ⑥ 故障语义分层：冷启动连不上才允许降级内存；运行期掉线/认证错必须显式报错
//     （静默降级会让用户以为会话丢了——数据其实还在库里）。
//  ⑦ 错误分类不误伤：只有 Mongo 不可用类错误才被上层收敛成 503，其余错误照旧 500。
//  ⑧ 连接串脱敏：日志/错误里不能出现密码（连接串曾被原样打进日志）。
import { test, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeState {
  instances: FakeMongoClient[];
  pings: Array<{ db: string; cmd: Record<string, unknown> }>;
  connectImpl?: () => Promise<unknown>;
  pingImpl?: () => Promise<unknown>;
}

/** 假 MongoClient：只实现 db.ts 用到的那几个动作（connect / db().command / on / close）。 */
class FakeMongoClient {
  listeners = new Map<string, Array<(err?: unknown) => void>>();
  closed = false;
  constructor(
    public uri: string,
    public options: unknown,
  ) {
    state.instances.push(this);
  }
  on(event: string, fn: (err?: unknown) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
    return this;
  }
  emit(event: string, err?: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(err);
  }
  async connect() {
    if (state.connectImpl) return state.connectImpl();
    return this;
  }
  db(name: string) {
    return {
      command: async (cmd: Record<string, unknown>) => {
        state.pings.push({ db: name, cmd });
        if (state.pingImpl) return state.pingImpl();
        return { ok: 1 };
      },
    };
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}

let state: FakeState = { instances: [], pings: [] };

/** 每个用例都拿到全新的 db.ts 模块状态（模块级单例状态必须隔离）。 */
async function loadDb() {
  vi.resetModules();
  state = { instances: [], pings: [] };
  vi.doMock("mongodb", () => ({ MongoClient: FakeMongoClient }));
  const db = await import("../src/db.js");
  return { db, state };
}

beforeEach(() => {
  // 静音 db.ts 的连接日志（避免测试输出被刷屏），不影响断言。
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("mongodb");
});

test("[A] 并发首次调用只建一个 client：复用同一个连接，不重复握手", async () => {
  const { db, state: s } = await loadDb();
  const [a, b] = await Promise.all([db.getMongoClient(), db.getMongoClient()]);
  expect(s.instances).toHaveLength(1);
  expect(a).toBe(b);
  // 建连后必须做可用性自检（ping），否则「连上但没认证」要到业务查询才暴露。
  expect(s.pings).toHaveLength(1);
  expect(s.pings[0].cmd).toEqual({ ping: 1 });
});

test("[B] 连接失败进冷却：30s 内不重连，且冷却期内快速失败", async () => {
  const { db, state: s } = await loadDb();
  s.connectImpl = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:27017"), { name: "MongoNetworkError" });
  };
  await expect(db.getMongoClient()).rejects.toThrow(/连接失败/);
  expect(s.instances).toHaveLength(1);

  const t0 = Date.now();
  await expect(db.getMongoClient()).rejects.toThrow(/冷却中/);
  // 冷却期内既不新建 client，也不等选服超时（否则每个请求都白等 3s）。
  expect(s.instances).toHaveLength(1);
  expect(Date.now() - t0).toBeLessThan(50);
});

test("[C] 连上≠能用：ping 自检失败（凭据不对）视为不可用，并点名配置", async () => {
  const { db, state: s } = await loadDb();
  s.pingImpl = async () => {
    throw Object.assign(new Error("Command ping requires authentication"), { code: 13 });
  };
  await expect(db.getMongoClient()).rejects.toThrow(/认证失败/);
  await expect(db.getMongoClient()).rejects.toThrow(/认证失败/);
  // 错误信息要能直接指向配置：凭据 / authSource。
  await expect(db.getMongoClient()).rejects.toThrow(/authSource/);
  expect(s.pings).toHaveLength(1);
});

test("[D] 死连接不复用：client 关闭后单例被丢弃，下次调用重建连接（能自愈）", async () => {
  const { db, state: s } = await loadDb();
  const first = await db.getMongoClient();
  s.instances[0].emit("close");
  const second = await db.getMongoClient();
  expect(s.instances).toHaveLength(2);
  expect(second).not.toBe(first);
});

test("[E] 凭据明确错误（Authentication failed）→ fail-fast：不再每 30s 空转重试", async () => {
  const { db, state: s } = await loadDb();
  s.pingImpl = async () => {
    throw Object.assign(new Error("Authentication failed."), { code: 18 });
  };
  await expect(db.getMongoClient()).rejects.toThrow(/认证失败/);
  await expect(db.getMongoClient()).rejects.toThrow(/认证失败/);
  // 没有再新建 client：凭据错重试无意义（要改 MONGO_URI 并重启进程）。
  expect(s.instances).toHaveLength(1);
});

test("[F] reportMongoFailure：运行期掉线后单例作废，下次调用重建连接", async () => {
  const { db, state: s } = await loadDb();
  await db.getMongoClient();
  db.reportMongoFailure(Object.assign(new Error("server selection timed out"), { name: "MongoServerSelectionError" }));
  await db.getMongoClient();
  expect(s.instances).toHaveLength(2);
});

test("[G] 故障语义分层：冷启动连不上可降级；认证错不可降级", async () => {
  const { db, state: s } = await loadDb();
  s.connectImpl = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { name: "MongoNetworkError" });
  };
  // 冷启动：从未连上过 → 允许调用方降级到内存（既有契约：Mongo 没起来时仍可用）。
  await expect(db.getMongoClient()).rejects.toMatchObject({ degradable: true });

  const { db: db2, state: s2 } = await loadDb();
  s2.pingImpl = async () => {
    throw Object.assign(new Error("Command ping requires authentication"), { code: 13 });
  };
  // 认证错：不可降级——降级等于「假装没数据」，用户会以为会话丢了。
  await expect(db2.getMongoClient()).rejects.toMatchObject({ degradable: false });
});

test("[H] 错误分类不误伤：只有 Mongo 不可用类错误才被识别", async () => {
  const { db } = await loadDb();
  expect(db.isMongoUnavailableError(Object.assign(new Error("x"), { code: 13 }))).toBe(true);
  expect(db.isMongoUnavailableError(new Error("Command find requires authentication"))).toBe(true);
  expect(db.isMongoUnavailableError(Object.assign(new Error("x"), { name: "MongoServerSelectionError" }))).toBe(true);
  expect(db.isMongoUnavailableError(new Error("connect ECONNREFUSED 127.0.0.1:27017"))).toBe(true);
  // 与 Mongo 无关的错误不得被当成存储故障（否则真正的程序 bug 会被藏成 503）。
  expect(db.isMongoUnavailableError(new Error("boom"))).toBe(false);
  expect(db.isMongoUnavailableError(new TypeError("x is not a function"))).toBe(false);
  expect(db.isMongoUnavailableError(null)).toBe(false);
});

test("[I] 连接串脱敏：日志/错误里不能出现密码", async () => {
  const { db } = await loadDb();
  expect(db.redactMongoUri("mongodb://bxagent:secret@127.0.0.1:27017/?authSource=bx_agent")).toBe(
    "mongodb://bxagent:***@127.0.0.1:27017/?authSource=bx_agent",
  );
  // 无凭据的连接串原样返回（别把普通 URI 也改坏）。
  expect(db.redactMongoUri("mongodb://127.0.0.1:27017/bx_agent")).toBe("mongodb://127.0.0.1:27017/bx_agent");
});

test("[J] 存储层故障的对外口径固定为 503 + STORAGE_UNAVAILABLE（别退回 500）", async () => {
  const { db } = await loadDb();
  expect(db.STORAGE_UNAVAILABLE.status).toBe(503);
  expect(db.STORAGE_UNAVAILABLE.code).toBe("STORAGE_UNAVAILABLE");
  expect(db.STORAGE_UNAVAILABLE.message).toMatch(/存储服务/);
});
