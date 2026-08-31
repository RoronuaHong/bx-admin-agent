// 验证文本 JSON 工具调用提取器（与 models.ts extractToolCallsFromJson 同逻辑）
// 样本来自 2026-08-24 实际日志：zen-nemotron 输出 [[{name,parameters}]] 裸数组/残缺 JSON

const samples = [
  // 1. 残缺嵌套数组（缺外层 ]，日志实测形态）
  ['残缺 [[{...}]', `[[{"name":"call_api","parameters":{"method":"GET","operation":"user.getUserList","base":"backend","params":{},"description":"查询用户列表"}}]`, ['call_api']],
  // 2. 完整嵌套数组 [[{...}]]
  ['完整嵌套数组', `[[{"name": "submit_understood_intent", "parameters": {"isBusinessRequest": true, "project": "bx-film-admin", "module": "user", "value": "", "operationType": "read", "operationHint": "列表", "summary": "查询用户列表"}}]]`, ['submit_understood_intent']],
  // 3. 对象形态 {tool_calls:[...]}
  ['对象形态', `{"tool_calls":[{"name":"grep_codebase","parameters":{"pattern":"getUserList"}}]}`, ['grep_codebase']],
  // 4. input 键 + 嵌套数组
  ['input键嵌套', `[[{"name":"read_api_module","input":{"module":"user/account_merge"}}]]`, ['read_api_module']],
  // 5. 普通文本（不应提取）
  ['普通文本', '好的，我马上帮你查询用户列表。', []],
  // 6. 普通 JSON（非工具形态，不应提取）
  ['普通JSON', '{"code":0,"msg":"ok"}', []],
];

function extractToolCallsFromJson(raw) {
  const out = [];
  const stripped = raw.replace(/^```[\s\S]*?\n/, '').replace(/\n?```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return extractToolCallsViaRegex(stripped);
  }
  const items = [];
  if (Array.isArray(parsed)) {
    const flatten = (arr) => { for (const v of arr) { if (Array.isArray(v)) flatten(v); else items.push(v); } };
    flatten(parsed);
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed;
    if (Array.isArray(obj.tool_calls)) items.push(...obj.tool_calls);
    else if (typeof obj.name === 'string') items.push(obj);
  }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item;
    const fn = o.function && typeof o.function === 'object' ? o.function : null;
    const name = String(o.name || (fn && fn.name) || '').trim();
    if (!name) continue;
    let args = o.parameters ?? o.input ?? o.arguments ?? (fn && fn.arguments) ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
    if (args && typeof args === 'object') out.push({ name, input: args });
  }
  return out;
}

function extractToolCallsViaRegex(raw) {
  const out = [];
  const nameRe = /\{\s*"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = nameRe.exec(raw))) {
    const name = m[1];
    const seg = raw.slice(m.index);
    const km = /"(?:parameters|input|arguments)"\s*:\s*/.exec(seg);
    if (!km) continue;
    const argsStart = m.index + km.index + km[0].length;
    if (raw[argsStart] === '"') {
      const endQuote = raw.indexOf('"', argsStart + 1);
      if (endQuote < 0) continue;
      try {
        const parsed = JSON.parse(raw.slice(argsStart, endQuote + 1));
        if (parsed && typeof parsed === 'object') out.push({ name, input: parsed });
      } catch { /* skip */ }
      nameRe.lastIndex = endQuote + 1;
      continue;
    }
    if (raw[argsStart] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = argsStart; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(raw.slice(argsStart, end + 1));
      if (parsed && typeof parsed === 'object') out.push({ name, input: parsed });
    } catch { /* skip */ }
    nameRe.lastIndex = end + 1;
  }
  return out;
}

let pass = 0;
for (const [label, raw, expect] of samples) {
  const got = extractToolCallsFromJson(raw).map((t) => t.name);
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${label}: got=[${got.join(',')}] expect=[${expect.join(',')}]`);
  if (!ok) {
    const detail = extractToolCallsFromJson(raw);
    console.log(`   detail=${JSON.stringify(detail).slice(0, 200)}`);
  }
}
console.log(`\n${pass}/${samples.length} 通过`);
process.exit(pass === samples.length ? 0 : 1);
