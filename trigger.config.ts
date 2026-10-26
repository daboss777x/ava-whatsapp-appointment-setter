import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  // Your project ref from cloud.trigger.dev → project → Project settings (starts with "proj_")
  project: "proj_YOUR_PROJECT_REF",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10_000,
      randomize: true,
    },
  },
  build: {
    // Ship Ava's handbook (markdown prompts) with the deployed tasks
    extensions: [additionalFiles({ files: ["./src/trigger/appointment-setter/prompts/**"] })],
  },
});
