# Backlog

Ideas and limitations encountered while building Seashell Desk.

## Known Design Tensions

- **Directory conventions are load-bearing but unenforced.** The system's behavior depends on agents placing files in the right locations. There's no schema or validator — a misplaced file is silently wrong. Worth considering a convention-checker tool as the project count grows.
- **`project` field on tasks must match a real directory.** `create_task` will create `desk/projects/{project}/tasks/` even if the project doesn't exist yet, silently creating a phantom project. Should validate against the actual directory listing.
- **Agents do their own work; triage orchestrates across projects.** Project agents are scoped to their own directory. Triage fans out to siblings. This is enforced by guidance only — there are no mechanical constraints yet.

## Limitations

- **No hard links.** File copies are independent — `desk/files/` and project copies diverge if either is edited.
- **PDF/image parsing.** Claude can read PDFs and describe images but cannot extract structured data reliably without additional tooling.
- **`ANTHROPIC_API_KEY` required at runtime.** All agent runners (`triage`, `watch`) call the Anthropic API directly.
- **Agents don't maintain JOURNAL.md or MEMORY.md yet.** The infrastructure supports it but no agent has been instructed to do so.

## Done

- [x] **Agent runner** — `src/runner.ts` drives an LLM in a tool-use loop. Supports mid-run injection of external events and per-tool callbacks for loop prevention.
- [x] **Filesystem tools** — `src/tools/filesystem.ts`: `list_directory`, `read_file`, `write_file`, `copy_file`, `delete_file`, `make_directory`. All scoped to `desk/`.
- [x] **Triage CLI** — `bun run triage` runs the input triage agent autonomously. Supports `--verbose`, `--dry-run`, `--silent`.
- [x] **Gmail sync CLI** — `bun run sync` fetches unprocessed inbox emails into `desk/input/`. Supports `--n`, `--after`, `--before`, `--label`, `--query`, `--all`, `--dry-run`.
- [x] **File watcher** — `bun run watch` monitors the entire `desk/` directory recursively. Finds the nearest `AGENT.md` to each change, debounces, and runs agents sequentially. Suppresses self-loops; allows cross-agent handoffs.
- [x] **Task update tool** — `update_task` changes task status or priority on the single canonical task file owned by an agent directory.
- [x] **Agent scoping guidance** — all AGENT.md files updated with explicit scope boundaries. Project agents stay in their own directory; triage orchestrates across siblings.
- [x] **`gmail_get_attachment` binary save** — `output_path` parameter saves decoded binary directly to disk. Fixes mangled PDFs from agents writing base64 via `write_file`.

## Next

- [ ] **Project agent CLI** — `bun run agent <project> [message]` invokes a project agent directly without going through triage. The runner supports it; needs a thin CLI wrapper.
- [ ] **JOURNAL.md support** — instruct each project agent to append a structured entry to its `JOURNAL.md` after acting on an input. Format TBD.
- [ ] **MEMORY.md support** — instruct project agents to update their `MEMORY.md` with top-of-mind facts. Triage should read it before routing to give the agent context.
- [ ] **Project validation in `create_task`** — validate `project` against `desk/projects/` at write time; return an error rather than silently creating a phantom directory.
- [ ] **Hard-link support** — a small Bun script that creates true hard links so `desk/files/` and project copies stay in sync.
- [ ] **TRIAGE_LOG → JSONL** — switch from Markdown table to JSONL for easier machine consumption.
- [ ] **`input/` convention for project agents** — triage now drops files into `desk/projects/{project}/input/` as a handoff. Project AGENT.md files need instructions for scanning and processing their own `input/` directory, analogous to what triage does for `desk/input/`.
