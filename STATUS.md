# Support agent: Friday update

## What you can do

- Open the console and see every ticket in one of three queues: Inbox, Resolved, Escalated.
- Let the agent answer routine tickets on its own: order status, turnaround by tier, packing, label typos, general questions.
- See why every answer was given: the priority, the account and policy sections it relied on, and the reply.
- Review anything risky before it goes out. Every P1, anything over the refund limit, anything touching a grade or authenticity, and anything the agent is unsure of lands in Escalated with the reason on top.
- Approve a draft, edit it, or send it back with notes and get a new draft.
- Run the whole Inbox at once and watch the count of done, resolved and escalated tickets climb, with a Stop button if you need it.
- Replies run on OpenRouter's Ori runtime, using Claude Haiku 4.5.

## How it scores

We test it on 100 practice tickets where we already know the right answer. These are the numbers for the shipped version, with the whole test run on Ori, including the second model that checks the replies.

- **P1s:** all 5 went to a person. None went out on their own.
- **Answer or hold for review:** right on 97 of 100. All three misses were held when they could have gone out: a packing question marked P1, a status question on a very late order where the agent proposed the $450 refund the policy allows, and one reply the agent was unsure of. No ticket that needed a person went out on its own.
- **Priority:** right on 86 of 100, and within one level on 97.
- **Proposed action** (refund, regrade, claim and so on): right on 91 of 100.
- **Replies:** included the facts they needed 97% of the time, and every piece of evidence they pointed to was real.
- **Replies that say nothing beyond the account and policy:** 71%. A second, stronger model reads each reply against what the agent was given and flags anything unsupported. It gave a usable answer on 93 of the 100 replies; the other 7 are counted as not checked.
- **Cost:** about 1.2 cents per ticket, and a reply takes about 7 seconds. A full test run of 100 tickets takes about 5 minutes and costs about $3.50 to $4, of which $1.22 is the agent itself and the rest is the checking models.
- **Why this model:** the best cheaper model we tried cost a tenth as much but let a chargeback threat go out without review, so we kept this one.

Where it is weak:

- **It embellishes.** Close to 3 in 10 checked replies add something the policy does not say, such as a refund "within a few business days"; none of these move money or change a grade, but a customer could be told a timeline we never promised.
- Questions about a customer's own order, like what their centering numbers mean or where their order is, sometimes get the wrong priority.
- It can only use what is in the account and the policy document. If the policy is out of date, its answers will be too.

## What we need from you

- **Review the Escalated queue.** Approve, edit or send back. Your notes on "Try again" tell it what to fix on that ticket.
- **Flag bad replies** in Resolved: the ticket number and what was wrong.
- **Confirm the refund limit.** It holds anything over 100 dollars. Is that the right line?
- **Confirm the policy document** is what we actually do, especially regrades, late-order refunds and loss claims.

## What's next

- Cut the embellishment: a fourth version of the instructions aimed at invented timelines and self-made explanations, and a check in code that holds any reply promising a timeline the policy does not state.
- Tighten the replies on loss and damage tickets.
- Connect to the helpdesk, so tickets come in and replies go out without copying.
