# tenant-config — ChatbotX config (Pencil Beauty, SCRUM-393)

Declarative source of truth for the salon AI config. Created once in the ChatbotX
builder; these files are the spec to review or rebuild from.

## Files
- `flows/get_services.chatbotx-flow.json` — the flow (import via UI: Flows → Import Flow).
- `ai-functions/get_services.json` — AI Function spec (create by hand in AI Functions).
- `ai-agents/salon.json` — AI Agent spec (create by hand in AI Agents).

## Set up once (UI)
0. Settings → Integrations: Groq (OpenAI Compatible) is the model used everywhere. A Google Gemini key is connected only to unlock AI Agents (ChatbotX ignores OpenAI-Compatible providers when unlocking).
1. **Flows → Import Flow** → `flows/get_services.chatbotx-flow.json` and `flows/get_offerings.chatbotx-flow.json`; **Publish** each (import creates a draft only). Check Import history = Success 1. Nothing to build by hand.
2. **AI Agents → AI Functions → + Create AI Function** from `ai-functions/get_services.json` and `ai-functions/get_offerings.json`; **Trigger Flow ID** = the imported flow.
3. **AI Agents → + Create AI Agent** from `ai-agents/salon.json`; model Groq `openai/gpt-oss-120b`; **Tools → Function** `get_services` + `get_offerings`.

## What it does (SCRUM-393)
Flow calls `GET /v1/public/services` (header `X-Tenant-ID`), maps `content` → custom field `erp_services_json`. The flow's AI Generate Text step (Groq) writes the VI/EN answer from that list only and sends it; the Agent never invents a price (ERP has no price field — SCRUM-391). Full runbook: Confluence page 39682059.

## Two catalogs
- `get_services` → `/public/services`: bookable services with duration, no price.
- `get_offerings` → `/public/offering-variants`: priced menu items (`service_id` may be null). Kept separate so prices are never attached to a bookable service by guesswork.
- Both point at **nonprod** for now; switch base URL + `X-Tenant-ID` together when moving to prod.

## How it works (SCRUM-394, patched worker)
Needs the patched worker image `ghcr.io/pencilbeauty/chatbotx-worker:1.23.0-pencil.1` (see `docker-compose.yml`, Confluence page 39420011). With it, an AI Function whose **Output message contains a `{{variable}}`** runs its Trigger Flow inline and returns the resolved Output message to the agent; nothing is sent to the guest by the flow. Upstream images ignore this and send the Output message as text.

- Flows only fetch data: `setCustomField` writes `ERP_UNAVAILABLE` first, then one `callApi` maps the ERP payload into a custom field. A failed call leaves `ERP_UNAVAILABLE`, so an outage is never read as "no data". No AI step, no `sendText`.
- The agent writes every reply. Voice and general rules live only in the agent prompt; it also gets `Current time: {{current_user_time}}` to resolve "mai", "thứ 7".
- Each AI Function carries its own rules: **Purpose** = when to call; **Output message** = the data plus how to read it (empty list, `ERP_UNAVAILABLE`).
- Booking lookup: agent calls `get_services` (service_id) and `get_branches` (branch_id), then `check_availability(service_id, branch_id, date YYYY-MM-DD, guests)` -> `GET /v1/public/bookings/availability/slots`.

| Function | Flow file | Custom field | ERP endpoint |
|---|---|---|---|
| get_services | flows/get_services | erp_services_json | /v1/public/services |
| get_offerings | flows/get_offerings | erp_offerings_json | /v1/public/offering-variants |
| get_branches | flows/get_branches | erp_branches_json | /v1/public/branches |
| check_availability | flows/check_availability | avail_slots_json (+ avail_service, avail_branch, avail_date, avail_guests) | /v1/public/bookings/availability/slots |

## Apply a change
1. Flows → Import Flow → the changed file; **Publish** (import creates a new draft flow).
2. AI Functions: set Purpose / Data collect / Output message from `ai-functions/<name>.json`; **Trigger Flow ID** = the new flow; archive the old flow.
3. Agent: copy `ai-agents/salon.json` `prompt` into the System Message (agents are not importable); Tools = the `_tools` list.
4. Delete Message History on the test conversation, then test.
