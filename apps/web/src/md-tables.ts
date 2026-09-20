// 模型输出的表格 markdown 修复（纯字符串处理，不依赖 DOM，便于单测）。
//
// 背景：模型常把分隔行写少列（表头 5 列、分隔行只写 2 列）。
// GFM 要求分隔行列数与表头一致，不一致则整块不生成表格，
// 退化成带 <br> 的 <p>——用户看到的就是一坨竖线文本。

function isPipeRow(l: string): boolean {
  return /^\s*\|.*\|\s*$/.test(l);
}

/** 拆出单元格（去掉首尾管道符）。 */
function cells(l: string): string[] {
  return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

/** 该单元格是不是分隔单元格（--- / :--: / --: 之类）。 */
function isDelimCell(c: string): boolean {
  return /^:?-{1,}:?$/.test(c.trim());
}

/**
 * 修模型写坏的表格 markdown，使其符合 GFM。两类常见畸形：
 *   1) 分隔行列数与表头不一致；
 *   2) 分隔行后面粘着第一行数据（缺换行），分隔行不再「纯」。
 * 两者都会让整块退化成带 <br> 的 <p>。
 * 做法：取开头连续的分隔单元格作为分隔行并补齐到表头列数，剩余部分补回一行数据。
 */
export function repairTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] ?? "";
    // 围栏代码块里的表格示例是纯文本，不能改。
    if (/^\s*(```|~~~)/.test(head)) inFence = !inFence;
    const next = lines[i + 1] ?? "";
    if (!inFence && isPipeRow(head) && isPipeRow(next)) {
      const nc = cells(next);
      let k = 0;
      while (k < nc.length && isDelimCell(nc[k] ?? "")) k++;
      if (k >= 1) {
        const rest = nc.slice(k);
        if (rest.length) rest[0] = (rest[0] ?? "").replace(/^\s*-+/, "");
        const want = Math.max(cells(head).length, 1);
        // 只在真畸形时改写（列数不符 / 后面粘了数据）；正确分隔行原样保留。
        if (k !== want || rest.length > 0) {
          const fixed: string[] = [];
          // 补齐时保留原有对齐标记（--- / :-- / --: / :--:），不把作者意图抹平。
          for (let j = 0; j < want; j++) fixed.push(j < k ? (nc[j] ?? "---") : "---");
          out.push(head, "|" + fixed.join("|") + "|");
        } else {
          out.push(head, next);
        }
        const restJoined = rest.join("|").trim().replace(/^\|/, "");
        if (restJoined) out.push("| " + restJoined);
        i++;
        continue;
      }
    }
    out.push(head);
  }
  return out.join("\n");
}
