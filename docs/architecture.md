# Architecture

## Frontend

The active UI lives under `new-app/`.

- `new-app/index.html`: shell with project and conversation navigation.
- `new-app/chat.html`: conversation view loaded by the shell iframe or opened directly.
- `new-app/src/app.js`: shell state, project selection, conversation list, sidebar controls, and iframe coordination.
- `new-app/src/chat.js`: transcript rendering, conversation settings, image attachments, queued sends, and approval responses.
- `new-app/src/styles.css`: shared styles for the shell, chat page, composer, settings, and image editor.

## Backend

`new-app/server.js` is the only backend entrypoint. It starts `codex app-server`, serves `new-app/`, and exposes:

- `/new-api/boot`
- `/new-api/models`
- `/new-api/projects/:projectId/threads`
- `/new-api/threads`
- `/new-api/threads/:threadId`
- `/new-api/threads/:threadId/message`
- `/new-api/threads/:threadId/interrupt`
- `/new-api/server-requests/:requestId/respond`
- `/new-ws/events`

Shared backend utilities kept at the repo root:

- `server/http-utils.js`: JSON body parsing and JSON/error responses.
- `server-request-tracker.js`: Codex approval/request tracking.
- `project-store-utils.js`: project path deduplication.

## Runtime

`pnpm dev` runs the new backend on port `3221` and Vite on port `3220`. `pnpm start` runs the same backend directly for production-style static serving.
