# Agent Workbench

Independent local project. Do not modify other repositories or existing agent sessions.
User approved implementation of a local React/TypeScript + Fastify control plane for Codex, Claude Code and WorkBuddy, including real bounded synthetic-repository runtime validation.
Beads owns task lifecycle; Git owns code; SQLite holds runtime/configuration/event mappings only.
Read shared contracts in src/shared/types.ts. Each worker owns its assigned directories; do not revert other workers' edits.
Run typecheck, build, unit/integration tests and real browser acceptance. Report real runtime checks separately from simulated transport tests.
Credentials remain in native runtimes/server environment. Never log environment dumps, authentication headers or tokens. Preserve worktrees and code when interrupting.
UI should use clear Chinese, truthful empty/disconnected/error states and accessible controls. Never seed fake completed agent activity as production data.
