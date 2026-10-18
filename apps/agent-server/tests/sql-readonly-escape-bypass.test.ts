import { expect, test } from "vitest";
import { isReadOnlySql } from "../src/sql-readonly.js";
import { isNativeSqlRejected } from "../src/risk.js";

test("query / sql 同时给时每个都要只读，不能拿合格的那个替另一个过闸", () => {
  const tools = ["run_native_query"];
  expect(isNativeSqlRejected(tools, "run_native_query", { query: "DROP TABLE t", sql: "SELECT 1" })).toBe(true);
  expect(isNativeSqlRejected(tools, "run_native_query", { query: "SELECT 1", sql: "DROP TABLE t" })).toBe(true);
  expect(isNativeSqlRejected(tools, "run_native_query", { query: "SELECT 1" })).toBe(false);
  expect(isNativeSqlRejected(tools, "run_native_query", {})).toBe(true);
});

test("反斜杠转义不能把越界表函数藏进「字面量」", () => {
  for (const sql of [
    String.raw`SELECT 'a\'' , url('http://169.254.169.254/','RawBLOB') , '\''`,
    String.raw`SELECT "a\"" , file('/etc/passwd') , "\""`,
    String.raw`SELECT 'x\'' ; DROP TABLE t ; SELECT '\''`,
  ]) {
    expect(isReadOnlySql(sql), sql).toBe(false);
  }
});

test("注释标记出现在字符串里不当注释处理", () => {
  expect(isReadOnlySql("SELECT '--' , url('http://x/') ")).toBe(false);
  expect(isReadOnlySql("SELECT '/*' , url('http://x/') , '*/'")).toBe(false);
});

test("未闭合的引号或块注释 fail-closed", () => {
  expect(isReadOnlySql("SELECT 'abc")).toBe(false);
  expect(isReadOnlySql("SELECT 1 /* x")).toBe(false);
});

test("Cluster / 对象存储 / 湖格式表函数整族拒绝", () => {
  for (const fn of ["s3Cluster", "azureBlobStorage", "gcs", "fileCluster", "hdfsCluster", "icebergS3", "deltaLake", "hudi", "sqlite"]) {
    const sql = `SELECT * FROM ${fn}('x', 'y')`;
    expect(isReadOnlySql(sql), sql).toBe(false);
  }
});

test("正常的双写引号与含关键字的字面量仍放行", () => {
  for (const sql of [
    "SELECT 'it''s' AS a",
    "SELECT 'url(http://x)' AS note FROM t",
    "SELECT s3_bucket_name FROM t",
    "SELECT count() FROM t WHERE name = 'drop'",
  ]) {
    expect(isReadOnlySql(sql), sql).toBe(true);
  }
});
