// Replace this boundary with Trigger.dev's scheduled task API during integration.
import { planRenewalAction } from "../src/lib/agent";

export async function renewalSweep(userIds: string[]) {
  return Promise.all(userIds.map(async (userId) => ({
    userId,
    action: await planRenewalAction(userId)
  })));
}
