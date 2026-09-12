import { logger, schedules } from "@trigger.dev/sdk";

/**
 * Nudges people before their SNAP renewal is due.
 *
 * The sending itself lives in the SMS service, which owns the per-user
 * knowledge base and the Vonage credentials, so this task is a scheduled
 * trigger over HTTP rather than a second place that knows how to text.
 */
export const renewalReminder = schedules.task({
  id: "renewal-reminder",
  // 9am on weekdays: late enough not to wake anyone, early enough to act on.
  cron: {
    pattern: "0 9 * * 1-5",
    timezone: "America/Chicago"
  },
  maxDuration: 300,
  run: async (payload) => {
    const baseUrl = process.env.SMS_SERVICE_URL;
    const token = process.env.OUTREACH_TOKEN;

    if (!baseUrl || !token) {
      throw new Error("SMS_SERVICE_URL and OUTREACH_TOKEN must both be set for the renewal reminder.");
    }

    // Set RENEWAL_REMINDER_DRY_RUN=true to see who would be texted without texting them.
    const dryRun = process.env.RENEWAL_REMINDER_DRY_RUN === "true";

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/tasks/renewal-reminder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ dryRun })
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Renewal reminder sweep failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const summary = JSON.parse(body);
    logger.info("Renewal reminder sweep finished", {
      scheduledAt: payload.timestamp,
      considered: summary.considered,
      matched: summary.matched,
      dryRun
    });

    return summary;
  }
});
