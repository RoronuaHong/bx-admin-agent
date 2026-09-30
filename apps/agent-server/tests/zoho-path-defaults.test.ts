import { test, expect } from "vitest";
import { annotateMcpToolSpec, applyPathDefaults, pathDefaultsForTool } from "../src/mcp/path-defaults.js";

const defaults = pathDefaultsForTool(
  { "*": { screenname: "ignored" }, ZohoSalesIQ_getConversationsList: { screenname: "castleapp" } },
  "ZohoSalesIQ_getConversationsList",
);

test("pathDefaults：工具级配置覆盖通配", () => {
  expect(defaults).toEqual({ screenname: "castleapp" });
  expect(pathDefaultsForTool(undefined, "ZohoSalesIQ_getConversationsList")).toBeUndefined();
});

test("applyPathDefaults：用配置的 portal 覆盖模型猜测的 screenname", () => {
  const out = applyPathDefaults(
    { path_variables: { screenname: "test" }, query_params: { limit: 1 } },
    defaults,
  ) as { path_variables: { screenname: string }; query_params: { limit: number } };
  expect(out.path_variables.screenname).toBe("castleapp");
  expect(out.query_params.limit).toBe(1);
});

test("applyPathDefaults：没传 path_variables 时补上固定值", () => {
  const out = applyPathDefaults({ query_params: { limit: 1 } }, defaults) as {
    path_variables: { screenname: string };
  };
  expect(out.path_variables.screenname).toBe("castleapp");
});

test("annotateMcpToolSpec：把固定 screenname 写进说明，禁止再猜 test/default", () => {
  const presented = annotateMcpToolSpec({
    description: "List conversations",
    parameters: {
      type: "object",
      properties: {
        path_variables: { type: "object", properties: { screenname: { type: "string" } } },
      },
    },
    defaults,
  });
  expect(presented.description).toContain("path_variables.screenname 必须为 castleapp");
  const props = presented.parameters.properties as {
    path_variables: { properties: { screenname: { const: string } } };
  };
  expect(props.path_variables.properties.screenname.const).toBe("castleapp");
});
