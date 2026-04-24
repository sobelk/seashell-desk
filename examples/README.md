# Example desk/

A sample of what a running Seashell Desk looks like. Copy this as a starting point:

```bash
cp -R examples/desk/* desk/
```

Then drop files into `desk/input/` and run `bun run desk` from `src/`.

## What's here

- **`desk/SYSTEM.md`** — inherited by every agent. Defines the conventions.
- **`desk/TOOLS.md`** — reference for the tools every agent can call.
- **`desk/input/AGENT.md`** — the triage agent. Fans incoming files out to projects.
- **`desk/projects/{finance, healthcare, shipment-tracking, socializing}/`** — four project agents, each with:
  - `AGENT.md` — role, responsibilities, filing structure
  - `SCOPE.md` — one-paragraph description of what this agent handles (broadcast to siblings)
- **`desk/projects/finance/MEMORY.md`** — example of a project's running cheat-sheet
- **`desk/projects/finance/JOURNAL.md`** — example of the append-only event log
- **`desk/projects/finance/tasks/`** — one example task to illustrate the format

`MEMORY.md`, `JOURNAL.md`, and the task are mocked with fake data. The `AGENT.md` and `SCOPE.md` files are real.
