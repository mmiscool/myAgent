# Architecture

## Frontend

The UI is split into a host shell and pane-specific clients.

- `src/app.js`: host shell for project selection, tabs, sidebar, host-level composer state, pane iframe lifecycle, and websocket/event coordination.
- `src/chat-pane.js`: chat pane client responsible for conversation rendering and pane-local interactions.
- `src/resource-pane.js`: resource viewer/editor pane.
- `src/terminal-pane.js`: terminal pane.
- `src/pane-bridge.mjs`: host/pane message bridge helpers.
- `src/ui-formatters.mjs`: shared UI formatting and activity/status helpers.
- `src/conversation-ui.mjs`: shared conversation rendering helpers used by host and chat pane.

The host renders a single visible iframe for the active tab and synchronizes pane state over `postMessage`.

## Server

The Node server remains centralized in `server.js`, but common infrastructure is split out:

- `server/http-utils.js`: JSON body parsing and JSON/error responses.
- `server/static-assets.js`: static asset serving for dev and built output.
- `terminal-manager.js`, `server-request-tracker.js`, and `thread-action-utils.js` remain domain-specific helpers.

## Styling

Global styles are now split into imported files under `src/styles/`:

- `base.css`: tokens and global element defaults.
- `shell.css`: shell, sidebar, thread header, and host layout.
- `panes.css`: pane hosts and terminal/resource surfaces.
- `conversation.css`: message, pending request, composer, and image editor UI.
- `utilities.css`: status badges, utility styles, and media queries.

`src/styles.css` is the import aggregator so existing entry points can continue importing one stylesheet.
