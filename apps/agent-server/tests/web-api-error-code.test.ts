// 前端 `apps/web/src/api.ts` 的错误码契约（本仓唯一 vitest 宿主在 agent-server，故跨包引用 web 侧的纯函数）。
//
// 回归目标（真实缺陷）：曾经用 `getApiErrorToken(err) === "CONVERSATION_BUSY"` 做判定 ——
// `getApiErrorToken()` 返回的是 token **对象**，与字符串比较**恒为 false**，于是 /chat 的 409 分支成了死代码：
//   · 同一对话并发（另一标签页在跑）时消息不会进待发队列；
//   · 而且会落进「连接中断」分支，因 isChatTaskRunning() 被别的标签页点亮而谎报「后台继续生成」——消息其实被服务端拒收。
// 唯一正确写法：`getApiErrorCode(err) === "CONVERSATION_BUSY"`。
import { test, expect } from "vitest";
import { ApiError, getApiErrorCode, getApiErrorToken } from "../../web/src/api";

/** 复刻服务端 409 响应体（见 agent-server `src/app.ts` 的 errorJson）。 */
const busyBody = {
  error: { code: "CONVERSATION_BUSY", defaultMessage: "该对话正在生成中：消息可排队，或先停止当前生成" },
  code: "CONVERSATION_BUSY",
  message: "该对话正在生成中：消息可排队，或先停止当前生成",
};

test("[A] 409 并发保护可被判定（死代码回归）", () => {
  // 与 chat.ts/api.ts 抛出的形态一致：token 与顶层 code 同时携带。
  const err = new ApiError(busyBody.message, { status: 409, token: busyBody.error, code: busyBody.code });
  expect(getApiErrorCode(err)).toBe("CONVERSATION_BUSY");

  // 把这个坑本身钉住：token 是**对象**，永远不等于字符串——所以判定绝不能拿它去比。
  expect(typeof getApiErrorToken(err)).toBe("object");
  expect(getApiErrorToken(err) as unknown).not.toBe("CONVERSATION_BUSY");
});

test("[B] 取值兜底：token.code 回退 / 缺失 / 异常输入", () => {
  // 只有 token（无顶层 code）：ApiError 构造时已用 token.code 兜底。
  expect(getApiErrorCode(new ApiError("x", { status: 409, token: { code: "RATE_LIMIT" } }))).toBe("RATE_LIMIT");
  // 只有顶层 code。
  expect(getApiErrorCode(new ApiError("x", { status: 500, code: "INTERNAL" }))).toBe("INTERNAL");
  // 什么都没有 → undefined：调用方据此走通用错误分支，而不是误判成并发。
  expect(getApiErrorCode(new ApiError("x", { status: 502 }))).toBeUndefined();
  expect(getApiErrorCode(new Error("boom"))).toBeUndefined();
  expect(getApiErrorCode(null)).toBeUndefined();
  expect(getApiErrorCode(undefined)).toBeUndefined();
  // 非 ApiError 的普通对象也认（兼容 fetch 层/第三方错误）。
  expect(getApiErrorCode({ code: "CONVERSATION_BUSY" })).toBe("CONVERSATION_BUSY");
  // 空白字符串视为缺失（不能 trim 后当成有效码）。
  expect(getApiErrorCode({ code: "   " })).toBeUndefined();
  // 非字符串 code（如 Node 的 errno 数字）不能误判。
  expect(getApiErrorCode({ code: 42 })).toBeUndefined();
  // 合法码两侧空白应被规整。
  expect(getApiErrorCode({ code: " RATE_LIMIT " })).toBe("RATE_LIMIT");
});

test("[C] token.code 与顶层 code 的优先级：顶层优先", () => {
  expect(getApiErrorCode(new ApiError("x", { token: { code: "A" }, code: "B" }))).toBe("B");
});

test("[D] 其它错误码不会被误判为并发保护", () => {
  expect(getApiErrorCode(new ApiError("限流", { status: 429, token: { code: "RATE_LIMIT" } }))).not.toBe("CONVERSATION_BUSY");
  expect(getApiErrorCode(new ApiError("额度", { status: 402, token: { code: "QUOTA_EXCEEDED" } }))).not.toBe("CONVERSATION_BUSY");
});
