# tenant-config — ChatbotX config (Pencil Beauty)

Source of truth for the salon AI config on the self-hosted ChatbotX stack. Not in production yet.

## Files
- `ai-agents/salon.json` — AI Agent spec. Agents are not importable: copy `prompt` into the agent System Message; Tools = `_tools`.

## Current state (2026-11-28)
- Agent model: Groq `openai/gpt-oss-120b` (OpenAI Compatible integration).
- Worker image `ghcr.io/pencilbeauty/chatbotx-worker:1.23.0-pencil.3` = upstream 1.23.0 + one patch: openai-compatible requests drop assistant `reasoning_content`, which Groq rejects after a tool call. Patch branch `pencil/v1.23.0-patch` in PencilBeauty/chatbot (local build, see Confluence 39420011).
- ERP data comes from the `erp-mcp` service in this compose (`services/erp-mcp`, MCP Streamable HTTP, stateless): `list_services`, `list_branches`, `check_free_slots(service_id, branch_id, date YYYY-MM-DD, guests)`. Results: `ok` (start-time ranges), `no_slots`, `invalid`, or `erp_unavailable` (isError) so an outage is never read as "no free slots".
- Booking is two tools. `prepare_booking(service_id, branch_id, date, time HH:MM, guests, full_name, mobile, privacy_consent=true)` writes nothing: it re-checks the time is free, holds the booking for 30 min under the guest's mobile and returns a summary (`ready`, `slot_taken`, `already_booked`, `invalid_contact`, `invalid`). `create_booking(mobile, guest_confirmed=true)` books the latest prepared summary for that mobile, because ChatbotX keeps only text in the conversation history (tool results and ids are gone next turn, and the agent stops after 5 steps). It calls `POST /v1/public/bookings` with `X-Idempotency-Key` = hash of branch, service, start time, guests and mobile, so a repeat call returns the same booking (`ok`, `slot_taken`, `rejected`, `expired`, or `erp_unavailable` = NOT booked). After a timeout it looks the booking up by mobile before reporting failure. The tool descriptions make the agent ask for privacy consent (link `PRIVACY_POLICY_URL`) before preparing and for an explicit yes to the summary before creating; the consent time is written into the booking note. Names and phone numbers are redacted in erp-mcp logs. AI Functions are not used: they run their flow asynchronously and return `""` to the agent.
- Workspace timezone must be `Asia/Ho_Chi_Minh` (Settings → General → Advanced); the agent prompt uses `{{current_time}}`.

## MCP server (once)
1. VPS `.env`: `ERP_MCP_TOKEN=<random>`; `docker compose -p chatbotx up -d --build erp-mcp`.
2. ChatbotX → MCP Servers → + Create: Name `pencil_erp`, URL `http://erp-mcp:8080/mcp`, Auth Token = `ERP_MCP_TOKEN` → Get Tools → select all tools → Confirm.
3. Agent → Tools: add the `pencil_erp` server (after a tool change in `erp-mcp`, run Get Tools again).

## Apply a change
1. Agent: copy `ai-agents/salon.json` `prompt` into the System Message; set Tools from `_tools`.
2. Delete Message History on the test conversation, then test.
