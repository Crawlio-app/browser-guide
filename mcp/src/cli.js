const USAGE = `crawlio-browser-guide: Crawlio Browser Guide companion CLI

Usage:
  crawlio-browser-guide init       Install the native helper for Chrome (macOS)
  crawlio-browser-guide doctor     Check every link of the helper installation
  crawlio-browser-guide uninstall  Remove the helper registration
  crawlio-browser-guide mcp        Run the MCP eyes server over stdio
                                   (register with your agent, e.g.:
                                   claude mcp add browser-guide -- npx -y crawlio-browser-guide mcp)

The MCP server only reads ~/.config/browser-guide/eyes.json, the snapshot the
Browser Guide extension publishes while its "Eyes" toggle is on. It has no
browser access and cannot act on any page.`;

export async function main(argumentsList) {
  const [command, ...rest] = argumentsList;
  // Tests point --home at a temp directory; real runs never pass it.
  const homeFlagIndex = rest.indexOf("--home");
  const homeDir = homeFlagIndex !== -1 ? rest[homeFlagIndex + 1] : undefined;

  switch (command) {
    case "mcp": {
      const { runMcpServer } = await import("./mcp-server.js");
      await runMcpServer();
      return;
    }
    case "init": {
      const { runInit } = await import("./commands/init.js");
      await runInit(homeDir);
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor.js");
      await runDoctor(homeDir);
      return;
    }
    case "uninstall": {
      const { runUninstall } = await import("./commands/uninstall.js");
      runUninstall(homeDir);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.error(USAGE);
      process.exitCode = command === undefined ? 2 : 0;
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 2;
  }
}
