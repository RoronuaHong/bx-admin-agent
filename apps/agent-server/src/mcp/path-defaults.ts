// 把 MCP 服务器上配置的 path_variables 固定值写进工具说明，并在真正调用前覆盖模型猜测。
// Zoho SalesIQ 的 screenname 就是 portal 名：猜成 test/default 时，接口返回的是
// code 1002「Invalid authorization header」，并不是授权头坏了。

export function pathDefaultsForTool(
  pathDefaults: Record<string, Record<string, string>> | undefined,
  tool: string,
): Record<string, string> | undefined {
  const star = pathDefaults?.["*"] || {};
  const specific = pathDefaults?.[tool] || {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...star, ...specific })) {
    const name = key.trim();
    const text = String(value ?? "").trim();
    if (name && text) out[name] = text;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 调用前写入固定 path_variables。已有同名字段也覆盖：配置值优先于模型猜测。 */
export function applyPathDefaults(
  args: Record<string, unknown>,
  defaults: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!defaults) return args;
  const current =
    args.path_variables && typeof args.path_variables === "object" && !Array.isArray(args.path_variables)
      ? { ...(args.path_variables as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(defaults)) current[key] = value;
  return { ...args, path_variables: current };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 把固定值写进模型看到的工具说明和参数 schema（const + 描述）。
 * 没有对应字段时补上 path_variables，避免说明里根本没有 screenname。
 */
export function annotateMcpToolSpec(input: {
  description: string;
  parameters: Record<string, unknown>;
  defaults?: Record<string, string>;
}): { description: string; parameters: Record<string, unknown> } {
  const defaults = input.defaults;
  if (!defaults) return { description: input.description, parameters: input.parameters };
  const parameters = JSON.parse(JSON.stringify(input.parameters || {})) as Record<string, unknown>;
  const props = asRecord(parameters.properties) || {};
  const pathNode = asRecord(props.path_variables) || { type: "object", properties: {} };
  const pathProps = asRecord(pathNode.properties) || {};
  for (const [key, value] of Object.entries(defaults)) {
    const field = asRecord(pathProps[key]) || { type: "string" };
    pathProps[key] = {
      ...field,
      const: value,
      description: `固定为 ${value}。不要填 test、default 或其它猜测值；未知 portal 会被接口误报为授权失败。`,
    };
  }
  pathNode.properties = pathProps;
  props.path_variables = pathNode;
  parameters.properties = props;
  if (!parameters.type) parameters.type = "object";
  const hint = Object.entries(defaults)
    .map(([key, value]) => `path_variables.${key} 必须为 ${value}`)
    .join("；");
  const description = input.description.includes(hint) ? input.description : `${input.description}\n${hint}`;
  return { description, parameters };
}
