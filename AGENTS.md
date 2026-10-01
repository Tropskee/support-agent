# Agent Guide

This is an Ori workspace: a declarative agent (your intern) that you build by adding features under
`features/`. Keep this file short. The authoritative, version-matched guidance lives in the docs below, not
here, so read them rather than relying on what you remember about Ori.

For what this app is and how the rest of the repo fits together (the ticket agent, the eval, the
console), see `README.md`.

## Read these first

- `ori <command> --help` is authoritative for every command, its flags, and its output.
- If `.ori/docs/llms.txt` exists it indexes the framework docs mirrored for your installed Ori version.
  It is only present when that release shipped a docs bundle, so check before relying on it.
- After you run `ori dev` or `ori start`, Ori materializes its built-in `selfdev` skill into
  `.claude/skills/selfdev/` and `.agents/skills/selfdev/` (the authoring contract and
  validation workflow). Read it before adding or changing a feature.
- `ori dev` does not start chat surfaces (the `chat` contribution never runs, so `Chat.sendMessage`
  routes answer 503). Use `ori start` for anything that calls into a feature's chat bridge, such as
  this app's `ticket-reply` feature; see `bun run ori:start` in the repo root's `package.json`.

## Guardrails

When creating or updating Ori features, skills, prompts, harnesses, routes, or other feature contributions:

- Write them only under the active feature root.
- Use root skills at `<active-feature-root>/<feature-id>/SKILL.md`.
- Use nested skills at `<active-feature-root>/<feature-id>/skills/<skill-name>/SKILL.md` when a feature owns several related skills.
- Do not create project skills in `.agents/skills`, `.codex/skills`, a repository-level `skills/` directory, or anywhere outside the active feature root unless the user explicitly asks.
- If the owning feature is unclear, ask before creating files.
- For contribution shapes and authoring details, use the `selfdev` skill.
- `.agents/skills` and `.claude/skills` are generated snapshot views of the active feature root; never edit them. Edits under the active feature root take effect on your next run, not mid-run.

## Commands

Fresh clone: install the Ori CLI, then `ori login`, then `ori init .` (syncs `.ori/sdk`, which
`package.json`'s `ori` dependency points at), then `bun install`. `bun install` alone fails on a
clean checkout: `.ori/` is gitignored, so the workspace dependency it resolves to doesn't exist
yet.

- `ori init .` - sync the Ori SDK cache (`.ori/sdk`) this workspace depends on.
- `bun install` - install dependencies, once `.ori/sdk` exists.
- `ori start` - run the intern locally with chat surfaces live (hot reload included). Use this,
  not `ori dev`, for anything that exercises a feature's chat bridge.
- `ori dev` - run the intern locally with hot reload, chat surfaces excluded.
- `ori features new <name>` / `ori features validate` - scaffold and check a feature.
- `ori logs` - read runtime logs, including why a schedule or run failed.
