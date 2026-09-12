import { defineConfig } from "@trigger.dev/sdk";

// The project ref comes from your Trigger.dev dashboard (it looks like proj_abc123).
const project = process.env.TRIGGER_PROJECT_REF;
if (!project) {
  throw new Error("TRIGGER_PROJECT_REF is not set. Copy it from your Trigger.dev project settings.");
}

export default defineConfig({
  project,
  dirs: ["./trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      randomize: true
    }
  }
});
