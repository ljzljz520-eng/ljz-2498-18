/**
 * Shared acceptance rule for asynchronous layout packets and persisted writes.
 * Every async boundary carries the exact document id, request sequence and
 * user/session token observed when the work started.
 */
export function isCurrentResponse(context, packet) {
  return Boolean(context && packet) &&
    context.requestSeq === packet.requestSeq &&
    context.sessionToken === packet.sessionToken &&
    context.documentId === packet.documentId &&
    context.userId === packet.userId
}

export function isCurrentPosition(context, record) {
  return Boolean(context && record) &&
    context.documentId === record.documentId &&
    context.userId === record.userId
}
