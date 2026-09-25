# Free Sandbox Shortlist for the Cross-System Transfer Experiment

Status: **research shortlist — no account created or software installed**

Checked against official sources on **2026-07-26**. Pricing, eligibility,
limits, and developer-program terms can change and must be rechecked before
account creation.

## Selection principles

A useful experiment environment is not merely free. It should:

- represent software used in a plausible customer workflow;
- expose a documented HTTP API;
- permit realistic writes and permission failures;
- be isolated from real data;
- be resettable;
- support an independent check of external state; and
- differ meaningfully from the current fictional procurement API.

## Strong general candidates

| System | Free environment | Why it is useful | Important limitation | Best fit |
| --- | --- | --- | --- | --- |
| HubSpot | Up to 10 free developer test accounts with sample CRM data and public API access | Fastest recognizable external control; REST API, OAuth, custom properties, contacts/companies/deals | Familiar and heavily integrated already; a HubSpot-only result would be weak transfer evidence. Accounts expire after 90 inactive days but can be renewed | CRM, sales, support, voice follow-up |
| monday.com | Free developer sandbox separate from production; up to 10 users, 1,000 items per product, high API limits | Durable, resettable business workflow world with permissions and custom board/column identifiers | GraphQL rather than conventional REST adds protocol work; may test GraphQL transport as much as capability acquisition | Operations, CRM, service, project agents |
| QuickBooks Online | Developer profile automatically includes a sandbox; up to 10; sample data; valid for two years; sandbox calls are not charged | Strong transfer test with real accounting semantics, OAuth, references, validation, and exact external outcomes | More setup and semantic complexity; use only draft/test objects and confirm account eligibility | Finance, back-office, vertical SMB agents |
| Shopify | Free development stores; unlimited test orders and products; generated test data | Real commerce objects, rich API, easy independent state checks, realistic idempotency risk | Common integration and not relevant unless commerce/merchant agents are a serious beachhead | Commerce and merchant-agent companies |
| Salesforce | Free Developer Edition that remains available with regular use | Deep permissions, custom objects/fields, OAuth, mature APIs; excellent anti-memorization configuration | Heavy setup and a very familiar enterprise integration target | CRM and enterprise-agent companies |
| Atlassian Jira/Confluence | Free cloud development site with Jira products and Confluence; limited development users | Real tickets, projects, comments, assignments and permissions; strong developer/IT workflow | Development program setup and multiple API surfaces; relevance depends on target segment | Engineering, IT, support, operations agents |
| Intercom | Free development workspace for testing and publishing apps | Real customer-service conversations, contacts and tickets | Development workspaces are US-region only and some installation behavior depends on app/workspace type | Customer-support agent companies |
| ServiceNow | Free Developer Program account can request a Personal Developer Instance | Real enterprise service workflows, permissions and complex records | Heavier, slower environment; personal instances may require activity/maintenance and should not be the first plumbing target | IT-service and enterprise operations agents |

## Strong local or open-source candidates

| System | Free environment | Why it is useful | Important limitation | Best use |
| --- | --- | --- | --- | --- |
| Frappe/ERPNext | Official Docker environment runs ERPNext/CRM/Helpdesk locally; Frappe automatically exposes REST CRUD APIs | No production data or external account; direct database verification; realistic permissions, workflows, custom fields and business records | Self-hosting makes it less independent than a third-party SaaS sandbox; installation is heavier than the current local services | Best zero-cost development substrate and possible transfer system |
| Cal.com | Open-source local development setup with API v2 | Understandable scheduling workflow, safe test bookings, useful for appointment agents | Scheduling APIs are common and too narrow alone; local setup has several services | Voice, scheduling and service-booking practice case |
| Twenty CRM | Open-source CRM with Docker self-hosting and API access | Modern CRM objects, customizable schema, locally inspectable state | Official documentation and current self-host setup should be validated hands-on before selection | Secondary local CRM practice system |
| Odoo Community/self-hosted | Local installation exposes business objects through external RPC/JSON interfaces | Broad CRM, inventory, service, accounting and custom-module world | Odoo Online external API access is restricted by plan; local protocols and setup are comparatively complex | Later ERP/operations transfer stress test |

## Logistics-specific candidates

| System | Free environment | Why it is useful | Important limitation | Recommended role |
| --- | --- | --- | --- | --- |
| ShipStation API / ShipEngine | Account includes a sandbox with test API keys, test carriers, rates, and test labels; sandbox access can continue without API usage charges | Real external shipping API, multiple carriers, simple server-side API-key authentication, structured failures, and safe label creation | Sandbox is limited to major US parcel carriers, 20 requests/minute, test rates, no simulated tracking events or webhooks; it tests a shipping aggregator rather than a customer's internal WMS/TMS | Best immediate external logistics practice environment |
| Shippo | Free account test mode supports API features and sample label creation without charge | A second real shipping API with a different authentication header and object model; test and live data are isolated | Test rates can differ; tracking numbers do not progress; batch labels and manifests are not supported in test mode | Potential transfer comparison, but not enough alone to prove heterogeneous enterprise-system support |
| EasyPost | Test API key supports functionality testing without label cost after signup | Mature REST shipping API with shipments, rates, labels, addresses and tracking objects | Current authentication setup requires an EasyPost Wallet and ship-from address; account setup and eligibility should be checked before use | Reserve comparison if Shippo or ShipStation is unsuitable |
| ERPNext Stock | Official local Docker setup plus warehouse, stock entry, sales order, purchase order and delivery-note records exposed through Frappe REST APIs | Real warehouse/procurement semantics, custom fields, roles, direct database verification, and no production data | Locally self-hosted and therefore not an independent SaaS sandbox | Best zero-cost warehouse/customer-system development environment |
| Shopify development store | Free isolated store with generated products, customers and test orders | Real order source that can feed fulfilment and dispatch workflows | Represents commerce rather than a warehouse or transport-management system; common connector | Useful only if commerce/logistics agents survive the GTM census |

## Time-limited or conditional candidates

| System | Availability | Why it is secondary |
| --- | --- | --- |
| Zendesk | Free 14-day trial; non-expiring sponsored account is intended for qualifying Marketplace developers | Useful support API, but the ordinary free window is short and sponsored access is conditional |
| Asana | Developer sandbox request can take up to a week and is intended for listed integrations or existing paid customers | Real work-management API, but provisioning and eligibility make it a poor immediate choice |

## Primary-source links

- HubSpot developer platform and test accounts:
  https://developers.hubspot.com/developer-platform-basics
  and https://developers.hubspot.com/docs/getting-started/account-types
- monday.com developer sandbox:
  https://developer.monday.com/api-reference/docs/developer-sandbox-account
- QuickBooks Online sandboxes:
  https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes
- Shopify development stores:
  https://shopify.dev/docs/api/development-stores/index
- Salesforce Developer Edition:
  https://developer.salesforce.com/blogs/2025/03/introducing-the-new-salesforce-developer-edition-now-with-agentforce-and-data-cloud
- Atlassian developer instances:
  https://developer.atlassian.com/platform/marketplace/getting-started/
- Intercom developers:
  https://developers.intercom.com/
- ServiceNow Developer Program and personal instances:
  https://developer.servicenow.com/
- Frappe REST API and Docker:
  https://docs.frappe.io/framework/user/en/guides/integration/rest_api
  and https://github.com/frappe/frappe_docker
- Cal.com API and local development:
  https://cal.com/docs/api-reference/v2/introduction
  and https://cal.com/docs/developing/local-development
- Twenty self-hosting:
  https://twenty.com/developers/section/self-hosting
- Odoo external API:
  https://www.odoo.com/documentation/19.0/developer/reference/external_api.html
- Zendesk development account:
  https://developer.zendesk.com/documentation/api-basics/getting-started/getting-a-trial-or-sponsored-account-for-development/
- Asana developer sandbox:
  https://developers.asana.com/docs/developer-sandbox
- ShipStation API / ShipEngine sandbox:
  https://www.shipengine.com/docs/sandbox/
- Shippo test mode:
  https://docs.goshippo.com/docs/Guides_general/testing
- EasyPost authentication and test keys:
  https://docs.easypost.com/docs/authentication
- ERPNext delivery and stock workflows:
  https://docs.frappe.io/erpnext/delivery-note
  and https://docs.frappe.io/erpnext/stock-entry

## Current recommendation

Do not create all of these accounts.

1. Use **Frappe/ERPNext locally** for zero-cost plumbing and development because
   it is a real business application, can be reset, and permits direct
   independent verification.
2. For the provisional logistics module, use **ShipStation API / ShipEngine
   sandbox** as the first external practice system. It offers test rates and
   labels without touching real shipments or incurring sandbox API charges.
3. Treat **Shippo** as a possible second shipping-API comparison, not as
   sufficient proof of broad customer-environment transfer.
4. After the census, use **one materially different system actually found in
   customer deployments**—such as a WMS, TMS, ERP, procurement system, or
   private customer API—in the frozen transfer evaluation.
5. If another beachhead wins, replace the logistics systems with a recognizable
   control and a materially different transfer system from that market.
6. Prefer platforms that appear in actual recent customer deployments found by
   the GTM research, rather than selecting impressive APIs in isolation.

The strongest market-specific pair cannot be chosen honestly until the
beachhead research identifies which systems recur and which unsupported system
work is genuinely painful.
