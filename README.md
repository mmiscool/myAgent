# MyAgent

Standalone Codex web client built with plain JavaScript, Vite, and a small Node backend that talks to the local `codex` install through `codex app-server`.

## Development

```bash
pnpm dev
```

- Frontend: `http://127.0.0.1:3220`
- Backend: `http://127.0.0.1:3221`
- To use alternate development ports, set `FRONTEND_PORT` and `BACKEND_PORT`.
- Frontend changes update through Vite HMR.
- Backend changes do not auto-restart the Node server.

## Production

```bash
pnpm build
pnpm start
```

`pnpm start` serves `new-app/` and exposes the `/new-api` and `/new-ws` backend routes.

## Notes

- The server expects `codex` to be available on `PATH`.
- If it is not, set `CODEX_BIN` before starting.
- Project definitions are stored in `data/projects.json`.
