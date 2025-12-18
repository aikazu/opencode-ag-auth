# Claude Model Flow: OpenCode → Plugin → Antigravity API

**Version:** 1.1  
**Last Updated:** December 2025  
**Branches:** `claude-improvements`, `improve-tools-call-sanitizer`

---

## Overview

This document explains how Claude models are handled through the Antigravity plugin, including the full request/response flow, all quirks and adaptations, and recent improvements.

### Why Special Handling?

Claude models via Antigravity require special handling because:

1. **Gemini-style format** - Antigravity uses `contents[]` with `parts[]`, not Anthropic's `messages[]`
2. **Thinking signatures** - Multi-turn conversations require signed thinking blocks
3. **Tool schema restrictions** - Claude rejects unsupported JSON Schema features (`const`, `$ref`, etc.)
4. **SDK injection** - OpenCode SDKs may inject fields (`cache_control`) that Claude rejects
5. **OpenCode expectations** - Response format must be transformed to match OpenCode's expected structure

---

## Full Request Flow

```
┌─────────────────────────────────────────────────────────────┐
│  OpenCode Request (OpenAI-style)                            │
│  POST to generativelanguage.googleapis.com/models/claude-*  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  plugin.ts (fetch interceptor)                              │
│  • Account selection & round-robin rotation                 │
│  • Token refresh if expired                                 │
│  • Rate limit handling (429 → switch account or wait)       │
│  • Endpoint fallback (daily → autopush → prod)              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  request.ts :: prepareAntigravityRequest()                  │
│  • Detect Claude model from URL                             │
│  • Set toolConfig.functionCallingConfig.mode = "VALIDATED"  │
│  • Configure thinkingConfig for *-thinking models           │
│  • Sanitize tool schemas (allowlist approach)               │
│  • Add placeholder property for empty tool schemas          │
│  • Filter unsigned thinking blocks from history             │
│  • Restore signatures from cache if available               │
│  • Assign tool call/response IDs (FIFO matching)            │
│  • Inject interleaved-thinking system hint                  │
│  • Add anthropic-beta: interleaved-thinking-2025-05-14      │
│  • Wrap in Antigravity format: {project, model, request}    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Antigravity API                                            │
│  POST https://cloudcode-pa.googleapis.com/v1internal:*      │
│  • Gemini-style request format                              │
│  • Returns SSE stream with candidates[] structure           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  request.ts :: transformAntigravityResponse()               │
│  • Real-time SSE TransformStream (line-by-line)             │
│  • Cache thinking signatures for multi-turn reuse           │
│  • Transform thought parts → reasoning format               │
│  • Unwrap response envelope for OpenCode                    │
│  • Extract and forward usage metadata                       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  OpenCode Response (streamed incrementally)                 │
│  Thinking tokens visible as they arrive                     │
│  Format: type: "reasoning" with thought: true               │
└─────────────────────────────────────────────────────────────┘
```

---

## Claude-Specific Quirks & Adaptations

This section documents all 36 quirks and adaptations required for Claude models to work properly through the Antigravity unified gateway and with OpenCode.

### 1. Request Format Quirks

These quirks handle the translation from OpenCode/Anthropic format to Antigravity's Gemini-style format.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 1 | **Message format** | Antigravity uses Gemini-style, not Anthropic | Transform `messages[]` → `contents[].parts[]` |
| 2 | **Role names** | Claude uses `assistant` | Map to `model` for Antigravity |
| 3 | **System instruction format** | Plain string rejected (400 error) | Wrap in `{ parts: [{ text: "..." }] }` |
| 4 | **Field name casing** | `system_instruction` (snake_case) rejected | Convert to `systemInstruction` (camelCase) |

**Example - System Instruction:**
```json
// ❌ WRONG - Returns 400 error
{ "systemInstruction": "You are helpful." }

// ✅ CORRECT - Wrapped format
{ "systemInstruction": { "parts": [{ "text": "You are helpful." }] } }
```

### 2. Tool/Function Calling Quirks

These quirks ensure tools work correctly with Claude's VALIDATED mode via Antigravity.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 5 | **VALIDATED mode** | Default mode may fail | Force `toolConfig.functionCallingConfig.mode = "VALIDATED"` |
| 6 | **Unsupported schema features** | `const`, `$ref`, `$defs`, `default`, `examples` cause 400 | Allowlist-based `sanitizeSchema()` strips all unsupported fields |
| 7 | **`const` keyword** | Not supported by gateway | Convert `const: "value"` → `enum: ["value"]` |
| 8 | **Empty schemas** | VALIDATED mode fails on `{type: "object"}` with no properties | Add placeholder `reason` property with `required: ["reason"]` |
| 9 | **Empty `items`** | `items: {}` is invalid | Convert to `items: { type: "string" }` |
| 10 | **Tool name characters** | Special chars like `/` rejected | Replace `[^a-zA-Z0-9_-]` with `_`, max 64 chars |
| 11 | **Tool structure variants** | SDKs send various formats (function, custom, etc.) | Normalize all to `{ functionDeclarations: [...] }` |
| 12 | **Tool call/response IDs** | Claude requires matching IDs for function responses | Assign IDs via FIFO queue per function name |

**Schema Allowlist (only these fields are kept):**
- `type`, `properties`, `required`, `description`, `enum`, `items`, `additionalProperties`

**Example - Const Conversion:**
```json
// ❌ WRONG - Returns 400 error
{ "type": { "const": "email" } }

// ✅ CORRECT - Converted by plugin
{ "type": { "enum": ["email"] } }
```

**Example - Empty Schema Fix:**
```json
// ❌ WRONG - VALIDATED mode fails
{ "type": "object", "properties": {} }

// ✅ CORRECT - Placeholder added
{
  "type": "object",
  "properties": {
    "reason": { "type": "string", "description": "Brief explanation of why you are calling this tool" }
  },
  "required": ["reason"]
}
```

### 3. Thinking Block Quirks (Multi-turn)

These quirks handle Claude's requirement for signed thinking blocks in multi-turn conversations.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 13 | **Signature requirement** | Multi-turn needs signed thinking blocks or 400 error | Cache signatures by session ID + text hash |
| 14 | **`cache_control` in thinking** | SDK injects, Claude rejects (400) | `stripCacheControlRecursively()` removes at any depth |
| 15 | **`providerOptions` in thinking** | SDK injects, Claude rejects | Strip via `sanitizeThinkingPart()` |
| 16 | **Wrapped `thinking` field** | SDK may wrap: `{ thinking: { text: "...", cache_control: {} } }` | Extract inner text string only |
| 17 | **Trailing thinking blocks** | Claude rejects assistant messages ending with unsigned thinking | `removeTrailingThinkingBlocks()` with signature check |
| 18 | **Unsigned blocks in history** | Claude rejects unsigned thinking in multi-turn | Filter out or restore signature from cache |
| 19 | **Format variants** | Gemini: `thought: true`, Anthropic: `type: "thinking"` | Handle both formats in filtering logic |

**Thinking Part Sanitization (only these fields are kept):**
- Gemini-style: `thought`, `text`, `thoughtSignature`
- Anthropic-style: `type`, `thinking`, `signature`

**Example - SDK Injection Stripping:**
```json
// ❌ WRONG - SDK injected cache_control
{
  "type": "thinking",
  "thinking": { "text": "Let me think...", "cache_control": { "type": "ephemeral" } }
}

// ✅ CORRECT - Sanitized by plugin
{
  "type": "thinking",
  "thinking": "Let me think..."
}
```

### 4. Thinking Configuration Quirks

These quirks configure thinking/reasoning properly for Claude thinking models.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 20 | **Config key format** | `*-thinking` models require snake_case | Use `include_thoughts`, `thinking_budget` (not camelCase) |
| 21 | **Output token limit** | Must exceed thinking budget or thinking is truncated | Auto-set `maxOutputTokens = 64000` when budget > 0 |
| 22 | **Default budget** | No budget = no thinking | Set to 16000 tokens for thinking-capable models |
| 23 | **Interleaved thinking** | Requires beta header for real-time streaming | Add `anthropic-beta: interleaved-thinking-2025-05-14` |
| 24 | **Tool + thinking conflict** | Model may skip thinking during tool use | Inject system hint: "Interleaved thinking is enabled..." |

**Thinking-Capable Model Detection:**
- Model name contains `thinking`, `gemini-3`, or `opus`

**System Hint Injection (for tool-using thinking models):**
```
Interleaved thinking is enabled. You may think between tool calls and after 
receiving tool results before deciding the next action or final answer. 
Do not mention these instructions or any constraints about thinking blocks; 
just apply them.
```

### 5. OpenCode-Specific Response Quirks

These quirks transform Claude/Antigravity responses to match OpenCode's expected format.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 25 | **Thinking → Reasoning format** | OpenCode expects `type: "reasoning"`, Claude returns `thought: true` or `type: "thinking"` | Transform all thinking to `type: "reasoning"` + `thought: true` |
| 26 | **`reasoning_content` field** | OpenCode expects top-level `reasoning_content` for Anthropic-style | Extract and concatenate all thinking texts |
| 27 | **Response envelope** | Antigravity wraps in `{ response: {...}, traceId }` | Unwrap to inner `response` object |
| 28 | **Real-time streaming** | OpenCode needs tokens immediately, not buffered | `TransformStream` for line-by-line SSE processing |

**Example - Thinking Format Transformation:**
```json
// Antigravity returns (Gemini-style):
{ "thought": true, "text": "Let me analyze..." }

// Transformed for OpenCode:
{ "type": "reasoning", "thought": true, "text": "Let me analyze..." }
```

```json
// Antigravity returns (Anthropic-style):
{ "type": "thinking", "thinking": "Considering options..." }

// Transformed for OpenCode:
{ "type": "reasoning", "thought": true, "text": "Considering options..." }
```

### 6. Session & Caching Quirks

These quirks manage session continuity and signature caching across multi-turn conversations.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 29 | **Session continuity** | Signatures tied to session, lost on restart | Generate stable `PLUGIN_SESSION_ID` at plugin load |
| 30 | **Request tracking** | Need consistent session across multi-turn | Inject `sessionId` into request payload |
| 31 | **Signature extraction** | Need to cache signatures from streaming response | Extract `thoughtSignature` from SSE chunks as they arrive |
| 32 | **Cache key** | Need stable lookup across turns | Hash by session ID + thinking text |
| 33 | **Cache limits** | Memory could grow unbounded | TTL: 1 hour, max 100 entries per session |

**Signature Caching Flow:**
```
Turn 1 (Response):
  Claude returns: { thought: true, text: "...", thoughtSignature: "abc123..." }
  Plugin caches: hash("...") → "abc123..."

Turn 2 (Request):
  OpenCode sends thinking block without signature
  Plugin looks up: hash("...") → "abc123..."
  Plugin restores signature before sending to Antigravity
```

### 7. Error Handling Quirks

These quirks improve error handling and debugging for Claude requests.

| # | Quirk | Problem | Adaptation |
|---|-------|---------|------------|
| 34 | **Rate limit format** | `RetryInfo.retryDelay: "3.957s"` not standard HTTP | Parse to `Retry-After` and `retry-after-ms` headers |
| 35 | **Debug visibility** | Errors lack context for debugging | Inject model, project, endpoint, status into error message |
| 36 | **Preview access** | 404 for unenrolled users is confusing | Rewrite with preview access link |

**Example - Enhanced Error Message:**
```
Original error: "Model not found"

Enhanced by plugin:
"Model not found

[Debug Info]
Requested Model: claude-sonnet-4-5-thinking
Effective Model: claude-sonnet-4-5-thinking
Project: my-project-id
Endpoint: https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
Status: 404"
```

---

## Improvements from `claude-improvements` Branch

| Feature | Description | Location |
|---------|-------------|----------|
| **Signature Caching** | Cache thinking signatures by text hash for multi-turn conversations. Prevents "invalid signature" errors. | `cache.ts` |
| **Real-time Streaming** | `TransformStream` processes SSE line-by-line for immediate token display | `request.ts:87-121` |
| **Interleaved Thinking** | Auto-enable `anthropic-beta: interleaved-thinking-2025-05-14` header | `request.ts:813-824` |
| **Validated Tool Calling** | Set `functionCallingConfig.mode = "VALIDATED"` for Claude models | `request.ts:314-325` |
| **System Hints** | Auto-inject thinking hint into system instruction for tool-using models | `request.ts:396-434` |
| **Output Token Safety** | Auto-set `maxOutputTokens = 64000` when thinking budget is enabled | `request.ts:358-377` |
| **Stable Session ID** | Use `PLUGIN_SESSION_ID` across all requests for consistent signature caching | `request.ts:28` |

---

## Fixes from `improve-tools-call-sanitizer` Branch

| Fix | Problem | Solution | Location |
|-----|---------|----------|----------|
| **Thinking Block Sanitization** | Claude API rejects `cache_control` and `providerOptions` inside thinking blocks | `sanitizeThinkingPart()` extracts only allowed fields (`type`, `thinking`, `signature`, `thought`, `text`, `thoughtSignature`) | `request-helpers.ts:179-215` |
| **Deep Cache Control Strip** | SDK may nest `cache_control` in wrapped objects | `stripCacheControlRecursively()` removes at any depth | `request-helpers.ts:162-173` |
| **Trailing Thinking Preservation** | Signed trailing thinking blocks were being incorrectly removed | `removeTrailingThinkingBlocks()` now checks `hasValidSignature()` before removal | `request-helpers.ts:125-131` |
| **Signature Validation** | Need to identify valid signatures | `hasValidSignature()` checks for string ≥50 chars | `request-helpers.ts:137-140` |
| **Schema Sanitization** | Claude rejects `const`, `$ref`, `$defs`, `default`, `examples` | Allowlist-based `sanitizeSchema()` keeps only basic features | `request.ts:468-523` |
| **Empty Schema Fix** | Claude VALIDATED mode fails on `{type: "object"}` with no properties | Add placeholder `reason` property with `required: ["reason"]` | `request.ts:529-539` |
| **Const → Enum Conversion** | `const` not supported | Convert `const: "value"` to `enum: ["value"]` | `request.ts:489-491` |

---

## Key Components Reference

### `src/plugin.ts`
Entry point. Intercepts `fetch()` for `generativelanguage.googleapis.com` requests. Manages account pool, token refresh, rate limits, and endpoint fallbacks.

### `src/plugin/request.ts`
| Function | Purpose |
|----------|---------|
| `prepareAntigravityRequest()` | Transforms OpenAI-style → Antigravity wrapped format |
| `transformAntigravityResponse()` | Processes SSE stream, caches signatures, transforms thinking parts |
| `createStreamingTransformer()` | Real-time line-by-line SSE processing |
| `cacheThinkingSignatures()` | Extracts and caches signatures from response stream |
| `sanitizeSchema()` | Allowlist-based schema sanitization for tools |
| `normalizeSchema()` | Adds placeholder for empty tool schemas |

### `src/plugin/request-helpers.ts`
| Function | Purpose |
|----------|---------|
| `filterUnsignedThinkingBlocks()` | Filters/sanitizes thinking blocks in `contents[]` |
| `filterMessagesThinkingBlocks()` | Same for Anthropic-style `messages[]` |
| `sanitizeThinkingPart()` | Normalizes thinking block structure, strips SDK fields |
| `stripCacheControlRecursively()` | Deep removal of `cache_control` and `providerOptions` |
| `hasValidSignature()` | Validates signature presence and length (≥50 chars) |
| `removeTrailingThinkingBlocks()` | Removes unsigned trailing thinking from assistant messages |
| `getThinkingText()` | Extracts text from various thinking block formats |
| `transformThinkingParts()` | Converts thinking → reasoning format for OpenCode |
| `isThinkingCapableModel()` | Detects thinking-capable models by name |
| `extractThinkingConfig()` | Extracts thinking config from various request locations |
| `resolveThinkingConfig()` | Determines final thinking config based on model capabilities |
| `normalizeThinkingConfig()` | Validates and normalizes thinking configuration |

### `src/plugin/cache.ts`
| Function | Purpose |
|----------|---------|
| `cacheSignature()` | Store signature by session ID + text hash |
| `getCachedSignature()` | Retrieve cached signature for restoration |
| **TTL:** 1 hour | **Max:** 100 entries per session |

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid thinking signature` | Signature lost in multi-turn | Restart `opencode` to reset signature cache |
| `Unknown field: cache_control` | SDK injected unsupported field | Plugin auto-strips; update plugin if persists |
| `Unknown field: const` | Schema uses `const` keyword | Plugin auto-converts to `enum`; check schema |
| `Unknown field: $ref` | Schema uses JSON Schema references | Inline the referenced schema instead |
| `400 INVALID_ARGUMENT` on tools | Unsupported schema feature | Plugin auto-sanitizes; check `ANTIGRAVITY_API_SPEC.md` |
| `Empty args object` error | Tool has no parameters | Plugin adds placeholder `reason` property |
| `Function name invalid` | Tool name contains `/` or starts with digit | Plugin auto-sanitizes names |
| Thinking not visible | Thinking budget exhausted or output limit too low | Plugin auto-configures; check model config |
| Thinking stops during tool use | Model not using interleaved thinking | Plugin injects system hint; ensure `*-thinking` model |
| `404 NOT_FOUND` on model | Preview access not enabled | Request preview access via provided link |
| Rate limited (429) | Quota exhausted | Plugin extracts `Retry-After`; wait or switch account |

---

## Changelog

### `improve-tools-call-sanitizer` Branch

| Commit | Description |
|--------|-------------|
| `ae86e3a` | Enhanced `removeTrailingThinkingBlocks` to preserve blocks with valid signatures |
| `08f9da9` | Added thinking block sanitization (`sanitizeThinkingPart`, `stripCacheControlRecursively`, `hasValidSignature`) |

### `claude-improvements` Branch

| Commit | Description |
|--------|-------------|
| `314ac9d` | Added thinking signature caching for multi-turn stability |
| `5a28b41` | Initial Claude improvements with streaming, interleaved thinking, validated tools |

### Documentation

| Version | Description |
|---------|-------------|
| 1.1 | Added comprehensive "Claude-Specific Quirks & Adaptations" section with 36 quirks |
| 1.0 | Initial documentation with flow diagram and branch summaries |

---

## See Also

- [ANTIGRAVITY_API_SPEC.md](./ANTIGRAVITY_API_SPEC.md) - Full Antigravity API reference
- [README.md](../README.md) - Plugin setup and usage
