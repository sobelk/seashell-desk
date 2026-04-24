# Agent Tools

Tools available to any agent operating within Seashell Desk. When invoking these as an LLM agent, use the tool name and input schema described below.

---

## Filesystem

All paths are relative to `desk/` (e.g. `"input/foo.json"`, `"projects/finance/files/att/"`). Paths that escape `desk/` are rejected.

| Tool | Description |
|------|-------------|
| `list_directory` | List files and subdirectories at a path. Returns name, type, size. |
| `read_file` | Read a text file. Returns content string + size. Optional `max_bytes` (default 64KB). |
| `write_file` | Write (or append) text to a file. Creates parent directories automatically. |
| `copy_file` | Copy a file from `src` to `dst`. Creates destination directories automatically. |
| `delete_file` | Delete a file. Use after a file in `input/` has been fully processed. |
| `make_directory` | Create a directory (and any missing parents). |

---

## Tasks

### `create_task`

Create an actionable task for Kieran. Writes a single markdown file into the owning agent directory's `tasks/` folder.

**When to use:** Any time you identify something Kieran needs to do, decide, or follow up on.

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Action-oriented, starts with a verb. E.g. "Pay AT&T balance of $96.30" |
| `owner_path` | yes | Path to the owning agent directory relative to `desk/`, e.g. `projects/finance` or `input` |
| `priority` | yes | `critical` (today) · `high` (this week) · `medium` (this month) · `low` (whenever) |
| `due` | no | YYYY-MM-DD |
| `notes` | no | Context, next steps, relevant links |

### `update_task`

Update structured task fields on an existing task. Use this for status and priority changes only.

| Field | Required | Description |
|-------|----------|-------------|
| `path` | yes | Task markdown path relative to `desk/`, e.g. `projects/finance/tasks/pay-att-balance-2026-03-28.md` |
| `status` | no | `open` · `done` · `ignored` |
| `priority` | no | `critical` · `high` · `medium` · `low` |

For title changes, notes edits, or other body/frontmatter changes beyond status/priority, use `read_file` + `write_file` directly on the task markdown file.

---

## Gmail

| Tool | Description |
|------|-------------|
| `gmail_search` | Search messages by Gmail query syntax |
| `gmail_read` | Fetch a single message by ID |
| `gmail_get_attachment` | Download an attachment. Pass `output_path` (relative to `desk/`) to save as binary to disk — **always use this for PDFs and images**. Without `output_path`, returns raw base64. |
| `gmail_list_labels` | List all labels |
| `gmail_archive` | Archive a message (remove from inbox) |
| `gmail_modify_labels` | Add or remove labels |
| `gmail_process_inbox` | Fetch N unprocessed inbox emails, write to desk/input/, apply 🐚 desk label |

---

## Google Calendar

| Tool | Description |
|------|-------------|
| `gcal_list_calendars` | List accessible calendars (call first to find calendar IDs) |
| `gcal_list_events` | List events in a time range, optionally filtered by query |
| `gcal_get_event` | Fetch a single event by ID |
| `gcal_create_event` | Create a new event |
| `gcal_update_event` | Update fields on an existing event |
| `gcal_delete_event` | Delete an event |
