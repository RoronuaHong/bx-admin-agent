import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve('D:/Code/bx-film-admin-in2/src/views/account/user/configs.data.tsx'),
  'utf8',
);

// —— 复制 output-tools.ts 的实现 ——
function extractColumnsFromSource(src) {
  const cols = [];
  const blocks = [];

  // a) 单行
  const singleRe = /\n\s*\{[^}\n]*\}/g;
  let sm;
  while ((sm = singleRe.exec(src))) {
    blocks.push({ start: sm.index, text: src.slice(sm.index + 1, sm.index + sm[0].length) });
  }

  // b) 多行
  const multiRe = /\n\s*\{\s*\n/g;
  let mm;
  while ((mm = multiRe.exec(src))) {
    const start = mm.index + mm[0].lastIndexOf('{');
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    blocks.push({ start, text: src.slice(start, end + 1) });
  }

  blocks.sort((a, b) => a.start - b.start);
  let lastEnd = 0;
  for (const block of blocks) {
    if (block.start < lastEnd) continue;
    lastEnd = block.start + block.text.length;
    const di = block.text.match(/dataIndex\s*:\s*['"`]([^'"`]+)['"`]/);
    const dataIndex = di?.[1]?.trim();
    if (!dataIndex) continue;
    if (cols.some((c) => c.dataIndex === dataIndex)) continue;

    const title = extractTitleFromBlock(block.text) || dataIndex;
    cols.push({ title, dataIndex });
  }
  return cols;
}

function extractTitleFromBlock(block) {
  // 1) 模板字符串
  const tmpl = block.match(/title\s*:\s*`([^`]*)`/);
  if (tmpl?.[1]) {
    const inner = tmpl[1];
    let out = '';
    let last = 0;
    const re = /\$\{getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*,?\s*\)\}/g;
    let m;
    while ((m = re.exec(inner))) {
      out += inner.slice(last, m.index).replace(/\$\{[^}]*\}/g, '') + m[1].trim().replace(/^\[|\]$/g, '');
      last = m.index + m[0].length;
    }
    out += inner.slice(last).replace(/\$\{[^}]*\}/g, '');
    return out.trim() || '';
  }
  // 2) 普通字符串
  const lit = block.match(/title\s*:\s*['"]([^'"]*)['"]/);
  if (lit?.[1]) return lit[1].trim();
  // 3) getTran
  const gtr = block.match(/getTran\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*,?\s*\)/);
  if (gtr?.[1]) return gtr[1].trim().replace(/^\[|\]$/g, '');
  // 4) i18n
  const i18n = block.match(/\bt\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  if (i18n?.[1]) return i18n[1].split('.').pop() || '';
  return '';
}

const cols = extractColumnsFromSource(src);
console.log(`提取到 ${cols.length} 列:`);
for (const c of cols) console.log(`  ${c.dataIndex.padEnd(30)} | ${c.title}`);

const expect = [
  { dataIndex: 'uid', title: '用户ID' },
  { dataIndex: 'mobile', title: '用户账号' },
  { dataIndex: 'nickname', title: '用户昵称' },
  { dataIndex: 'provider', title: '第三方登录' },
  { dataIndex: 'clientType', title: '客户端类型' },
  { dataIndex: 'channel', title: '渠道' },
  { dataIndex: 'userVipInfoRes.vipType', title: '会员等级' },
  { dataIndex: 'registerTime', title: '注册时间' },
  { dataIndex: 'userVipInfoRes.endDate', title: '会员到期' },
  { dataIndex: 'lastLoginTime', title: '最后登录' },
];
let pass = 0;
console.log('\n逐列断言:');
for (const e of expect) {
  const got = cols.find((c) => c.dataIndex === e.dataIndex);
  const ok = got && got.title === e.title;
  if (ok) pass++;
  console.log(`  ${ok ? '✅' : '❌'} ${e.dataIndex.padEnd(30)} expect="${e.title}" got="${got?.title || '(missing)'}"`);
}
console.log(`\n${pass}/${expect.length} 通过`);
process.exit(pass === expect.length ? 0 : 1);
