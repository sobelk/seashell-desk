# Seashell Desk

A set of tools and conventions for drowning less in the ocean of modernity.

## This is code, not a product

For your inspiration. I am unlearning how to build good software.

## File systems are a great idea

They provide mutual legibility to me, Desk, and other current and future AI frameworks like Claude Code — systems that live side-by-side on the same directory tree. File system events trigger agents. Agents have broad file system tools.

## Agents are directories

An agent is any directory containing an `AGENT.md`. Four more markdown files shape its context:

- `SYSTEM.md` — inherited down the tree. Broadcasts conventions to descendants.
- `AGENT.md` — not inherited. Defines this agent's role and boundaries.
- `SCOPE.md` — broadcast up the tree. Tells parents and siblings what this agent handles.
- `MEMORY.md` — loaded into context. The agent's persistent notes to itself.
- `JOURNAL.md` — append-only. A human-readable record of what happened.

## Let the AI give you tasks

Giving the AI a way to create tasks turns out to be a good way for it to ask me questions and prompt me to fill in missing information.

## Running it

```bash
cd src
cp .env.example .env && $EDITOR .env    # at minimum, set ANTHROPIC_API_KEY
bun install
bun run desk                            # web UI + file watcher at http://localhost:4312
```

Optional integrations — Gmail sync, Google Calendar, camera scanning — are documented in `.env.example`.
