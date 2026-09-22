// 临时探针：检查一个 GitLab token 的身份 / 角色 / 仓库读权限。token 从环境变量读。
const TOKEN = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
const BASE = process.env.GITLAB_API_URL || "https://git.work.xxbbc.com/api/v4";
const PROJECT = process.env.PROBE_PROJECT || "web/bx-film-admin-in2";

if (!TOKEN) {
  console.error("missing GITLAB_PERSONAL_ACCESS_TOKEN");
  process.exit(2);
}

const H = { headers: { "PRIVATE-TOKEN": TOKEN } };
const urls = [
  `${BASE}/user`,
  `${BASE}/projects/${encodeURIComponent(PROJECT)}`,
  `${BASE}/projects/${encodeURIComponent(PROJECT)}/repository/branches?per_page=3`,
  `${BASE}/projects/${encodeURIComponent(PROJECT)}/repository/tree?per_page=3&ref=dev`,
  `${BASE}/projects/${encodeURIComponent(PROJECT)}/repository/files/package.json/raw?ref=dev`,
];

for (const u of urls) {
  const short = u.replace(BASE, "");
  try {
    const r = await fetch(u, H);
    let t = await r.text();
    if (short === "/projects/web%2Fbx-film-admin-in2") {
      try {
        const j = JSON.parse(t.replace(/^\uFEFF/, "").trim());
        t = `id=${j.id} default_branch=${j.default_branch} perms=${JSON.stringify(j.permissions)}`;
      } catch {}
    }
    if (short === "/user") {
      try {
        const j = JSON.parse(t.replace(/^\uFEFF/, "").trim());
        t = `id=${j.id} username=${j.username} name=${j.name} bot=${j.bot}`;
      } catch {}
    }
    console.log(`[${r.status}] ${short} :: ${t.replace(/\s+/g, " ").slice(0, 260)}`);
  } catch (e) {
    console.log(`[ERR] ${short} :: ${e.message}`);
  }
}
