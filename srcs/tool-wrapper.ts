import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FileActivityTracker } from "./file-activity-tracker.ts";
import { extractWritePaths } from "./write-paths.ts";

/**
 * Wrap full-lane tools so any write to a file the main lane has already
 * touched goes through a confirm prompt first (file-overlap guard).
 * Which paths a call writes is decided in write-paths.ts; this module only
 * owns the wrapping/interception itself.
 */
export function wrapToolsWithOverlapDetection(
  tools: AgentTool[],
  tracker: FileActivityTracker,
  cwd: string,
  confirmOverlap: (path: string) => Promise<boolean>,
): AgentTool[] {
  const writingTools = ["write", "edit", "bash"];
  return tools.map((tool) =>
    writingTools.includes(tool.name) ? wrapTool(tool, tracker, cwd, confirmOverlap) : tool
  );
}

function wrapTool(
  tool: AgentTool,
  tracker: FileActivityTracker,
  cwd: string,
  confirmOverlap: (path: string) => Promise<boolean>,
): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const paths = extractWritePaths(tool.name, args);

      for (const path of paths) {
        if (tracker.hasWritten(path, cwd)) {
          const proceed = await confirmOverlap(path);
          if (!proceed) {
            return {
              content: [{ type: "text", text: `Skipped: ${path} (main agent has modified it)` }],
              details: undefined,
            };
          }
        }
      }

      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}
