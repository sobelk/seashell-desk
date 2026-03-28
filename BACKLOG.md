# Backlog

Ideas and limitations encountered while building Seashell Desk.

## Limitations

- **Manual trigger**: Claude Code only processes `desk/input/` when explicitly asked. No watcher yet.
- **No hard links via Claude Code**: Claude Code uses file copies rather than true hard links, so `desk/files/` and project input copies are independent. A sync step would be needed if files are edited.
- **PDF/image parsing**: Claude Code can read PDFs and describe images but cannot extract structured data reliably without additional tooling.

## Ideas / Next Steps

- [ ] File watcher script (`src/tools/watch-input.ts`) using Bun's file system API — polls or uses `fs.watch` to detect new files in `desk/input/` and triggers triage
- [ ] Triage script (`src/tools/triage.ts`) that wraps the AGENT.md logic in code, reducing reliance on Claude Code for routing
- [ ] Hard-link support — requires a small Bun script since Claude Code can't create true hard links
- [ ] TRIAGE_LOG.md → structured format (CSV or JSONL) for machine consumption later
