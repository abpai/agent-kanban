import { writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { ErrorCode, KanbanError } from '../errors'
import { success } from '../output'
import { unsupportedOperation } from '../providers/errors'
import type { KanbanProvider } from '../providers/types'
import type { CliOutput, ProviderCapabilities, TaskAttachment } from '../types'
import { readTaskAttachment } from '../use-cases'

/** Bytes are held in memory whole before they are written, so the CLI caps them by default. */
const DEFAULT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024

/** `-o -` streams the bytes to stdout; the envelope then goes to stderr with this path. */
const STDOUT_PATH = '-'

export interface AttachmentGetResult {
  attachment: TaskAttachment
  /** Absolute path the bytes were written to, or `-` for stdout. */
  path: string
}

function requireAttachments(provider: KanbanProvider, capabilities: ProviderCapabilities): void {
  if (!capabilities.attachments) {
    unsupportedOperation(`Task attachments are not supported by the ${provider.type} provider`)
  }
}

/**
 * The provider's filename is remote input. Only its last path segment is used,
 * a dotfile name is refused so a download cannot plant config such as `.npmrc`
 * or `.envrc` in the working directory, and control characters are refused so
 * the name cannot rewrite the terminal when it is printed.
 */
function defaultFilename(filename: string): string {
  const name = basename(filename.replaceAll('\\', '/'))
  if (!name || name.startsWith('.') || hasControlCharacter(name)) {
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `Attachment filename ${JSON.stringify(filename)} is not safe to write as-is; pass -o <path>`,
    )
  }
  return name
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function writeAttachment(path: string, bytes: Uint8Array, overwrite: boolean): void {
  try {
    writeFileSync(path, bytes, { flag: overwrite ? 'w' : 'wx' })
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new KanbanError(
        ErrorCode.CONFLICT,
        `File '${path}' already exists; pass -o <path> to choose where to write`,
      )
    }
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `Cannot write attachment to '${path}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function attachmentList(
  provider: KanbanProvider,
  capabilities: ProviderCapabilities,
  args: { id?: string },
): Promise<CliOutput> {
  if (!args.id) throw new KanbanError(ErrorCode.MISSING_ARGUMENT, 'Task ID is required')
  requireAttachments(provider, capabilities)
  return success(await provider.listAttachments(args.id))
}

/**
 * Writes one attachment to a file, never to stdout unless `output` is `-`.
 * Without `output` it writes the provider filename into `cwd` and refuses to
 * replace an existing file; an explicit path is the caller's choice and is
 * overwritten.
 */
export async function attachmentGet(
  provider: KanbanProvider,
  capabilities: ProviderCapabilities,
  args: { id?: string; nameOrId?: string; output?: string; maxBytes?: number; cwd?: string },
): Promise<{ output: CliOutput<AttachmentGetResult>; stdout?: Uint8Array }> {
  if (!args.id || !args.nameOrId) {
    throw new KanbanError(
      ErrorCode.MISSING_ARGUMENT,
      'Usage: kanban task attachment get <id> <name-or-attachment-id> [-o <path>]',
    )
  }
  if (args.output === '') {
    throw new KanbanError(ErrorCode.INVALID_ARGUMENT, '-o requires a path, or - for stdout')
  }
  requireAttachments(provider, capabilities)
  const { attachment, bytes } = await readTaskAttachment(provider, {
    idOrRef: args.id,
    nameOrId: args.nameOrId,
    maxBytes: args.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
  })
  if (args.output === STDOUT_PATH) {
    return { output: success({ attachment, path: STDOUT_PATH }), stdout: bytes }
  }
  const cwd = args.cwd ?? process.cwd()
  const path = resolve(cwd, args.output ?? defaultFilename(attachment.filename))
  writeAttachment(path, bytes, args.output !== undefined)
  return { output: success({ attachment, path }) }
}
