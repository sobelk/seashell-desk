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
import os from 'os'
import { execSync } from 'child_process'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', '..', 'desk'))

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

// Text files: content embedded directly as a UTF-8 string in the tool result.
const TEXT_EXTS = new Set([
  '.txt', '.md', '.csv', '.json', '.yaml', '.yml',
  '.toml', '.xml', '.html', '.htm', '.log', '.conf', '.ini', '.env',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.sh', '.bash', '.zsh',
])

// Image files: delivered as an Anthropic image content block (base64).
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

// HEIC files are converted to JPEG on the fly via sips (macOS built-in)
// before being returned as an image block. The agent sees only JPEG.
const HEIC_EXTS = new Set(['.heic', '.heif'])

// Document files: delivered as an Anthropic document content block (base64).
const DOCUMENT_MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
}

type FileKind = 'text' | 'image' | 'document' | 'binary'

function classifyFile(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTS.has(ext)) return 'text'
  if (IMAGE_MEDIA_TYPES[ext]) return 'image'
  if (HEIC_EXTS.has(ext)) return 'image'
  if (DOCUMENT_MEDIA_TYPES[ext]) return 'document'
  return 'binary'
}

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
      'List the contents of a directory within desk/. Returns file names, types (file/directory), sizes, and for files: kind (text/image/document/binary) indicating how read_file will handle them. Path is relative to desk/ (e.g. "input/" or "projects/finance/files/").',
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
      'Read a file within desk/. Behavior depends on file kind (visible in list_directory): text files return UTF-8 content; image files (jpg/png/gif/webp) return an image attachment; document files (pdf) return a document attachment; binary files return an error. Path is relative to desk/.',
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
            const kind: FileKind | undefined = e.isFile() ? classifyFile(e.name) : undefined
            return {
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              ...(size !== undefined ? { size } : {}),
              ...(kind !== undefined ? { kind } : {}),
            }
          }),
        }
      }

      case 'read_file': {
        const { path: filePath, max_bytes = 65536 } = ReadFileInput.parse(input)
        const resolved = resolveDeskPath(filePath)
        const stat = statSync(resolved)
        if (!stat.isFile()) return { error: `Not a file: ${filePath}` }

        const kind = classifyFile(filePath)

        if (kind === 'image') {
          const ext = path.extname(filePath).toLowerCase()

          // HEIC/HEIF: convert to JPEG via sips (macOS built-in) before encoding
          if (HEIC_EXTS.has(ext)) {
            const tmpPath = path.join(os.tmpdir(), `desk-heic-${Date.now()}.jpg`)
            try {
              execSync(`sips -s format jpeg ${JSON.stringify(resolved)} --out ${JSON.stringify(tmpPath)}`, { stdio: 'ignore' })
              const data = readFileSync(tmpPath).toString('base64')
              return {
                _rawContent: [
                  { type: 'text', text: `File: ${filePath} (${stat.size} bytes, HEIC converted to JPEG)` },
                  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
                ],
              }
            } finally {
              if (existsSync(tmpPath)) unlinkSync(tmpPath)
            }
          }

          const mediaType = IMAGE_MEDIA_TYPES[ext]
          const data = readFileSync(resolved).toString('base64')
          return {
            _rawContent: [
              { type: 'text', text: `File: ${filePath} (${stat.size} bytes, ${mediaType})` },
              { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            ],
          }
        }

        if (kind === 'document') {
          const mediaType = DOCUMENT_MEDIA_TYPES[path.extname(filePath).toLowerCase()]
          const data = readFileSync(resolved).toString('base64')
          return {
            _rawContent: [
              { type: 'text', text: `File: ${filePath} (${stat.size} bytes, ${mediaType})` },
              { type: 'document', source: { type: 'base64', media_type: mediaType, data } },
            ],
          }
        }

        if (kind === 'binary') {
          return { error: `Binary file cannot be read: ${filePath} (${stat.size} bytes). Use copy_file to move it.` }
        }

        // text
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
