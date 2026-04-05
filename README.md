# Custom Codex Web Client

This project uses plain JavaScript on the frontend with Vite for hot reloading, plus a small Node server that talks to the local `codex` install through `codex app-server`.

## Development

```bash
pnpm dev
```

- Vite frontend: `http://127.0.0.1:3210`
- Codex bridge API: `http://127.0.0.1:3211`
- Frontend changes update in real time through Vite HMR.
- Backend changes do not auto-restart the Node server.

## Production Build

```bash
pnpm build
pnpm start
```

## Notes

- The server expects `codex` to be available on `PATH`.
- If it is not, set `CODEX_BIN` before starting.
- Frontend source lives in `src/`.
- Project definitions are stored in `data/projects.json`.
- The terminal tab starts a host shell in the selected project's working directory.
