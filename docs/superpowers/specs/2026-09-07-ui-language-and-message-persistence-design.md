# UI Language And Message Persistence Design

## Goal

Add two capabilities to `bx-admin-agent` without introducing a new storage subsystem:

1. the web frontend UI can switch languages
2. assistant `reasoning` and `toolResults` persist with each assistant message and survive refresh

The design must stay aligned with the current conversation-based storage model and chat bubble rendering flow.

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

### UI locale state

UI language is **not** stored on each chat message. That would be redundant and does not affect model behavior.

Store UI locale as frontend-level state with refresh persistence. The first implementation can keep this state local to the frontend.

### Stored assistant message

Extend stored assistant messages with optional fields:

- `reasoning?: string`
- `toolResults?: Array<{ name: string; result: string }>`
- `toolStep?: number`
- `currentTool?: string`

Do not persist `reasoningExpanded`. It is view-local state and should continue to use frontend defaults on reload.

### Contract alignment note

The current frontend and backend `StoredMessage` contracts are not fully aligned, especially around `images`.

This feature should align the message DTO at the same time:

- keep existing message payloads backward compatible
- make backend and frontend agree on the shape used for persisted `images`
- treat new `reasoning/toolResults/toolStep/currentTool` fields as optional

## Data Flow

### Frontend language state

Frontend stores a lightweight UI locale state and restores it on load. It is independent from assistant reply-language preferences.

For the first implementation:

1. keep UI locale in frontend state
2. persist it locally for refresh survival
3. apply it to page chrome only

Syncing UI locale to backend user preferences is out of scope for this change.

### Assistant message persistence

Current frontend behavior updates the active assistant bubble incrementally while SSE events arrive. Keep that behavior.

Persist timing:

1. create or update user message locally when send starts
2. stream assistant message in memory as events arrive
3. on `done`, `error`, or `cancel`, save the completed conversation snapshot through the existing conversation save API

The first implementation does **not** require mid-stream checkpoint writes. If the page refreshes before completion, losing unfinished reasoning/tool details is acceptable for now.

### Refresh restore

On page load:

1. restore UI locale
2. fetch conversations from backend
3. hydrate assistant bubbles from stored message fields
4. initialize fold states with frontend defaults

No separate trace lookup is required for normal refresh recovery.

## Error Handling

- Missing persisted `reasoning` or `toolResults` must not break bubble rendering.
- If backend returns older message documents, frontend treats absent fields as empty.
- If conversation save fails, keep the current local in-memory UI and existing rendered assistant output.
- If UI locale persistence fails, fall back to the default frontend locale without blocking chat.

## Validation

Minimum verification:

1. frontend UI language switch updates core visible chrome and survives refresh
2. assistant reasoning and tool detail blocks appear after refresh for completed messages
3. old stored conversations still render normally
4. frontend and backend message DTOs remain compatible for existing conversation history
5. existing routing checks that are part of this branch continue to pass

## Out Of Scope

- changing assistant reply language together with UI language
- historical message body translation
- dedicated trace explorer UI
- mid-stream checkpoint persistence for unfinished assistant output
- separate analytics or telemetry schema for reasoning/tool events
