// 临时验证脚本：把中文提问写在脚本里（避免 PowerShell 传中文参数乱码），
// 复用 _movie-e2e-now.mjs 的完整流程（建对话 → /chat/stream → 打印最终回复）。
process.argv[2] = "10部恐怖搞笑电影，高分，不同国家";
await import("./_movie-e2e-now.mjs");
