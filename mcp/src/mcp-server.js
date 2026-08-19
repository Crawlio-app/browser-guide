import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeSnapshot, readEyesSnapshot } from "./eyes.js";

export async function runMcpServer() {
  // stdout carries JSON-RPC frames only; a closed pipe means the client left.
  process.stdout.on("error", (error) => {
    if (error && error.code === "EPIPE") process.exit(0);
  });

  const server = new McpServer({
    name: "crawlio-browser-guide",
    version: "0.7.0",
  });

  server.registerTool(
    "get_current_page",
    {
      title: "Get the page the Browser Guide user is sharing",
      description: [
        "Returns the sanitized snapshot of the browser page the user chose to share",
        "through Crawlio Browser Guide's \"Eyes\" toggle: origin, title, capture time,",
        "and a bounded accessibility outline. Read-only: this tool cannot click,",
        "type, navigate, or otherwise act on the page. Check captured_at: the",
        "snapshot reflects the moment of the user's last question, not live state.",
      ].join(" "),
      inputSchema: {},
    },
    () => ({
      content: [{ type: "text", text: describeSnapshot(readEyesSnapshot()) }],
    }),
  );

  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  await server.connect(transport);
  console.error("crawlio-browser-guide MCP server ready (reads the eyes snapshot only).");
}
