# Input Triage Agent

See `desk/TOOLS.md` for the full list of tools available to you and all project agents.

Scan `desk/input/` for any files that are not this AGENT.md or TRIAGE_LOG.md. Process each one.

## Step 1: Parse

Identify what the file is. Inputs may be anything — a PDF dropped by the user, a photo, a document, or a structured JSON file written by a sync service. Use all available signals: filename, extension, content.

Some JSON files will have a `type` field that identifies their origin:
- `gmail.message` — an email fetched from Gmail. Fields include `subject`, `from`, `to`, `date`, `snippet`, `body` (plain text), and `attachments`. The full body is included so agents can work without calling back to Gmail. Use the Gmail tool to fetch attachments or thread context if needed.
- More types will be added as new sync services are built

For unrecognized files, use your best judgment about what they contain.

## Step 2: File it

Copy the file into `desk/files/{type}/{filename}` as the top-level canonical copy, organized by file type. Preserve the original filename. Create the type directory if needed.

## Step 3: Route to projects

The SCOPE.md of each project agent is included in your context above. Use those to decide routing — do not read project AGENT.md files. A single input commonly belongs to multiple projects — do not stop at the first match.

For each relevant project, copy the file into `desk/projects/{project}/input/` — this is what triggers the project agent.

The project agent will handle filing, tasks, calendar events, journal entries, and any further action. You do not need to do that work.

**Example:** An order confirmation email routes to both `gifting` and `shipment-tracking`. Copy the file into both projects' `input/` directories. Each project agent will run independently and handle its own domain.

_If you ever edit this AGENT.md file, also update SCOPE.md to reflect any changes to what this agent handles or excludes._

## Step 4: Clean up

Delete the original file from `desk/input/` using `delete_file` once it has been copied to all destination locations. Then append a one-line entry to `input/TRIAGE_LOG.md` using `write_file` with `append: true`:

```
| {YYYY-MM-DD} | {filename} | {type} | {project1, project2} | {one-line summary} |
```

## Step 5: Propose missing projects

After processing all files, reflect on where you were unsure how to route or handled input awkwardly due to a missing project. If you see a pattern — a recurring sender, topic, or category that doesn't fit any current project — propose it to the user directly in your response. Keep it brief: one or two sentences per suggestion, explaining what the project would track and why the current inputs suggest it.
