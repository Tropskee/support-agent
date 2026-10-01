# Decisions

## Company
A fictional Pokemon card grading service. Customers submit cards, get them graded, and write in about grades, orders, fees and shipping.
Why: the grading data we already have makes grade disputes answerable with evidence, and card values drive the fee and insurance tickets.

## Data
The card catalog is real (set, number, name). Grades, defect reports and values are synthetic: defect severities are sampled from the real distribution for each grade, and values are derived from real sales, then rounded and jittered.
Why: realistic, but safe to publish. No third-party scans, reports or prices are republished.

## Escalation
Escalate when any of these is true:
- The agent triages the ticket as P1.
- Its proposed actions move money over a threshold, or propose money without an amount.
- Its proposed action changes a grade or authenticity outcome.
- It reports low confidence.
- It cites evidence it was not given, or its output fails validation twice.

Every escalation states its reason.
Why: priority alone would let a P3 asking for a $400 refund go out unreviewed.

## Agent shape
The code prefetches the sender's account and the relevant policy sections, then makes one structured model call that returns priority, reply, actions, confidence and cited evidence.
Why: one call per ticket keeps it cheap, repeatable and auditable. Lookup tools (`get_card_value`, `get_policy`) were considered; eval misses were triage and wording, not missing context, so every ticket is one model call (see NOTES.md).

## Tickets
100 tickets: 5 P1, 10 P2, 20 P3, 30 P4, 35 P5. Built from about 20 scenario templates filled with fixture data. A model writes the customer prose once, kept short, and the result is committed as JSON. The code sets the labels (priority, escalate, expected action, required facts), not the model.

The set includes deliberately hard cases:
- A shouting P5.
- A polite P1.
- A prompt injection.
- A customer asking about someone else's order.
- A ticket from an email with no account.

Why: the tickets are both the demo and the eval set, so their labels have to be trustworthy.

## Stack
TypeScript on Bun, with SQLite for storage. The Bun server serves both the API and the frontend; model calls run on the Ori runtime. Ticket generation, the agent, the eval and the UI are all TypeScript.

The card list, card values and grade distributions come from my own card database. `scripts/extract_data.ts` pulls them into `data/` once, as read-only, SELECT-only queries. Only aggregates are committed: no individual sales or third-party reports.
Why: TypeScript because it is Ori's runtime, and one language runs end to end. The data lives in the repo, so it runs without access to my database.

## Console
One page with four tabs: Inbox, Resolved, Escalated, Eval. Every processed ticket shows its decision, the evidence it cited, the reply, and its cost, plus a trace of what the model saw. Escalated tickets can be approved, edited, or retried with added context. On a retry, the agent critiques its previous attempt before it drafts again.
Why: the support lead has to be able to see why the agent did what it did before they can trust it to act alone.
