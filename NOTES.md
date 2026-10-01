# Notes

## Left out

- **Real email in and out.** Tickets arrive by API or seed file; "sent" is a status. A helpdesk integration would replace both ends.
- **Multi-turn threads.** One ticket, one reply. A customer's follow-up would be a new ticket with no memory of the first.
- **Attachments.** Loss and damage claims need photos under policy 7.1; the agent can only ask for them.
- **Auth and roles.** Anyone who can reach the console can approve a refund. There is no reviewer identity on a review.
- **Live valuation.** Card values are a fixed table. Declared-value disputes are answered against it as of a fixed date.
- **Policy versioning.** Each attempt stores the policy text it was given and the prompt version, but the policy document itself has no version, so there is no way to ask which tickets were answered under an older wording.
- **Lookup tools.** The model has no `get_card_value` or `get_policy` tool to fetch context the prefetch misses. The eval misses are triage and wording, not missing context, so every ticket is one model call.
- **Deployment.** Runs locally: the Bun server, the Ori runtime, SQLite.

## What breaks first

- **Policy drift.** The agent follows `fixtures/policy.md` exactly. When the team changes practice and the document does not change with it, the agent gives confident, well-cited, outdated answers, and nothing flags them.
- **Senders on a different email.** The account is found by sender email. A customer writing from a work address gets treated as having no account and is asked for their order number, which reads as unhelpful to someone who just gave it.
- **Wrong order ids.** A mistyped order id that belongs to another customer gets an `order_lookup` block with no details. The customer is told nothing about their real order, and the agent does not guess which one they meant.
- **Stale values.** The valuation table is a snapshot. Upcharge disputes on cards whose price moved are answered against old numbers.
- **Well-formed but wrong replies.** The guardrails check structure: priority, amounts, action types, that citations exist. A reply can cite `order CG-20083` and still state the wrong date from it, or add a timeline the policy never gives. The eval's faithful-replies metric measures this on the labeled set (71% faithful; examples in the [README](README.md#eval)) but nothing blocks such a reply at run time. The fix is a guardrail that matches timing phrases against the policy and holds the reply.
- **Chargeback and legal threats rely on the model.** Nothing in code escalates a ticket that mentions a chargeback, a lawyer, legal action or a bank dispute; the policy says to, and the shipped model does. A cheaper model in the bake-off did not ([README, Model choice](README.md#model-choice)). The fix is a deterministic guardrail for those words.
- **SQLite under concurrent writers.** Fine for one process and a handful of reviewers. Several processes, or a helpdesk webhook plus the console plus an eval run, will hit lock contention.
- **Keyword policy matching.** Policy sections are picked by keyword lists. A customer who describes a problem in words the lists do not have ("my slab came back with a chip in the plastic") may get no loss-and-damage section, and the agent will answer without it.

## One thing about Ori that got in the way

All observations are on Ori 0.15.5.

**API routes cannot call a model.** The ticket API is request and response: a ticket comes in, one decision goes out. An HTTP route's context (`ApiRouteContext`) carries `featureId`, `logger`, `mcp`, `params`, `remoteAddress`, `stores` and `use`, and nothing that starts a model turn; `spawnThread` exists only on `ToolCallContext`, inside a turn that is already running. Ori's chat guide says to treat a chat surface's `sendMessage()` as the only runtime invocation path. So `features/ticket-reply` registers a chat surface that nobody chats on, keeps the bridge Ori passes to its `start()` in module state, and calls `sendMessage()` on it from `POST /decide` and `POST /write`.

That path is the full agent loop, not a one-shot inference, and it costs. Every call carries Ori's agent prompt and tool definitions, and the prompt cache is written on every turn and never read (`cacheReadTokens: 0` on an identical second turn). A one-word "Say OK" turn uses 5,428 cache-write tokens plus 1,419 input tokens and costs $0.0072. Reasoning is on by default too: without `reasoning: { effort: "none" }` and `maxTurns: 1`, a ticket produced 2,562 output tokens, mostly reasoning, cost $0.022 and took 28 s. With both set, a ticket costs about $0.012 and a median 7.2 s through Ori. Most of that is input: about 10k tokens per Ori turn, the bulk of them Ori's fixed prompt and tool definitions. The eval runs both judges through Ori as well, so a full 100-ticket run costs about $3.50 to $4 including the judges, of which $1.22 is the agent.

Other friction:

- **`ori dev` does not run this agent.** The assignment says `ori dev` runs your agent, but `ori dev` never starts the feature's chat surface, run headless or in a real terminal: `GET /ticket-reply/health` returns `"bridge": false` and the routes answer 503. `ori start` logs "starting 2 chat surface(s)" and works, so `bun run up` and `bun run ori:start` both use `ori start`.
- **`ori init` will not adopt an existing project.** `ori help init`: "An existing directory that is not an Ori workspace is rejected." An existing repo becomes a workspace only by adding `ori.md`, the `ori` workspace dependency and `features/` by hand; `ori init .` then syncs it. It also rewrites `.gitignore` beyond the lines it needs, reordering existing entries.
- **The docs are hard to reach.** `ori init`, `ori dev` and `ori features` are not listed in `ori --help`. `AGENTS.md` points to `.ori/docs/llms.txt`, which exists only when a release ships a docs bundle, and 0.15.5 does not. The public docs do not cover `init`, `dev`, features, API routes or threads. The version-matched authoring guide (the `selfdev` skill) is written to disk only after the first `ori dev`, which needs an OpenRouter login, so how to build a feature cannot be read before signing in.
- **No JSON Schema structured output.** The changelog describes `promptFor` as asking a model for a value that matches a schema; `.ori/sdk/index.ts` has no `promptFor`. A chat turn's `output` takes Ori's own schema decoder, not JSON Schema, so the feature asks for JSON in the prompt and the app validates it.
- **The default model is the most expensive tier.** A fresh `ori.md` sets `model: ~anthropic/claude-opus-latest`, so any turn before the model is pinned runs on Opus. This repo pins `anthropic/claude-haiku-4.5` in `ori.md` and the backend sends the model on every call.
- **`ori init .` un-ignores the chat history.** `ori init .` rewrites `.gitignore` on every run and un-ignores `.ori/state.sqlite`, the intern's chat history, so `ori backup` (which runs `git add -A`) would publish it once it exists. The history holds every turn's prompts, local paths and timestamps, so this repo ignores all of `.ori/`; `bun run setup` restores that rule after it runs `ori init .`.
- **`ori backup` publishes everything.** `ori help backup`: it runs `git add -A`, commits and pushes, and says to check for secrets first. It is safe only if `.gitignore` already covers `.env` and anything else private.
- **Judges cannot be held to a short answer.** Ori's `/write` has no output cap, and reasoning effort `none` doesn't stop a model narrating its reasoning: through Ori, the Sonnet judge sometimes wrote its working before the verdict, so 7 of 100 judgements were unparseable (reported as not judged, not as failures).
- **A prompt runs inside an agent loop.** A system prompt that names a tool the runtime doesn't have makes the agent loop try to call it, and the turn fails (`tool call failed ... code=unknown_tool`). So the app's system prompt names no tool, and the Ori feature tells the model to answer as plain JSON and call no tools (prompt v3.1).
