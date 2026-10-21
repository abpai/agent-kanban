import { ErrorCode, KanbanError } from './errors'
import { normalizeLabels } from './labels'
import type { AttachmentRead, CreateTaskInput, KanbanProvider } from './providers/types'
import type { TaskAttachment } from './types'

/**
 * Create-task input as a transport supplies it. It accepts `labels` in raw
 * transport forms (CLI flag arrays, JSON arrays, comma-separated strings), then
 * normalizes them before the provider call. Other provider operations are direct
 * enough for transports to call the provider without a use-case wrapper, except
 * attachment reads, which transports address by id or filename.
 */
export type CreateTaskCommand = Omit<CreateTaskInput, 'labels'> & { labels?: unknown }

export function normalizeCreateTaskInput(input: CreateTaskCommand): CreateTaskInput {
  const { labels, ...rest } = input
  return { ...rest, labels: normalizeLabels(labels) }
}

/**
 * Picks one attachment by id, else by exact filename. Filenames are not unique
 * on a task, so a filename shared by several attachments is refused rather than
 * guessed; the error lists the ids to choose from.
 */
function resolveAttachment(
  attachments: TaskAttachment[],
  idOrRef: string,
  nameOrId: string,
): TaskAttachment {
  const byId = attachments.find((attachment) => attachment.id === nameOrId)
  if (byId) return byId
  const [match, ...others] = attachments.filter((attachment) => attachment.filename === nameOrId)
  if (match && others.length === 0) return match
  if (match) {
    const ids = [match, ...others].map((attachment) => attachment.id).join(', ')
    throw new KanbanError(
      ErrorCode.INVALID_ARGUMENT,
      `Task '${idOrRef}' has ${others.length + 1} attachments named '${nameOrId}' (ids: ${ids}); pass an attachment id`,
    )
  }
  throw new KanbanError(
    ErrorCode.NOT_FOUND,
    `Task '${idOrRef}' has no attachment with id or filename '${nameOrId}'`,
  )
}

export async function readTaskAttachment(
  provider: KanbanProvider,
  input: { idOrRef: string; nameOrId: string; maxBytes: number },
): Promise<AttachmentRead> {
  const attachments = await provider.listAttachments(input.idOrRef)
  const attachment = resolveAttachment(attachments, input.idOrRef, input.nameOrId)
  return provider.readAttachment(input.idOrRef, attachment.id, { maxBytes: input.maxBytes })
}
