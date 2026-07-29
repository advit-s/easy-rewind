import type { JsonObject, SyncChange, SyncKind } from './protocol.ts';

export interface ReplayedEntity {
  kind: SyncKind;
  revision: number;
  payload: JsonObject;
}

function wins(left: SyncChange | undefined, candidate: SyncChange): boolean {
  return (
    left === undefined ||
    candidate.revision > left.revision ||
    (candidate.revision === left.revision && candidate.changeId > left.changeId)
  );
}

export function replayChanges(changes: readonly SyncChange[]): Record<string, ReplayedEntity> {
  const records = new Map<string, SyncChange>();
  const observed = new Set<string>();

  for (const change of changes) {
    if (observed.has(change.changeId)) continue;
    observed.add(change.changeId);
    const key = `${change.entityType}:${change.entityId}`;
    if (wins(records.get(key), change)) records.set(key, structuredClone(change));
  }

  return Object.fromEntries(
    [...records.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, change]) => [
        key,
        {
          kind: change.kind,
          revision: change.revision,
          payload: structuredClone(change.payload),
        },
      ])
  );
}

export function remoteChangeWins(
  current: Pick<SyncChange, 'revision' | 'changeId'> | null,
  candidate: Pick<SyncChange, 'revision' | 'changeId'>
): boolean {
  return (
    current === null ||
    candidate.revision > current.revision ||
    (candidate.revision === current.revision && candidate.changeId > current.changeId)
  );
}
