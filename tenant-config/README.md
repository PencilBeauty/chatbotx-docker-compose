# tenant-config — ChatbotX config (Pencil Beauty, SCRUM-393)

Declarative source of truth for the salon AI config. Created once in the ChatbotX
builder; these files are the spec to review or rebuild from.

## Files
- `flows/get_services.chatbotx-flow.json` — the flow (import via UI: Flows → Import Flow).
- `ai-functions/get_services.json` — AI Function spec (create by hand in AI Functions).
- `ai-agents/salon.json` — AI Agent spec (create by hand in AI Agents).

## Set up once (UI)
1. **Flows → Import Flow** → `get_services.chatbotx-flow.json` → **Publish**.
2. **AI Functions → + Create** → name/purpose/output message from `ai-functions/get_services.json`; **Trigger Flow** = the imported flow.
3. **AI Agents → + Create** → prompt/model from `ai-agents/salon.json`; **Tools** → enable `get_services`.

## What it does (SCRUM-393)
Flow calls `GET /v1/public/services` (header `X-Tenant-ID`), maps `$.content` → custom field `erp_services_json`. The Agent phrases the reply bilingually and never invents a price (ERP has no price field — SCRUM-391).
