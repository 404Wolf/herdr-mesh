import { z } from "zod";
import { runHc } from "../herdr.js";
import { type ToolDef, okJson, unsupported } from "./types.js";

export const sessionTools: ToolDef[] = [
  {
    name: "herdr_session_list",
    description:
      "List herdr persistent sessions. Sessions survive disconnects and can be shared/reattached locally or over SSH. On herdr-core: the core's session and server status.",
    inputSchema: {},
    buildArgs: () => ["session", "list", "--json"],
    core: async () =>
      okJson({
        session: process.env.HC_SESSION ?? "default",
        socket: process.env.HC_SOCKET ?? process.env.HC_TERMINAL_SOCKET ?? null,
        server: (await runHc(["server", "status"])).json,
      }),
  },
  {
    name: "herdr_session_stop",
    description:
      "Stop a named session (use 'default' to target the default session). Stops the server-side session; clients detach.",
    inputSchema: {
      name: z.string().describe("Session name, or 'default'."),
    },
    buildArgs: (a) => ["session", "stop", String(a.name), "--json"],
    core: async () => unsupported("stopping the core from an agent (it ends every agent); Herdr TUI only"),
  },
  {
    name: "herdr_session_delete",
    description: "Delete a named session permanently.",
    inputSchema: {
      name: z.string().describe("Session name to delete."),
    },
    buildArgs: (a) => ["session", "delete", String(a.name), "--json"],
    core: async () => unsupported("deleting sessions; Herdr TUI only"),
  },
];
