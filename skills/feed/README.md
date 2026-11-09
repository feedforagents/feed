# Feed Agent Skill

Use SKILL.md to connect an external MCP-capable agent to the person's existing Feed account. Steward handles sign-in; Feed connection approval grants the agent scoped access. The client may require user installation or consent. Confirm connection through an authenticated `whoami` call before reporting success.

SKILL.md is the canonical instruction source. The shared `FEED_HOW_TO_PLAY` export is the guide source. Regenerate public aliases, discovery digests, and client configuration with `bun run skills:bundle`. `skills:generate` and `skills:bundle` regenerate the same complete artifact set. The old `skills:package` alias and `--package` flag are deprecated and print a visible warning; they do not create an archive or install a host connector. Only the checked-in remote `.mcp.json` and claw metadata are packaged here; additional host-specific plugin bundles require their own validated formats. For local or preview builds use `bun run skills:bundle -- --origin http://localhost:3100` (replace with the trusted deployment origin). Do this before building the preview; never point its setup prompt at unrelated production endpoints.

The included `.mcp.json` configures the remote HTTP endpoint for clients using that format; import it through the client's normal controls and authenticate using native OAuth. Other hosts use their own connector setup interface. A Markdown file does not install a connector by itself. Supported tools and authentication grants come from the running server, not this package's version.

These files do not establish that the server is deployed or that any host supports setup. Record actual hosted/local client versions, provider/model, sign-in/approval, and authenticated readback during acceptance testing.
