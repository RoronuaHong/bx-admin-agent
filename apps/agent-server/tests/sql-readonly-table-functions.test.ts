// 只读闸门的**表值函数**边界（2026-10-15 审计新增）。
//
// 为什么单列一组用例：表值函数的首词是 `select`、也不含任何写操作关键字，
// 只靠首词白名单 + 关键字黑名单**全部放行**——但它们能越出数据库边界：
//   · url()/urlCluster()/remote()/remoteSecure() → 任意出网（SSRF，可读云元数据凭据）
//   · file()/hdfs()/s3()                        → 读服务器本地文件或对象存储
//   · mysql()/postgresql()/mongodb()/redis()    → 连其它数据源，绕过本库账号权限边界
import { test, expect } from "vitest";
import { isReadOnlySql, READONLY_DENIED_TABLE_FUNCTIONS } from "../scripts/sql-readonly-common.mjs";

test("[A] 能越出边界的表值函数一律拒（首词是 select 也不行）", () => {
  const mustDeny = [
    "SELECT * FROM url('http://169.254.169.254/latest/meta-data/')",
    "SELECT * FROM url('http://internal-service/actuator/env')",
    "SELECT * FROM urlCluster('http://h', ['a', 'b'])",
    "SELECT * FROM remote('otherhost:9000', db.tbl)",
    "SELECT * FROM remoteSecure('h:9440', db.tbl)",
    "SELECT * FROM file('/etc/passwd')",
    "SELECT * FROM file('/app/.env')",
    "SELECT * FROM s3('http://bucket.s3/secret')",
    "SELECT * FROM hdfs('hdfs://n/path')",
    "SELECT * FROM mysql('host:3306', 'db', 'tbl', 'u', 'p')",
    "SELECT * FROM postgresql('host:5432', 'db', 'tbl', 'u', 'p')",
    "SELECT * FROM redis('host:6379', 1, 'key')",
    "SELECT count() FROM url('http://x')",
  ];
  for (const sql of mustDeny) {
    expect(isReadOnlySql(sql), `必须拒绝：${sql}`).toBe(false);
  }
});

test("[B] 不得误伤：不越界的内联表函数与常规查询照常放行", () => {
  const mustAllow = [
    "SELECT * FROM values('a', 1)",
    "SELECT * FROM numbers(10)",
    "SELECT a FROM t WHERE b = 1 LIMIT 10",
    "SELECT * FROM system.tables LIMIT 10",
    // 列名/别名里出现这些词，但不是函数调用
    "SELECT file_id, url_count FROM t LIMIT 10",
    "SELECT remote_addr, executable_name FROM t LIMIT 10",
    // 字面量里出现，不该触发
    "SELECT a FROM t WHERE note = 'url(' LIMIT 10",
  ];
  for (const sql of mustAllow) {
    expect(isReadOnlySql(sql), `不该被拒：${sql}`).toBe(true);
  }
});

test("[C] 表函数判定发生在脱引号之后：注释里的函数名不算", () => {
  const withLineComment = isReadOnlySql("SELECT a FROM t -- FROM url('http://x')");
  expect(withLineComment).toBe(true);
  const withBlockComment = isReadOnlySql("SELECT a FROM t /* FROM file('/etc/passwd') */ WHERE a > 1 LIMIT 5");
  expect(withBlockComment).toBe(true);
});

test("[D] 清单本身受保护：不允许被悄悄清空", () => {
  expect(READONLY_DENIED_TABLE_FUNCTIONS.length).toBeGreaterThanOrEqual(10);
  for (const fn of ["url", "file", "s3", "remote", "mysql", "postgresql", "redis", "hdfs"]) {
    expect(READONLY_DENIED_TABLE_FUNCTIONS).toContain(fn);
  }
});

test("[E] 原有只读口径没被带坏（回归）", () => {
  expect(isReadOnlySql("SELECT 1")).toBe(true);
  expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  expect(isReadOnlySql("DELETE FROM t")).toBe(false);
  expect(isReadOnlySql("SELECT 1; DROP TABLE t")).toBe(false);
  expect(isReadOnlySql("SELECT a INTO OUTFILE '/tmp/x' FROM t")).toBe(false);
  expect(isReadOnlySql("SELECT * FROM t SETTINGS max_threads = 1")).toBe(true);
});