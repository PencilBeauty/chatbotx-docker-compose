# tenant-config — ChatbotX config (Pencil Beauty)

Source of truth for the salon AI config on the self-hosted ChatbotX stack. Not in production yet.

## Files
- `ai-agents/salon.json` — AI Agent spec. Agents are not importable: copy `prompt` into the agent System Message; Tools = `_tools`.

## Current state (2026-11-28)
- Agent model: Groq `openai/gpt-oss-120b` (OpenAI Compatible integration).
- Worker image `ghcr.io/pencilbeauty/chatbotx-worker:1.23.0-pencil.3` = upstream 1.23.0 + one patch: openai-compatible requests drop assistant `reasoning_content`, which Groq rejects after a tool call. Patch branch `pencil/v1.23.0-patch` in PencilBeauty/chatbot (local build, see Confluence 39420011).
- No ERP data tools: the AI Function + Trigger Flow lookups (get_services, get_offerings, get_branches, check_availability) were removed. AI Functions run their flow asynchronously (one step per job) and return `""` to the agent, so they cannot feed data back. ERP lookups move to an MCP server (design: Confluence 39616538).
- Workspace timezone must be `Asia/Ho_Chi_Minh` (Settings → General → Advanced); the agent prompt uses `{{current_time}}`.

## Apply a change
1. Agent: copy `ai-agents/salon.json` `prompt` into the System Message; set Tools from `_tools`.
2. Delete Message History on the test conversation, then test.
