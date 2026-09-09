import type { ChatEvent } from "@bx/shared";
import type { StoredMessage } from "./conversations.js";

export function buildStoredAssistantMessageFromEvents(events: ChatEvent[]): StoredMessage | null {
  const assistant: StoredMessage = {
    role: "assistant",
    text: "",
  };
  for (const event of events) {
    if (event.type === "text") {
      assistant.text = event.text;
      continue;
    }
    if (event.type === "text_delta") {
      assistant.text += event.text;
      continue;
    }
    if (event.type === "reasoning") {
      assistant.reasoning = `${assistant.reasoning || ""}${event.text}\n`;
      continue;
    }
    if (event.type === "tool_result") {
      if (!assistant.toolResults) assistant.toolResults = [];
      assistant.toolResults.push({ name: event.name, result: event.result });
      continue;
    }
    if (event.type === "table") {
      if (!assistant.tables) assistant.tables = [];
      assistant.tables.push(JSON.parse(JSON.stringify(event.table)) as unknown);
      continue;
    }
    if (event.type === "chart") {
      if (!assistant.charts) assistant.charts = [];
      assistant.charts.push(JSON.parse(JSON.stringify(event.chart)) as unknown);
      continue;
    }
    if (event.type === "file") {
      if (!assistant.files) assistant.files = [];
      assistant.files.push(JSON.parse(JSON.stringify(event.file)) as unknown);
      continue;
    }
    if (event.type === "error") {
      assistant.errorToken = event.error;
      assistant.error = event.message || event.error.defaultMessage || "";
    }
  }
  return hasStoredMessageContent(assistant) ? assistant : null;
}

function hasStoredMessageContent(message: StoredMessage): boolean {
  return Boolean(
    message.text.trim()
      || message.errorToken?.code
      || message.error
      || message.reasoning?.trim()
      || message.toolResults?.length
      || message.tables?.length
      || message.charts?.length
      || message.files?.length,
  );
}
