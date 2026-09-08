# Model selection is fork-local and never touches the main session

The fork's model picker replaces only the fork agent's runtime model. It must not
route through the main session's model mutation (`ctx.setModel`): that persists a
`model` entry into the main session's transcript, and the fork is an independent
lane whose choice is meaningless to the main conversation. Keeping the picker
fork-local isolates the main session's state while the side chat experiments with
models, and matches the fork's existing "refork = re-derive from main session"
semantics (a refork naturally drops any fork-local model choice).

## Considered options

- Sync the fork's model choice to the main session via `ctx.setModel`: rejected —
  pollutes the main transcript with a fork-only decision and couples the two lanes.
