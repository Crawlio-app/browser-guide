const USAGE = `crawlio-browser-guide — local MCP eyes for Crawlio Browser Guide

Usage:
  crawlio-browser-guide mcp    Run the MCP server over stdio (register it with
                               your agent, e.g.:
                               claude mcp add browser-guide -- npx -y crawlio-browser-guide mcp)

The server only reads ~/.config/browser-guide/eyes.json, the snapshot the
Browser Guide extension publishes while its "Eyes" toggle is on. It has no
browser access and cannot act on any page.`;

export async function main(argumentsList) {
  const [command] = argumentsList;
  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp-server.js");
    await runMcpServer();
    return;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.error(USAGE);
    process.exitCode = command === undefined ? 2 : 0;
    return;
  }
  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  process.exitCode = 2;
}
