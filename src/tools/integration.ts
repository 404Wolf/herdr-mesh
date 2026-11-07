import { z } from "zod";
import { runHc } from "../herdr.js";
import { type ToolDef, okJson, boolFlag } from "./types.js";

// herdr recognizes these agent integrations; herdr-mesh stays agnostic and
// works with whichever are installed/running.
export const integrationTools: ToolDef[] = [
  {
    name: "herdr_integration_status",
    description:
      "Show which agent integrations herdr knows about and their install status (pi, omp, claude, codex, opencode, hermes, qodercli, …). Use this to discover what agent types are available in this herdr install.",
    inputSchema: {
      outdated_only: z
        .boolean()
        .optional()
        .describe("Only list integrations whose hook/extension is outdated."),
    },
    buildArgs: (a) => {
      const argv = ["integration", "status"];
      boolFlag(argv, "--outdated-only", undefined, a.outdated_only);
      return argv;
    },
    core: async () =>
      okJson({
        note: "herdr-core has no integrations: any program that reports status over OSC 7501 is an agent. Templates are ready-made agent roles (start one with herdr_agent_start argv [template, task]).",
        templates: (await runHc(["templates"])).json,
      }),
  },
];
