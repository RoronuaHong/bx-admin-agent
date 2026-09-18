// 多 Agent 门户与路由的**前端镜像清单**（领域适配指南 §8.3）。
// 角色的真实定义在服务端 `apps/agent-server/src/roles.ts`；这里只描述「门户怎么展示、跳到哪」。
// 新增 Agent：服务端 roles.ts 加角色 → 这里加一条 → ChatPage 以 props 挂到对应路由。
export interface AgentEntry {
  /** 与服务端 roles.ts 的角色 id 一致；对话的 agentId 字段用它。 */
  id: string;
  path: string;
  label: string;
  description: string;
  icon: string;
}

export const AGENTS: AgentEntry[] = [
  {
    id: "generic",
    path: "/chat",
    label: "通用助手",
    description: "数据问答、文档检索、任务规划——引擎的默认形态。",
    icon: "◎",
  },
  {
    id: "movie",
    path: "/movie",
    label: "观影助手",
    description: "影片发现与了解：找片、按口味推荐、对比。只聊观影相关。",
    icon: "▶",
  },
];

export function listAgents(): AgentEntry[] {
  return AGENTS;
}
