/**
 * Filesystem tools for agent use — scoped to the desk/ directory.
 *
 * All paths are interpreted as relative to desk/ (e.g. "input/foo.json") or
 * absolute paths that must fall within desk/. Paths escaping desk/ are rejected.
 *
 * Tools: list_directory, read_file, write_file, copy_file, delete_file, make_directory
 */

import { z } from 'zod'
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
  existsSync,
} from 'fs'
import path from 'path'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', '..', 'desk'))

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function resolveDeskPath(p: string): string {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(DESK_ROOT, p)
  if (!resolved.startsWith(DESK_ROOT + path.sep) && resolved !== DESK_ROOT) {
    throw new Error(`Path escapes desk/ directory: ${p}`)
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool_use format)
// ---------------------------------------------------------------------------

export const filesystemTools = [
  {
    name: 'list_directory',
    description:
      'List the contents of a directory within desk/. Returns file names, types (file/directory), and sizes. Path is relative to desk/ (e.g. "input/" or "projects/finance/files/").',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to desk/ (e.g. "input/", "projects/finance/files/bills/"). Defaults to desk/ root if omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a text file within desk/. Returns file contents as a string. For JSON files, returns the raw JSON text. Path is relative to desk/.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to desk/ (e.g. "input/19abc123.json").',
        },
        max_bytes: {
          type: 'number',
          description: 'Maximum bytes to read (default 65536 / 64KB). Use for large files.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write text content to a file within desk/. Creates the file and any necessary parent directories. Overwrites existing content. Path is relative to desk/.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to desk/ (e.g. "projects/finance/JOURNAL.md").',
        },
        content: {
          type: 'string',
          description: 'Text content to write.',
        },
        append: {
          type: 'boolean',
          description: 'If true, append to existing file instead of overwriting (default false).',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'copy_file',
    description:
      'Copy a file from one location to another within desk/. Creates destination directory if needed. Both paths are relative to desk/.',
    input_schema: {
      type: 'object' as const,
      properties: {
        src: {
          type: 'string',
          description: 'Source file path relative to desk/ (e.g. "input/19abc123.json").',
        },
        dst: {
          type: 'string',
          description: 'Destination file path relative to desk/ (e.g. "projects/finance/files/emails/19abc123.json").',
        },
      },
      required: ['src', 'dst'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a file within desk/. Use after a file in desk/input/ has been fully processed and copied to its canonical location(s). Path is relative to desk/.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to desk/ (e.g. "input/19abc123.json").',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'make_directory',
    description:
      'Create a directory (and any missing parent directories) within desk/. Path is relative to desk/.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to desk/ (e.g. "projects/healthcare/files/bills/2026-04-dr-smith/").',
        },
      },
      required: ['path'],
    },
  },
] as const

export type FilesystemToolName = (typeof filesystemTools)[number]['name']

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ListDirectoryInput = z.object({
  path: z.string().optional(),
})

const ReadFileInput = z.object({
  path: z.string().min(1),
  max_bytes: z.number().int().positive().optional(),
})

const WriteFileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  append: z.boolean().optional(),
})

const CopyFileInput = z.object({
  src: z.string().min(1),
  dst: z.string().min(1),
})

const DeleteFileInput = z.object({
  path: z.string().min(1),
})

const MakeDirectoryInput = z.object({
  path: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function runFilesystemTool(toolName: FilesystemToolName, input: unknown): Promise<unknown> {
  try {
    switch (toolName) {
      case 'list_directory': {
        const { path: dirPath } = ListDirectoryInput.parse(input)
        const resolved = resolveDeskPath(dirPath ?? '')
        const entries = readdirSync(resolved, { withFileTypes: true })
        return {
          path: dirPath ?? '.',
          entries: entries.map((e) => {
            const full = path.join(resolved, e.name)
            let size: number | undefined
            try {
              if (e.isFile()) size = statSync(full).size
            } catch { /* ignore */ }
            return {
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              ...(size !== undefined ? { size } : {}),
            }
          }),
        }
      }

      case 'read_file': {
        const { path: filePath, max_bytes = 65536 } = ReadFileInput.parse(input)
        const resolved = resolveDeskPath(filePath)
        const stat = statSync(resolved)
        if (!stat.isFile()) return { error: `Not a file: ${filePath}` }

        const buf = readFileSync(resolved)
        const truncated = buf.length > max_bytes
        const content = buf.slice(0, max_bytes).toString('utf8')
        return {
          path: filePath,
          size: stat.size,
          content,
          ...(truncated ? { truncated: true, read_bytes: max_bytes } : {}),
        }
      }

      case 'write_file': {
        const { path: filePath, content, append = false } = WriteFileInput.parse(input)
        const resolved = resolveDeskPath(filePath)
        mkdirSync(path.dirname(resolved), { recursive: true })
        if (append) {
          const existing = existsSync(resolved) ? readFileSync(resolved, 'utf8') : ''
          writeFileSync(resolved, existing + content)
        } else {
          writeFileSync(resolved, content)
        }
        return { path: filePath, bytes: Buffer.byteLength(content), append }
      }

      case 'copy_file': {
        const { src, dst } = CopyFileInput.parse(input)
        const srcResolved = resolveDeskPath(src)
        const dstResolved = resolveDeskPath(dst)
        if (!existsSync(srcResolved)) return { error: `Source not found: ${src}` }
        mkdirSync(path.dirname(dstResolved), { recursive: true })
        copyFileSync(srcResolved, dstResolved)
        return { src, dst }
      }

      case 'delete_file': {
        const { path: filePath } = DeleteFileInput.parse(input)
        const resolved = resolveDeskPath(filePath)
        if (!existsSync(resolved)) return { error: `File not found: ${filePath}` }
        unlinkSync(resolved)
        return { deleted: filePath }
      }

      case 'make_directory': {
        const { path: dirPath } = MakeDirectoryInput.parse(input)
        const resolved = resolveDeskPath(dirPath)
        mkdirSync(resolved, { recursive: true })
        return { created: dirPath }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}
