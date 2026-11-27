# tenant-config — ChatbotX config (Pencil Beauty)

Source of truth for the salon AI config on the self-hosted ChatbotX stack. Not in production yet.

## Files
- `ai-agents/salon.json` — AI Agent spec. Agents are not importable: copy `prompt` into the agent System Message; Tools = `_tools`.

## Current state (2026-11-28)
- Agent model: Groq `openai/gpt-oss-120b` (OpenAI Compatible integration).
- Worker image `ghcr.io/pencilbeauty/chatbotx-worker:1.23.0-pencil.3` = upstream 1.23.0 + one patch: openai-compatible requests drop assistant `reasoning_content`, which Groq rejects after a tool call. Patch branch `pencil/v1.23.0-patch` in PencilBeauty/chatbot (local build, see Confluence 39420011).
- ERP data comes from the `erp-mcp` service in this compose (`services/erp-mcp`, MCP Streamable HTTP, stateless, read-only): `list_services`, `list_branches`, `check_free_slots(service_id, branch_id, date YYYY-MM-DD, guests)`. Results: `ok` (start-time ranges), `no_slots`, `invalid`, or `erp_unavailable` (isError) so an outage is never read as "no free slots". AI Functions are not used: they run their flow asynchronously and return `""` to the agent.
- Workspace timezone must be `Asia/Ho_Chi_Minh` (Settings → General → Advanced); the agent prompt uses `{{current_time}}`.

## MCP server (once)
1. VPS `.env`: `ERP_MCP_TOKEN=<random>`; `docker compose -p chatbotx up -d --build erp-mcp`.
2. ChatbotX → MCP Servers → + Create: Name `pencil_erp`, URL `http://erp-mcp:8080/mcp`, Auth Token = `ERP_MCP_TOKEN` → Get Tools → select all 3 → Confirm.
3. Agent → Tools: add the 3 `pencil_erp` tools (after a tool change in `erp-mcp`, run Get Tools again).

## Apply a change
1. Agent: copy `ai-agents/salon.json` `prompt` into the System Message; set Tools from `_tools`.
2. Delete Message History on the test conversation, then test.
