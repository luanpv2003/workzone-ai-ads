import { db, retryBusy } from "./db";
import { actorName } from "./auth";

/** Write an activity log entry with the logged-in user's name (automatic jobs log as the system). */
export async function logActivity(clientId: string | null, kind: string, message: string) {
  const actor = await actorName();
  await retryBusy(() => db.activity.create({ data: { clientId, kind, message, actor } }));
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
