# UI Language And Message Persistence Design

## Scope

This design covers three related follow-up improvements for `bx-admin-agent`:

1. Stabilize the remaining `knowledge / explain / clarify / backend` validation work on the current `main` branch.
2. Allow the web frontend UI to switch languages without changing the assistant reply language.
3. Persist assistant reasoning and tool-call details with each assistant message so they survive refresh and can be restored from database-backed conversation history.

The goal is to extend existing conversation storage and chat UI flows with the smallest viable change set that matches current architecture.

## Decisions

### 1. UI language only affects frontend chrome

The language switch controls frontend interface text only:

- login page labels and helper copy
- chat page buttons, placeholders, statuses, fold titles, and errors
- reusable component labels that are part of the page chrome

It does **not** rewrite:

- existing assistant message bodies
- current assistant reply language policy
- model-side reply-language preference handling

### 2. Reasoning and tool details belong to each assistant message

`reasoning` and `toolResults` are persisted as part of a single assistant message, alongside existing `text`, `tables`, `charts`, and `files`.

This keeps refresh recovery aligned with how users experience the UI today: the reasoning block and tool details reappear inside the same message bubble after reload.

### 3. Reuse existing conversation persistence

Do not create a separate message-log or trace table for this feature.

Instead, extend the existing stored conversation message structure on both frontend and backend. This keeps the change focused, minimizes query complexity, and avoids rebuilding message-to-log joins during refresh.

## Data Model

Extend stored assistant messages with optional fields:

- `uiLanguage?: string`
- `reasoning?: string`
- `toolResults?: Array<{ name: string; result: string }>`
- `toolStep?: number`
- `currentTool?: string`

Do not persist `reasoningExpanded`. That is view-local interaction state and can continue to use frontend defaults on reload.

Compatibility rules:

- old messages missing these fields must remain valid
- backend APIs must treat them as optional
- frontend restore logic must default to empty reasoning/tool details

## Data Flow

### Frontend language state

Frontend stores a lightweight UI locale state and restores it on load. It should be independent from assistant reply-language preferences.

Recommended storage order:

1. local UI state
2. local persistence for refresh survival
3. optional future sync to user preference APIs if needed later

For this implementation, local persistence is sufficient.

### Assistant message persistence

Current frontend behavior updates the active assistant bubble incrementally while SSE events arrive. Keep that behavior.

Persist timing:

1. create or update user message locally when send starts
2. stream assistant message in memory as events arrive
3. on `done`, `error`, or `cancel`, save the completed message snapshot through existing conversation save API

If mid-stream durability becomes necessary later, add throttled checkpoint writes. It is intentionally out of scope for the first implementation.

### Refresh restore

On page load:

1. restore UI language
2. fetch conversations from backend
3. hydrate assistant bubbles from stored message fields
4. initialize fold states with frontend defaults

No separate trace lookup is required for normal refresh recovery.

## Validation Work

The current validation follow-up should continue on `main` and focus on the remaining unstable intent-routing cases:

- `knowledge` should not be swallowed by explain short-circuit
- `clarify` evaluation should match the new server-side clarify exit
- `how-to` prompts should converge on `explain-capability` before extra tool drift

Validation artifacts should be updated to reflect current behavior rather than legacy expectations such as requiring `request_clarification` tool events.

## Error Handling

- Missing persisted `reasoning` or `toolResults` must not break bubble rendering.
- If backend returns older message documents, frontend treats absent fields as empty.
- If conversation save fails, keep the current local in-memory UI and show existing error handling; do not discard the rendered assistant output.
- Language-switch failure in local persistence should degrade to the current session language without blocking chat.

## Testing

Minimum verification:

1. frontend UI language switch updates core visible chrome and survives refresh
2. assistant reasoning and tool detail blocks appear after refresh for completed messages
3. old stored conversations still render normally
4. targeted routing validation still covers `knowledge`, `clarify`, `explain`, and `backend`
5. existing `m1-instance-check` remains green

## Out Of Scope

- changing assistant reply language together with UI language
- historical message body translation
- dedicated trace explorer UI
- fine-grained mid-stream persistence checkpoints
- separate analytics schema for reasoning/tool telemetry
