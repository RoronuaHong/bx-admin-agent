// 类型声明：让 src/sql-readonly.ts 在 tsc 类型检查下能 import 单一源模块而不报「implicitly any」。
// 逻辑本身见同目录 sql-readonly-common.mjs（唯一实现）。
export function isReadOnlySql(raw: unknown): boolean;
