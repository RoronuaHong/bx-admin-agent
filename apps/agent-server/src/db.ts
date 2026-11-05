// 共享 MongoDB 连接：全服务唯一 MongoClient 单例（懒连接 + 失败冷却 + 可用性自检），
// 避免各模块（conversations / task-store / schedules / movie）各开一套连接池。
// 各模块仍各自保留「连不上 → 内存降级」的 fallback 语义，本文件只负责把「拿到一个 client」这件事统一掉。
//
// 三条硬约束（都是被 2026-11-05 事故逼出来的，改这里之前先读 docs/mongo-outage-incident-20261105.md）：
// ① **连上 ≠ 能用**：connect() 成功只代表握手完成；凭据/权限不对时握手照样过，
//    真正报错在第一条查询（"Command find requires authentication"）。所以每次建连后
//    必须 ping 自检——否则配置错误会以「接口 500 刷屏」的形式出现，而不是一句「凭据不对」。
// ② **认证错不空转、也不静默降级**：凭据错是配置问题，30s 冷却重试只是刷日志；但若把它
//    当成「Mongo 不在」而降级到内存，用户会看到「会话列表空了」——数据其实还在库里。
//    故认证错一律显式报错（不可降级），只有「从未连上过且非认证问题」才允许降级。
// ③ **坏掉的 client 不复用**：连接断开/报错后要丢掉单例，否则永远复用坏连接，
//    只能靠重启进程恢复（2026-11-05 事故即此形态：Mongo 侧出问题后进程一直 500）。
import { MongoClient } from "mongodb";

export const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "bx_agent";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const CONNECT_RETRY_COOLDOWN = 30_000;

let client: MongoClient | null = null;
let clientPromise: Promise<MongoClient> | null = null;
/** 最近一次失败：既当冷却计时器，也带着「这次故障能不能降级 / 该怎么说」的语义。 */
let lastFailure: { at: number; degradable: boolean; message: string } | null = null;
/** 本进程是否成功连上过：决定故障时能否降级到内存（见 MongoUnavailableError.degradable）。 */
let everConnected = false;
/** 致命配置错误（凭据明确错误）：重试无意义，改完 MONGO_URI 需重启进程。 */
let fatalError: MongoUnavailableError | null = null;

/**
 * Mongo 不可用错误：额外带一个 `degradable` 语义，让调用方能区分两种故障——
 * - degradable=true：**冷启动就没连上**（Mongo 压根没起来），允许降级到进程内存（既有契约）；
 * - degradable=false：**运行期掉线 / 认证失效**，必须显式报错——静默降级会让用户
 *   以为会话丢了（库里其实还在），比报错危险得多。
 */
export class MongoUnavailableError extends Error {
  readonly degradable: boolean;
  constructor(message: string, opts: { degradable: boolean; cause?: unknown }) {
    super(message);
    this.name = "MongoUnavailableError";
    this.degradable = opts.degradable;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** 认证/权限类错误判定：Mongo 明确说「没认证通过 / 凭据不对 / 无权限」。 */
export function isMongoAuthError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (e.code === 13) return true; // Unauthorized
  if (e.code === 18) return true; // AuthenticationFailed
  return /requires authentication|authentication failed|not authorized/i.test(String(e.message || ""));
}

/** 「凭据明确错误」判定：这种重试无意义（要改 MONGO_URI 并重启），应当 fail-fast 而不是每 30s 空转。 */
function isFatalAuthError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e) return false;
  if (e.code === 18) return true;
  return /authentication failed/i.test(String(e.message || ""));
}

/** Mongo 不可用判定（认证错 / 连不上 / 选服超时 / 网络断）：给上层把 500 收敛成 503 用。 */
export function isMongoUnavailableError(err: unknown): boolean {
  if (err instanceof MongoUnavailableError) return true;
  if (isMongoAuthError(err)) return true;
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const name = String(e?.name || "");
  if (
    name === "MongoServerSelectionError" ||
    name === "MongoNetworkError" ||
    name === "MongoNotConnectedError" ||
    name === "MongoTopologyClosedError" ||
    name === "MongoPoolClosedError"
  ) {
    return true;
  }
  const msg = String(e?.message || "");
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|server selection|topology (was )?closed|connection (closed|timeout)/i.test(msg);
}

/** 凭据脱敏：日志里绝不能出现密码（连接串曾被原样打进日志）。 */
export function redactMongoUri(uri: string): string {
  return String(uri).replace(/\/\/([^/@:]+):([^@]*)@/, "//$1:***@");
}

/**
 * 存储层故障的统一对外口径：503 + 明确 code。
 * 与 500 INTERNAL_ERROR 区分开——存储不可用是可恢复的故障（重连即恢复），
 * 让调用方一眼能分清「服务端程序 bug」和「数据库暂时不可用」。
 */
export const STORAGE_UNAVAILABLE = {
  status: 503,
  code: "STORAGE_UNAVAILABLE",
  message: "存储服务暂不可用，请稍后重试",
} as const;

function errText(err: unknown): string {
  return String((err as Error)?.message || err);
}

/** 丢掉单例（只认自己那一份，避免把后来新建的连接误杀）。 */
function dropClient(c: MongoClient) {
  if (client === c) {
    client = null;
    clientPromise = null;
  }
}

/** 监听连接断开：把单例清掉，下次 getMongoClient 会重新连（否则会一直复用已死的 client）。 */
function attachLifecycle(c: MongoClient) {
  c.on("close", () => dropClient(c));
  c.on("error", () => dropClient(c));
}

/** 共享 MongoClient 单例：懒连接 + 失败冷却（30s 内不重试），冷却中 reject。 */
export function getMongoClient(): Promise<MongoClient> {
  // 致命配置错误：重试没意义（凭据要改 .env 并重启进程），直接拒绝，别再空转刷日志。
  if (fatalError) return Promise.reject(fatalError);
  // 已连上：直接返回缓存的 client。
  if (clientPromise && client) return clientPromise;
  // 正在连接中：复用同一个 promise，避免并发建多个 client。
  if (clientPromise) return clientPromise;
  // 冷却中：刚失败过，别把 Mongo 打挂，也别让每个请求都等选服超时。
  // 沿用上次的失败原因（认证错要继续点名配置问题，别退化成一句「冷却中」）。
  if (lastFailure && Date.now() - lastFailure.at < CONNECT_RETRY_COOLDOWN) {
    return Promise.reject(
      new MongoUnavailableError(
        `${lastFailure.message}（冷却中，30s 内不重试）`,
        { degradable: lastFailure.degradable },
      ),
    );
  }
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  client = c;
  attachLifecycle(c);
  clientPromise = c
    .connect()
    .then(async (connected) => {
      // 可用性自检：ping 才真正验证「凭据/权限可用」。连上但没认证的连接必须在这里被拦下。
      await connected.db(MONGO_DB_NAME).command({ ping: 1 });
      everConnected = true;
      lastFailure = null;
      console.log(`[db] MongoDB 已连接 ${redactMongoUri(MONGO_URI)}/${MONGO_DB_NAME}`);
      return connected;
    })
    .catch((err) => {
      dropClient(c);
      c.close().catch(() => {});
      if (isMongoAuthError(err)) {
        // 认证错：无论哪种都不允许降级（降级=假装没数据），直接点名配置问题。
        const fatal = new MongoUnavailableError(
          `MongoDB 认证失败：${errText(err)}。请检查 MONGO_URI 是否带用户名/密码、authSource 是否指向正确的库（改完需重启进程）。`,
          { degradable: false, cause: err },
        );
        lastFailure = { at: Date.now(), degradable: false, message: fatal.message };
        if (isFatalAuthError(err)) {
          // 凭据明确错误：重试无用 → fail-fast（后续调用直接拒绝，不再每 30s 空转）。
          fatalError = fatal;
        }
        console.error(`[db] ${fatal.message}`);
        throw fatal;
      }
      const message = `MongoDB 连接失败：${errText(err)}`;
      lastFailure = { at: Date.now(), degradable: !everConnected, message };
      console.warn(`[db] ${message}`);
      throw new MongoUnavailableError(message, {
        // 从未连上过 → 允许调用方降级到内存；连上过之后的掉线 → 必须显式报错。
        degradable: !everConnected,
        cause: err,
      });
    });
  return clientPromise;
}

/**
 * 上层捕获到 Mongo 错误时调用：把坏掉的 client 作废（下次请求重建连接 → Mongo 恢复后能自愈，
 * 不必重启进程），并把凭据类错误升级为致命（别再每 30s 空转重试）。
 *
 * 注意这里**不**进冷却：故障多半只影响这一条查询，Mongo 可能好好的（网络抖动、单条命令失败）。
 * 立刻让下一次请求重连才是自愈；真连不上，连接路径自己会进冷却。
 */
export function reportMongoFailure(err: unknown): void {
  if (!isMongoUnavailableError(err)) return;
  const c = client;
  if (c) {
    dropClient(c);
    c.close().catch(() => {});
  }
  if (isMongoAuthError(err)) {
    // 凭据/权限错是配置问题：重试无用（要改 MONGO_URI 并重启进程），直接 fail-fast。
    const fatal = new MongoUnavailableError(
      `MongoDB 认证失败：${errText(err)}。请检查 MONGO_URI 凭据与 authSource（改完需重启进程）。`,
      { degradable: false, cause: err },
    );
    fatalError = fatal;
    console.error(`[db] ${fatal.message}`);
  }
}
