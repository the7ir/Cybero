# Memory

## Project Overview
See @README.md for project overview and @package.json for available npm/pnpm commands for this project.

## Code Style Guidelines
- Use descriptive variable names
- Follow existing patterns in the codebase
- Extract complex conditions into meaningful boolean variables

## Architecture Notes
The game ships as a prebuilt bundle (`bundle/`, `assets/`) with no source. Multiplayer
is layered on top by patching `index.html` with `multiplayer.js`, which hooks two
globals the runtime already exposes:

- `window.__game.read()` — live player transform/state (x, z, rootY, heading, speed, state, level)
- `window.__engine` — `THREE`, `scene`, `registry`; `registry.get('player.asset')` is a
  skinned clone plus 43 animation clips, used as the remote-avatar template

Remote avatars are added to `engine.scene` (not the level group), so they survive chapter
switches. Materials are cloned with `cloneForRemote` to detach the shared `uDissolve`
uniform and the shader cache key. Avatars hide when a peer is in another chapter.

`server/server.mjs` is a zero-dependency Node server: static files plus a hand-rolled
WebSocket relay at `/ws`. It validates every inbound field (coordinates clamped, names
stripped of control chars, colors regex-checked) and rate-limits per socket.

## Common Workflows
- `npm start` — serve the game with multiplayer on `http://localhost:8080`
- `?play=1&chapter=ch1_climb` — sandbox mode, starts directly in PLAY
- `?net=ws://host:port/ws` — override the socket URL
- `M` — toggle the Wanderers panel (unbound in the game)
