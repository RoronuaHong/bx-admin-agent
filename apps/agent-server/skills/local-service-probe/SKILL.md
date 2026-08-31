---
name: local-service-probe
description: 探测本机/内网服务与接口：配合 fetch_url 访问 localhost 或内网地址，看接口返回、验证服务可用性。
version: 1.0.0
---

# 探测本机 / 内网服务指南

用户要求访问本机或内网服务（如 `http://localhost:3100`、`apiadmin.xxbbc.com`、公司内网地址）时：

## 流程

1. 用 `fetch_url` 直接抓目标 URL。文本类内容（HTML/JSON）会直接返回。
2. JSON 接口：把响应结构体关键字段读出来即可，不要放下整段原文。
3. 需要带参数/登录态时诚实说明限制（当前 fetch_url 不带 Cookie/Header），建议用户提供带鉴权的方式（如提供 token 的接口后续用企业 API 工具访问）。

## 输出

- 给出接口返回的关键字段与结论。
- 明确标注：哪些信息来自抓取，哪些是推断。