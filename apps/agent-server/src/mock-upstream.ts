/**
 * 上游 Mock：开发/评测用假登录 token 时，call_api 不打真实网关，避免「登录过期」。
 * 真登录（JWT）仍走真实上游。
 */
export const mockMenus = [
  {
    name: "邀请裂变",
    englishName: "Share",
    children: [{ name: "基础设置", englishName: "ShareConfigPage" }],
  },
  {
    name: "VIP",
    englishName: "Vip",
    children: [{ name: "获取兑换码", englishName: "VipGetExchangeCode" }],
  },
  {
    name: "账号",
    englishName: "Account",
    children: [
      { name: "用户列表", englishName: "AccountUserPage" },
      { name: "白名单管理", englishName: "AccountWhiteListManagePage" },
    ],
  },
  {
    name: "平台",
    englishName: "Platform",
    children: [{ name: "域名管理", englishName: "PlatformDomainPage" }],
  },
];

export function mockLogin(username: string) {
  return {
    token: `mock-token-${username}`,
    user: { id: 1, loginName: username, name: username },
    menus: mockMenus,
  };
}

export function isMockToken(token?: string | null): boolean {
  return Boolean(token && String(token).startsWith("mock-token-"));
}

/** 按 operation/path 返回可被 normalize_output 消费的模拟业务数据 */
export function mockCallApiResult(input: {
  operation?: string;
  path?: string;
  method?: string;
  params?: Record<string, unknown>;
}): unknown {
  const op = String(input.operation || "").toLowerCase();
  const p = String(input.path || "").toLowerCase();
  const params = input.params || {};
  const id = String(params.id || params.userId || params.deviceId || "10001");

  if (/white_list|beabw\/list/.test(op + p) && !/audit|listaudit|apply/.test(op + p)) {
    return {
      code: 0,
      data: {
        list: [
          {
            deviceId: "dev-mock-001",
            userId: "10038557464768004",
            remark: "评测白名单",
            createTime: "2026-08-20 12:00:00",
            status: 1,
          },
          {
            deviceId: "dev-mock-002",
            userId: "10038557464768005",
            remark: "演示数据",
            createTime: "2026-08-19 09:30:00",
            status: 1,
          },
        ],
        total: 2,
      },
      _mock: true,
      _hint: "mock-token 模式：未请求真实上游",
    };
  }

  if (/white_list|beabw/.test(op + p) && /audit|apply|listaudit/.test(op + p)) {
    return {
      code: 0,
      data: { list: [{ id: "apply-1", userId: id, status: 0 }], total: 1 },
      _mock: true,
    };
  }

  if (/useraccount\/get|user\.get|user\.getlist|user\.getbyid/.test(op + p)) {
    if (params.id || /detail|getbyid/.test(op) || String(params.id || "")) {
      return {
        code: 0,
        data: {
          id,
          loginName: "demo_user",
          nickName: "演示用户",
          status: 1,
          createTime: "2026-01-01 00:00:00",
        },
        _mock: true,
      };
    }
    return {
      code: 0,
      data: {
        list: [
          { id: "10038557464768004", loginName: "u1", nickName: "用户A", status: 1 },
          { id: "10038557464768005", loginName: "u2", nickName: "用户B", status: 1 },
        ],
        total: 2,
      },
      _mock: true,
    };
  }

  // 登录数据统计：与 PC getLoginDataTotal 一致返回行数组（unwrap 后）
  if (/logindatatotal|login_data_total/.test(op + p)) {
    const days: Array<Record<string, unknown>> = [];
    let end = new Date();
    let start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
    if (typeof params.endTime === "string") {
      const e = new Date(String(params.endTime).replace(/-/g, "/"));
      if (!Number.isNaN(e.getTime())) end = e;
    }
    if (typeof params.startTime === "string") {
      const s = new Date(String(params.startTime).replace(/-/g, "/"));
      if (!Number.isNaN(s.getTime())) start = s;
    }
    // 按天生成（最多 31 天），对齐 PC statisticalCycle=1
    const dayMs = 24 * 60 * 60 * 1000;
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    const n = Math.min(31, Math.max(1, Math.round((endDay.getTime() - startDay.getTime()) / dayMs) + 1));
    for (let i = 0; i < n; i++) {
      const d = new Date(startDay.getTime() + i * dayMs);
      const cycle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const totalCount = 1000 + i * 37;
      const successCount = 700 + i * 29;
      const successRatio = Number(((successCount / totalCount) * 100).toFixed(2));
      days.push({ cycle, successCount, totalCount, successRatio });
    }
    const sumSuccess = days.reduce((a, r) => a + Number(r.successCount), 0);
    const sumTotal = days.reduce((a, r) => a + Number(r.totalCount), 0);
    days.push({
      cycle: "汇总",
      successCount: sumSuccess,
      totalCount: sumTotal,
      successRatio: sumTotal ? Number(((sumSuccess / sumTotal) * 100).toFixed(2)) : 0,
    });
    return days;
  }

  // 通用报表 / 图表（观影时长、收入、留存、充值等）：返回带 cycle + 多数值字段的行，
  // 用于验证 presentGenericChart 自动推断字段并出真 ECharts。
  if (
    !/logindatatotal|login_data_total/.test(op + p) &&
    /(analysis|report|total|duration|income|recharge|retention|ltv|watchmovie|besummary)/.test(op + p)
  ) {
    const cycles = ["2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"];
    const rows = cycles.map((cycle, i) => ({
      cycle,
      playCount: 1200 + i * 80,
      duration: 54000 + i * 3200,
      income: 3200.5 + i * 210.3,
      recharge: 1500 + i * 95,
    }));
    rows.push({
      cycle: "汇总",
      playCount: rows.reduce((a, r) => a + Number(r.playCount), 0),
      duration: rows.reduce((a, r) => a + Number(r.duration), 0),
      income: Number(rows.reduce((a, r) => a + Number(r.income), 0).toFixed(2)),
      recharge: rows.reduce((a, r) => a + Number(r.recharge), 0),
    });
    return rows;
  }

  if (/vipExchangeCode|exchange|film\.get|movie\/|movietimetag|country\.|vipOrder/i.test(op + p)) {
    return {
      code: 0,
      data: {
        list: [{ id, name: "mock-item", status: 1, title: "演示记录" }],
        total: 1,
        ...(params.id ? { id, detail: true } : {}),
      },
      _mock: true,
    };
  }

  return {
    code: 0,
    data: {
      ok: true,
      operation: input.operation || null,
      path: input.path || null,
      params,
      message: "mock 上游默认成功响应",
    },
    _mock: true,
  };
}
