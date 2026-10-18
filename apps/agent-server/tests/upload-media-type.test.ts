import { expect, test } from "vitest";
import { getUploadImage, saveUpload } from "../src/uploads.js";
import { createApp } from "../src/app.js";

function fakeFile(name: string, type: string, body: string) {
  const bytes = new TextEncoder().encode(body);
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer as ArrayBuffer };
}

test("伪造 type：x.txt + text/html 落库为 text/plain，不按浏览器给的类型回放", async () => {
  const saved = await saveUpload(fakeFile("x.txt", "text/html", "<script>alert(1)</script>"));
  expect(getUploadImage(saved.id)?.mediaType).toBe("text/plain");

  const res = await createApp().request(`/chat/upload/${saved.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
  expect(res.headers.get("content-disposition")).toBe("attachment");
});

test("svg 伪装成 png 文件名：文件头不是 png，拒收", async () => {
  await expect(saveUpload(fakeFile("a.png", "image/svg+xml", "<svg onload=alert(1)>"))).rejects.toThrow(/不是 png/);
});

test("后缀不在白名单：type 谎称图片也拒收", async () => {
  await expect(saveUpload(fakeFile("evil.html", "image/png", "<script>alert(1)</script>"))).rejects.toThrow(/不支持/);
});
