# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Seashell Desk is an AI-driven personal assistant and file-keeping system. The file system is the **dominant metaphor** — its primary purpose is legibility for the user, not reliability for orchestration. Internal orchestration will use additional mechanisms (immutable event log, ACID-compliant database, sandboxing) as the system matures. The file system should stay in sync with internals but is not the source of truth.

The *primary purpose* of this system is to keep its user, Kieran, organized. He's a mess and he needs support. Please be kind and helpful, and forgive him his organizational lapses. Also, he is an experienced software developer.

Claude Code is the **central dispatcher** and primary agent orchestrator. The long-term goal is to reduce Claude Code's direct involvement by incrementally replacing it with in-house code.

## Tech Stack

- **Language**: TypeScript
- **Runtime & Package Manager**: Bun (always prefer Bun over npm/yarn/pnpm)
- **Infrastructure**: Local-first; AWS + Terraform when cloud is required

All source code and package management lives under `src/`. Run these commands from `src/`:

```bash
bun install          # install dependencies
bun run typecheck    # type-check without emitting
```

Environment variables required at runtime:
- `GMAIL_CLIENT_ID` — OAuth 2.0 client ID from Google Cloud Console
- `GMAIL_CLIENT_SECRET` — OAuth 2.0 client secret

OAuth tokens are stored in `.credentials/gmail-token.json` (gitignored) after first auth.

## Directory Conventions

The `desk/` directory is gitignored (user data). The layout has semantic meaning:

- `desk/input/` — Data to be processed. Writing a file here triggers an agent (debounced).
- `desk/files/` — Top-level canonical store for every file in the system, organized by file type (`emails/`, `pdfs/`, etc.). Always receives a copy of any filed document regardless of project routing.
- `desk/projects/{project}/files/` — The filing cabinet for a project: the primary place a user browses to find information. Holds both source documents and derived artifacts (journals, structured data, etc.). Internal organization is project-specific — defined by each project's `AGENT.md` in whatever taxonomy makes sense (e.g. finance organizes by institution → account; car-maintenance might organize by document type).
- `desk/projects/` — Active areas of attention (e.g. `car-maintenance/`, `finance/`).
- `AGENT.md` — Instructions for an agent scoped to its directory. Agents generally only access directories subordinate to their own `AGENT.md`.
- `MEMORY.md` — Top-of-mind facts for a project agent. Keep concise and pruned.
- `JOURNAL.md` — Human-readable (machine-secondary) event log for a project.

## Agent Architecture

Processing pipeline example:
1. An input connector (e.g. `desk/input/gmail.personal/`) polls and writes a file.
2. A watcher triggers the input-level agent (`desk/input/AGENT.md`), which routes to relevant project agents.
3. The input agent copies the file (hard link) into the appropriate `desk/projects/{project}/input/`.
4. The project `AGENT.md` runs, processes the file, updates journals/memory, may invoke calendar/email tools.
5. The original input file is deleted once handled.

Agents are scoped: a project agent should not access directories outside its own subtree.

## Source Code Layout

```
src/
  services/   # Wrappers for third-party services (AI clients, Gmail/GCal OAuth)
  tools/      # Core building blocks for Desk functionality
```
