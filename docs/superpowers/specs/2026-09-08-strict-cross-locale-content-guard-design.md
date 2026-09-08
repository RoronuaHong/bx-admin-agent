# Strict Cross-Locale Content Guard Design

## Goal

Extend the existing i18n runtime work so that, under strict mode, non-target UI locales do not directly display raw source-language content that falls outside localized system chrome.

This design focuses on display governance for:

- stored user message bodies
- stored assistant message bodies
- knowledge and document snippets
- source code and file-content excerpts
- tool-result fields that contain free-form natural-language text

The target behavior is intentionally strict for `pt-BR` and `hi`: system text remains localized, while source-language content is hidden behind localized placeholders unless the UI locale is `zh`.

## Decisions

### 1. Separate system text from source content

The product now treats these as different classes of output:

- `system`: product-authored runtime text, errors, labels, status, and guidance
- `source content`: user-authored text, assistant-authored historical text, snippets from knowledge/doc sources, file contents, source code, and free-form diagnostic text

System text must always be localized to the active UI locale. Source content must not be silently translated or allowed to leak into non-target locales under strict mode.

### 2. Enforce at render time first

Primary enforcement happens in the frontend display layer, not only at content creation time.

This ensures:

- historical stored messages are governed without migration
- old tool results are still covered
- newly added backend tools still have a frontend fail-closed path if they forget to add explicit metadata

### 3. Add lightweight content classification for new outputs

Backend tool results should carry enough field semantics for the frontend to distinguish:

- structural identifiers such as `id`, `url`, `path`, `module`, `status`
- display text such as `snippet`, `summary`, `content`, `detail`, `answer`

The first implementation does not require a new universal schema. It extends existing result payloads with clearer field naming and, where useful, explicit type hints.

### 4. Hide rather than translate raw source content

Strict mode does not auto-translate hidden raw content. Instead it replaces it with localized placeholder text that explains what was hidden.

This avoids:

- incorrect or partial machine translation
- fallback leakage when translation is unavailable
- mixing verified UI locale text with lossy translated source evidence

## Scope

### In scope

- chat-history title and message-body display rules
- tool-result presentation rules for natural-language fields
- knowledge/doc snippet presentation
- source-code and file-content excerpt presentation
- localized placeholder text for each hidden content category
- tests and smoke checks for the strict-mode behavior

### Out of scope

- translating historical user or assistant content
- rewriting upstream business data at the API layer
- deleting hidden raw content from storage
- building a user-facing "show original text" override in this phase
- changing the LLM reply-language precedence already implemented

## Content Model

The display layer should reason about content in the following categories:

- `system`
- `user-authored`
- `assistant-authored`
- `knowledge-snippet`
- `code-snippet`
- `file-content`
- `business-text`
- `identifier-or-structured-value`

`identifier-or-structured-value` includes values that are not natural-language copy and should remain visible even in strict mode, such as:

- ids
- enum-like statuses
- URLs
- file names
- module ids
- API paths
- numbers, booleans, timestamps

## Rendering Rules

### Locale gate

When `uiLocale === "zh"`, raw stored/source content may render normally.

When `uiLocale !== "zh"` and strict mode is active:

- `system` content must render localized
- `identifier-or-structured-value` remains visible
- all other source-content categories are hidden by default

### Per-category behavior

- `user-authored`: replace with a localized placeholder indicating historical user text was hidden
- `assistant-authored`: replace with a localized placeholder indicating historical assistant text was hidden
- `knowledge-snippet`: replace with a localized placeholder indicating a knowledge/document snippet was hidden
- `code-snippet`: replace with a localized placeholder indicating source code was hidden
- `file-content`: replace with a localized placeholder indicating file content was hidden
- `business-text`: replace with a localized placeholder indicating raw business text was hidden

### Object-level behavior

For mixed structured objects:

- preserve structural fields
- hide only the fields judged to be free-form natural-language text
- do not replace the entire object unless every visible field is hidden

## Frontend Changes

### `apps/web/src/chat-storage.ts`

Generalize the existing historical-content masking helpers so they can:

- distinguish user vs assistant stored content
- handle more than CJK-only detection when needed
- return category-specific localized placeholders

### `apps/web/src/tool-result-presenter.ts`

Add a stricter presentation pass that:

- recognizes natural-language fields such as `snippet`, `summary`, `content`, `detail`, `question`, `answer`
- hides source-language prose for non-`zh` locales
- preserves identifiers, URLs, paths, file names, counts, and other structured values
- treats obvious code or file text as hidden content categories rather than raw display text

This remains fail-closed for unstructured raw text: if a payload is not safely classifiable and looks like source-language prose, it should be hidden in non-`zh` locales.

### `apps/web/src/pages/ChatPage.vue`

Consume the stricter helpers instead of introducing page-local masking rules. The page should render the already-judged text, keeping policy centralized.

## Backend Changes

### Tool result semantics

Update backend tools that commonly return raw snippets or excerpts so their payloads make the frontend decision easier.

Primary targets:

- `search_knowledge_base`
- `search_dingtalk_doc`
- `read_local`
- other tool results that emit file bodies, snippets, or free-form summaries

Preferred approach:

- keep structured payloads as JSON
- use field names that reflect semantics
- add explicit content-type markers when the field name alone is not enough

### Backward compatibility

Do not break old stored results or current clients. The frontend strict-render pass must still handle legacy payloads heuristically.

## Placeholder Copy

Add localized placeholders for at least:

- hidden stored user text
- hidden stored assistant text
- hidden knowledge snippet
- hidden source code
- hidden file content
- hidden raw business text

The placeholders must be explicit about what category was hidden, so the UI stays understandable even when many raw snippets are suppressed.

## Validation

Minimum validation for this design:

1. historical user messages do not leak raw Chinese or English in `pt-BR` and `hi`
2. historical assistant messages do not leak raw Chinese or English in `pt-BR` and `hi`
3. knowledge/doc snippets are replaced with localized placeholders in non-`zh` locales
4. code/file excerpts are replaced with localized placeholders in non-`zh` locales
5. structured identifiers such as URL, file name, path, status, id remain visible
6. existing system-text localization still passes
7. web tests, agent-server tests, web typecheck, and workspace build continue to pass

## Risks And Guardrails

- Over-hiding: a heuristic may classify useful structured text as prose. Mitigation: prefer field-based classification before heuristic detection.
- Under-hiding: a new backend field may carry prose without metadata. Mitigation: keep fail-closed rendering for suspicious raw text.
- UX confusion: users may not understand why content disappeared. Mitigation: use category-specific placeholders instead of a generic hidden marker.
- Drift between backend and frontend: future tools may invent inconsistent fields. Mitigation: document the category rules and reuse existing presenter helpers.

## Implementation Order

1. extend frontend masking helpers for category-specific strict placeholders
2. expand tool-result presenter classification and fail-closed handling
3. add backend field semantics for knowledge/doc/file/code-like outputs
4. add and update tests
5. run smoke checks, typecheck, and build
