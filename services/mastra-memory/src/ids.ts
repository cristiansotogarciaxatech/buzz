const MAX_SCOPE_PART_BYTES = 512;

export interface BuzzMemoryScope {
  communityId: string;
  projectId: string;
  channelId: string;
}

export function projectResourceId(
  scope: Pick<BuzzMemoryScope, "communityId" | "projectId">,
): string {
  return (
    "buzz:" +
    scopePart(scope.communityId, "communityId") +
    ":project:" +
    scopePart(scope.projectId, "projectId")
  );
}

export function channelThreadId(scope: BuzzMemoryScope): string {
  return (
    projectResourceId(scope) +
    ":channel:" +
    scopePart(scope.channelId, "channelId")
  );
}

function scopePart(value: string, label: string): string {
  const trimmed = value.trim();
  const byteLength = Buffer.byteLength(trimmed, "utf8");
  if (
    byteLength === 0 ||
    byteLength > MAX_SCOPE_PART_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new Error(label + " is not a valid memory scope component");
  }
  return encodeURIComponent(trimmed);
}
