# Custom Codex Web Client

This project uses plain JavaScript on the frontend with Vite for hot reloading, plus a small Node server that talks to the local `codex` install through `codex app-server`.

## Development

```bash
pnpm dev
```

- Vite frontend: `http://127.0.0.1:3210`
- Codex bridge API: `http://127.0.0.1:3211`

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
- The UI includes a raw RPC panel for app-server methods that are not yet surfaced directly.
