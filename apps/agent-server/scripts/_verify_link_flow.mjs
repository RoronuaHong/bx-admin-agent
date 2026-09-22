import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cookieFile = join(tmpdir(), "bx_agent_cookie_verify.txt");
const ownerKey = "253fdd3a-7891-45fd-997c-3b5d1277421b";
const convId = "conv_1789958040402_k0l0kz";

try {
  // Step 1: first request with owner param, save cookies
  execSync(
    `curl.exe -s -c "${cookieFile.replace(/\\/g, "\\\\")}" "http://localhost:5173/agent/chat/preferences?owner=${ownerKey}"`,
    { encoding: "utf-8" },
  );

  // Step 2: subsequent request using cookies (simulating browser after cookie is set)
  const raw = execSync(
    `curl.exe -s -b "${cookieFile.replace(/\\/g, "\\\\")}" "http://localhost:5173/agent/chat/conversations?agentId=generic"`,
    { encoding: "utf-8" },
  );
  const json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const conv = json.conversations.find((c) => c.id === convId);
  console.log("target found:", !!conv);
  console.log("messages count:", conv?.messages?.length ?? 0);
  console.log("last msg role:", conv?.messages?.at(-1)?.role);
  console.log("last msg text preview:", conv?.messages?.at(-1)?.text?.slice(0, 60));
} finally {
  try {
    unlinkSync(cookieFile);
  } catch {}
}
