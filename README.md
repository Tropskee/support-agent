# Czeropski Grading support agent

A customer-support ticket agent for Czeropski Grading, a fictional Pokemon card grading company. It answers routine tickets on its own and holds risky ones for a person.

## What it does

For each ticket:

1. Looks up the sender's account by email, their orders, the order the ticket names (or their most recent open one), grade reports, card values and the matching policy sections.
2. Makes one structured model call that returns a priority (P1 to P5), a reply, proposed actions, a confidence score and the context blocks it cited.
3. Applies deterministic guardrails in code. If any rule fires, the ticket is escalated with its reasons and the reply is held as a draft; otherwise the ticket is resolved and the reply is marked sent.

The console at http://localhost:3000 has four tabs:

| Tab | Shows |
|---|---|
| Inbox | New tickets, with a per-ticket run button and "Run agent on all", which shows live progress (done, resolved, escalated) and a Stop button that lets in-flight tickets finish and starts no new ones. A ticket being run leaves its queue until the run finishes, then appears in Resolved or Escalated; it can't be run twice at once |
| Resolved | The decision, cited evidence, the sent reply, cost and latency, and a trace of what the model saw |
| Escalated | The escalation reasons, the held draft, and Approve & send, Edit draft, Try again |
| Eval | Scores against the 100 labeled tickets and past runs. Filter chips (All, Misses, Unfaithful, Escalation wrong, Priority wrong) narrow the results; clicking a row shows each check with its reason (expected vs. actual priority, why it was held or sent, missing facts, unsupported claims) next to the reply and the context the agent saw |

The trace shows the agent's own prompt and the context it was given; the Ori feature adds a short instruction to answer as JSON before sending.

The 100 seeded tickets are also the eval set: each carries a label for priority, whether it should escalate, the expected action and the facts the reply must contain.

## How it runs on Ori

The repo is an Ori workspace (`ori.md`, `features/`). The feature in `features/ticket-reply` registers a chat surface and three HTTP routes on the Ori runtime: `POST /decide` (the structured ticket decision), `POST /write` (plain text) and `GET /ticket-reply/health`. Each call runs as one Ori turn, single turn with reasoning off, on `anthropic/claude-haiku-4.5` through OpenRouter, pinned in `ori.md`. The Bun server and console call those routes through `oriBackend()` in `src/model.ts`; lookups, guardrails, storage and the console stay in the Bun app.

The eval's two judges run on Ori too, through the feature's `/write` route: the fact checker on `anthropic/claude-haiku-4.5` and the faithfulness judge on `anthropic/claude-sonnet-5`. Everything runs on an OpenRouter sign-in.

Design: [docs/spec.md](docs/spec.md). Reasoning behind each choice: [DECISIONS.md](DECISIONS.md). Guide for the support lead: [SETUP.md](SETUP.md).

## Run it

1. Install Bun: `curl -fsSL https://bun.sh/install | bash`
2. Install Ori and sign in to OpenRouter:
   ```bash
   curl -fsSL --proto '=https' https://openrouter.ai/labs/ori/install.sh | bash
   ori login
   ```
3. One-time setup, from the project folder:
   ```bash
   bun run setup
   ```
   This runs `ori init .`, restores the repo's `.gitignore`, installs dependencies and creates `.env` from `.env.example` if there is none. `.ori/` is not committed and `package.json` depends on the SDK at `.ori/sdk`, so `ori init .` has to run before `bun install`; it makes no model call. It also rewrites `.gitignore` to publish Ori's chat history, which is why setup restores the rule that keeps all of `.ori/` private.
4. Start everything:
   ```bash
   bun run up
   ```
   This starts the Ori runtime and the server together, waits until Ori is ready, and prints "Console ready: http://localhost:3000". Ctrl-C stops both.
5. Open http://localhost:3000.

On first start the server creates `support.db` and seeds the 100 tickets into the Inbox. Delete `support.db` (and `support.db-wal`, `support.db-shm`, if present) to start over.

If the Ori runtime is not running, Run (and "Run agent on all", and `?run=true`) returns an error, "Model runtime unavailable: start it with `bun run up`". Run leaves the ticket in the Inbox and Try again leaves it in Escalated; nothing is lost. Start the runtime and run them again.

### Engineers: two terminals

To run the two processes separately, each with its own log:

1. Terminal 1, the Ori runtime on port 4717 (`ORI_URL`):
   ```bash
   bun run ori:start
   ```
   This runs `ori start --no-install --port 4717`. Use `ori start`, not `ori dev`: `ori dev` does not start the feature's chat surface, whether run headless or in a terminal, so `GET /ticket-reply/health` reports `"bridge": false` and the routes answer 503. Under `ori start`, `curl http://127.0.0.1:4717/ticket-reply/health` shows `"bridge": true` once it is ready.
2. Terminal 2, the server:
   ```bash
   bun run start
   ```

## Send a ticket

```bash
curl -s -X POST 'http://localhost:3000/tickets?run=true' -H 'content-type: application/json' -d '{"from":"alex.smith@example.com","subject":"Where is my order?","body":"Hi, any update on my submission? Thanks"}'
```

Without `?run=true` the ticket is only queued in the Inbox. With it, the response carries the ticket and the agent's attempt. A real response, trimmed to the relevant fields (the full attempt also carries the prompt, the context blocks and the raw model output):

```json
{
  "ticket": {
    "id": "TKT-101",
    "sender_email": "alex.smith@example.com",
    "subject": "Where is my order?",
    "status": "resolved",
    "current_attempt_id": 1
  },
  "attempt": {
    "model": "anthropic/claude-haiku-4.5",
    "prompt_version": "v3.1",
    "priority": "P4",
    "confidence": 0.98,
    "reply_text": "Your order CG-20083 shipped on 2026-09-18 and is on its way. You can track it with USPS using tracking number 4306511427576727453754. It is insured and promised to arrive by 2026-10-09.\n\nCzeropski Grading Support",
    "proposed_actions_json": "[{\"type\":\"info_only\",\"amount_usd\":null,\"detail\":\"Customer provided with current order status and tracking information\"}]",
    "citations_json": "[\"order CG-20083\"]",
    "guardrail_result": "resolve",
    "guardrail_reasons_json": "[]",
    "input_tokens": 9967,
    "output_tokens": 487,
    "cost_usd": 0.011509,
    "latency_ms": 6589,
    "error": null
  }
}
```

That ticket cost $0.0115 and took 6.6 s, in line with the eval's $0.012 per ticket and median 7.2 s. About 10k input tokens go into each Ori turn, most of them Ori's fixed agent prompt and tool definitions ([NOTES.md](NOTES.md) has the breakdown).

An escalated ticket has `"status": "escalated"`, `"guardrail_result": "escalate"`, and one entry per reason in `guardrail_reasons_json`, for example `[{"reason":"p1","detail":"Triaged P1"}]`.

Other routes (listing, approve, retry, run-all, eval) are in the API table in [docs/spec.md](docs/spec.md#api).

## Eval

```bash
bun run eval
```

or press Run eval on the Eval tab, which asks for confirmation first: a run takes about 5 minutes and costs about $4. Each eval run puts every labeled ticket through the agent in its own `<EVAL_DB_PATH stem>-<run id>.db` (for example `eval-7.db`), so it never touches the console's queues; the results are copied into `support.db` for the Eval tab and the run's file is removed when the run finishes. The Ori runtime has to be running: the agent and both judges use it.

| Metric | Meaning |
|---|---|
| Priority exact | Agent's priority equals the label |
| Priority within one | Off by at most one level |
| Escalate accuracy | Escalate or resolve matches the label |
| P1 recall | Share of P1 tickets that were escalated |
| Action match | A proposed action has the expected type (refund, regrade_request, carrier_claim, ...) |
| Facts found | Share of required facts present in the reply (regex where possible, otherwise a yes/no judge call) |
| Citation validity | Every citation names a block that was in the prompt |
| Faithful replies | Share of replies with no claim the ticket and context blocks do not support, as judged by a separate, stronger model that sees what the agent saw and answers in one line |
| Cost, latency | Total spend for the run; median latency per ticket |

Results on the 100 labeled tickets. The headline is the shipped configuration, run entirely on Ori: prompt v3.1, reasoning off, the agent on `anthropic/claude-haiku-4.5`, the fact checker on `anthropic/claude-haiku-4.5` and the faithfulness judge on `anthropic/claude-sonnet-5`, both judges through the Ori feature's `/write` route. The v1–v3 rows are prompt iterations on the same model, measured outside Ori, so their cost and latency columns do not compare with the Ori row.

| Prompt | Priority exact | Within one | Escalate | P1 recall | Action | Facts | Citations | Faithful | Cost / 100 | Median latency |
|---|---|---|---|---|---|---|---|---|---|---|
| v1 | 85% | 95% | 97% | 5/5 | 84% | 91.8% | 97% | n/a | $0.45 | 4.9 s |
| v2 | 90% | 98% | 100% | 5/5 | 88% | 96.7% | 99% | n/a | $0.49 | 4.5 s |
| v3 | 91% | 98% | 98% | 5/5 | 94% | 98.4% | 100% | 62% | $0.52 | 4.7 s |
| **v3.1 on Ori (shipped)** | **86%** | **97%** | **97%** | **5/5** | **91%** | **96.7%** | **100%** | **71%** | **$1.22** | **7.2 s** |

Faithfulness was not measured for v1 and v2. v3 had all 100 replies judged; the shipped run had 93 of 100 judged, because the judge's other 7 answers could not be parsed (see [NOTES.md](NOTES.md)), and those are reported as not judged rather than as failures. Cost is the agent's calls only; with both judges a full shipped run costs about $3.50 to $4. The shipped run took 4 min 43 s at 4 tickets in parallel. Each of these is a single run, so differences of a few points between rows are within run-to-run noise rather than a reliable trend.

- v1: the baseline rubric and rules.
- v2: triage rubric based on what the customer asks for, not tone; every reply states status, promised dates, amounts, deadlines.
- v3: citation labels kept out of reply text (also stripped in code), sign-off required, no facts beyond the context blocks, mismatches named.
- v3.1 on Ori (shipped): v3 with no tool named in the system prompt, since an Ori turn has none.

All three escalation errors on the shipped run were over-escalations, tickets held that could have gone out: a packing question triaged P1, a status question on an order 57 business days late where the agent proposed the $450 refund the late-order policy allows (over the refund limit), and one low-confidence reply. No ticket that needed a person went out on its own.

What is left:

- **Faithfulness is the main metric to watch.** 71% of the judged replies on the shipped run had no unsupported claim. The flags are mostly genuine embellishment: invented timings (a refund "within a few business days", a reset email "within an hour"), the agent's own reading of what centering numbers mean, and suggesting a UPS redirect the policy never mentions. A few are strict, such as a 5-day photo deadline the agent correctly computed from policy into a calendar date. Next is a v4 prompt aimed at these patterns, and moving the "no invented timelines" rule into a code check where it can be caught by pattern rather than by instruction.
- **Borderline P4s.** Priority misses are mostly P4 questions about a customer's own order (centering numbers, order status), off by one level.
- **Loss reports.** Replies on "delivered but never arrived" tickets have occasionally omitted a required fact.

The full list of misses for any run is on the Eval tab under the Misses filter.

## Model choice

The model was measured, not defaulted, using Ori's own eval tooling (`ori eval`), in two stages.

**Bake-off (shortlist).** `evals/ticket-reply/model-bakeoff.eval.ts` runs 12 labeled tickets, covering every priority and the hard cases, through each candidate on the same runtime and prompt. Candidates come from Ori's live OpenRouter catalog via `rankedModels()`, filtered on price and on accepting reasoning effort `"none"` (the production setting), one per vendor, as Ori's eval guide recommends; that filter excluded the Google and DeepSeek models. The incumbent `anthropic/claude-haiku-4.5` and `openrouter/auto` are pinned in and asserted live. Scoring is deterministic and uses the same checks as the main eval: valid JSON, priority, hold-or-send through the guardrails, and required facts.

```bash
bun run bakeoff:pilot   # one ticket per model, to estimate cost
bun run bakeoff         # full run; writes docs/model-bakeoff.md
```

The pilot (7 models x 1 ticket) cost $0.03 and estimated $0.39 for the full run. The full run was 84 runs in 87 s for $0.25. Ori's generated report is [docs/model-bakeoff.md](docs/model-bakeoff.md); its Correctness column counts completed runs, so the app's scores are below.

| Model | Valid JSON | Priority | Hold/send | Facts | Cost (12) | Latency* |
|---|---|---|---|---|---|---|
| anthropic/claude-haiku-4.5 | 12/12 | 11/12 | 12/12 | 15/15 | $0.147 | 7.1 s |
| minimax/minimax-m3 | 12/12 | 11/12 | 12/12 | 15/15 | $0.015 | 9.2 s |
| openai/gpt-5.6-luna | 12/12 | 11/12 | 12/12 | 14/15 | $0.009 | 3.7 s |
| xiaomi/mimo-v2.6-flash | 12/12 | 11/12 | 10/12 | 15/15 | $0.007 | 5.1 s |
| openrouter/auto | 12/12 | 10/12 | 12/12 | 10/15 | $0.022 | 4.5 s |
| upstage/solar-pro4 | 11/12 | 11/12 | 11/12 | 13/15 | $0.010 | 10.8 s |
| tencent/hy4-preview | 11/12 | 9/12 | 11/12 | 13/15 | $0.041 | 16.1 s |

\*Latency from a concurrent sweep is indicative only, as Ori's guide notes.

**Full eval (decision).** MiniMax M3, the leading cheaper candidate, ran the full 100-ticket eval on the same runtime, prompt (v3.1) and judges as the shipped configuration. This comparison is its own pair of runs, so the Haiku column differs from the headline table by up to five points; single runs vary by that much.

| Metric | Haiku 4.5 (shipped) | MiniMax M3 |
|---|---|---|
| Priority exact | 87% | 91% |
| Within one | 98% | 98% |
| Escalation decision | 99% | 96% |
| P1 held for a person | 5/5 | 4/5 |
| Action | 86% | 86% |
| Required facts | 98.4% | 97.5% |
| Faithful replies | 75% | 68% |
| Agent cost / 100 | $1.12 | $0.11 |
| Median latency | 7.7 s | 5.7 s |

MiniMax triaged the chargeback-threat ticket as a P2 duplicate charge and proposed the $50 refund. That is under the refund limit, so it resolved without review, although policy says chargeback and legal threats go to a person. It also escalated two tickets unnecessarily.

**Decision: keep `anthropic/claude-haiku-4.5`.** A model ten times cheaper that sends a chargeback threat out unreviewed fails the property that matters most. A 12-ticket bake-off is a shortlist, not a decision: only the full labeled set exposed the safety miss. Next is a deterministic guardrail that always escalates tickets mentioning a chargeback, a lawyer, legal action or a bank dispute, so this class of miss does not depend on the model. With that in place, MiniMax M3 is worth re-measuring as the cost option.

To switch models, set `ORI_MODEL` (no code change) and rerun `bun run eval`.

## Tests

```bash
bun test
```

Tests use a fake model backend and make no model calls. The test preload points `ORI_URL` at an unused local port (`http://127.0.0.1:9`), so a call that reaches the real Ori backend by mistake fails at once instead of reaching a running runtime.

## Configuration

Set in `.env` or the environment.

| Variable | Default | Meaning |
|---|---|---|
| `ORI_URL` | `http://127.0.0.1:4717` | The running Ori runtime; `bun run up` binds this port (`bun run ori:start` always uses 4717) |
| `ORI_MODEL` | `anthropic/claude-haiku-4.5` | OpenRouter model id for ticket decisions and replies |
| `ORI_TIMEOUT_MS` | `90000` | How long `oriBackend()` waits for one Ori turn before giving up; the ticket escalates as an error on timeout. If the runtime cannot be reached at all, the run returns an error and the ticket stays in the Inbox |
| `JUDGE_MODEL` | `anthropic/claude-haiku-4.5` | OpenRouter model id for the eval's yes/no fact checks |
| `FAITH_JUDGE_MODEL` | `anthropic/claude-sonnet-5` | OpenRouter model id for the eval's stronger faithfulness judge |
| `REFUND_LIMIT_USD` | `100` | Escalates any reply whose proposed actions add up to more than the refund limit, or that proposes a refund, credit or claim without an amount |
| `CONFIDENCE_FLOOR` | `0.7` | Decisions below this confidence escalate |
| `RUN_CONCURRENCY` | `4` | Tickets run in parallel by "Run agent on all" and the eval |
| `PORT` | `3000` | Server port |
| `DB_PATH` | `support.db` | SQLite database for the console |
| `EVAL_DB_PATH` | `eval.db` next to `DB_PATH` | Names each eval run's own `<stem>-<run id>.db`, removed when the run finishes; results are copied into `support.db` |

Numeric settings (`ORI_TIMEOUT_MS`, `REFUND_LIMIT_USD`, `CONFIDENCE_FLOOR`, `RUN_CONCURRENCY`, `PORT`) are validated at startup; a bad value stops the server with a message saying which one and why.

Every model call goes through one interface in `src/model.ts` (`decide` for the structured decision, `write` for plain text), so the model can be swapped without touching the agent.

## Data

| What | Source |
|---|---|
| Card list (about 150 cards: set, number, name, rarity, year) | Real, from my own card database |
| Card values per card and grade | Aggregated from real sold prices: `data/card_values.csv` holds the 25th percentile, median and 75th percentile per card and grade; `fixtures/values.json` takes the median from it and applies rounding and a few percent of jitter |
| Grade-condition distributions (corner and edge scores per grade) | Aggregated from real graded-card data, as quantiles per grade |
| Customers, orders, grade reports | Synthetic, generated from the above with a fixed seed |
| Tickets | Synthetic. A model wrote each customer message once from a scenario template and the order facts; code set every label |
| Policy | Written by hand, `fixtures/policy.md` |

Nothing from a third party is republished: no individual sales, listings, scans or grading reports. `scripts/extract_data.ts` did a one-time, read-only extract into `data/` and is not needed to run the project. `bun run accounts` and `bun run tickets` rebuild the fixtures; neither is needed to run it.

## Why Pokemon

I keep my own database of graded Pokemon card data. That lets the tickets rest on real cards, real grade distributions and real prices, so a grade dispute or a declared-value upcharge has plausible evidence behind it instead of invented numbers.

## Assumptions about the customer

### Who the customer is

We built this for Czeropski Grading, a fictional Pokemon card grading company. Its support team, led by the support lead, is the customer: they run the agent and own it. The people writing in are Czeropski's own customers, collectors who send cards in for grading.

### About Czeropski Grading (the customer)

- Written policies are the source of truth. The agent answers from `fixtures/policy.md` and nothing else.
- A person must see anything that moves money over a set limit or touches a grade or authenticity, and every P1.
- Card values come from an internal valuation table, not a live market feed.
- Replies go out through the team's existing helpdesk, so "sent" here is a ticket status; no email leaves the system.

### About the people writing in

- Tickets are email-shaped (from, subject, body) and come from the email on the collector's account. That email is how the agent finds the account.
- They write in English.
