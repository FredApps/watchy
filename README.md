# Watchy

Watchy is a small private synchronized watch room. It keeps one shared room in memory and focuses on direct video URL playback, chat, playlists, local media browsing, and video reactions.

This fork intentionally removes the original multi-room portal, accounts, subscriptions, virtual browser, screen sharing, file sharing, YouTube/WebTorrent integrations, Discord, Firebase, Redis, Postgres, and VM management code.

## Features

- One shared in-memory room
- Password-gated access with a long-lived auth cookie
- Direct HTTP/HTTPS media URL playback
- Browser-native video plus HLS streams through `hls.js`
- Synchronized play, pause, seek, playback rate, loop, and playlist state
- Chat with markdown, emoji picker, replies, edits, message reactions, and colored names
- Splash reactions over the video
- Local media browser for a configured server-side directory
- Optional theater/fullscreen layout and resizable chat column

Room state is intentionally ephemeral and resets when the Node process restarts.

## Requirements

- Node.js with TypeScript execution support for erasable TypeScript syntax
- npm
- A reverse proxy or direct Node binding for deployment

## Install

```sh
npm install
```

## Build

```sh
npm run build
```

This runs the Vite production build, client typecheck, and server typecheck.

## Run

```sh
npm start
```

By default the server listens on `127.0.0.1:3090` and serves the app at `/watchy`.

## Configuration

Configuration is provided through environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3090` | Node server port |
| `HOST` | `127.0.0.1` | Node bind host |
| `BASE_PATH` | `/watchy` | App mount path |
| `WATCHY_PASSWORD` | `change-me` | Password for the room |
| `WATCHY_COOKIE_SECRET` | derived from password | HMAC secret for auth cookies |
| `WATCHY_MEDIA_ROOT` | `./media` | Directory scanned by `/api/media` |
| `WATCHY_MEDIA_BASE_URL` | `/watchy/media` | URL prefix for files under `WATCHY_MEDIA_ROOT` |

`WATCHY_MEDIA_ROOT` should point only at files you intend to expose. The API only returns supported video files and safe child paths. By default, media is served from the app under `/watchy/media`; set `WATCHY_MEDIA_BASE_URL` when files are exposed by another web server or CDN.

Supported local media extensions:

- `.mp4`
- `.webm`
- `.m4v`
- `.mov`
- `.m3u8`

## Development

```sh
npm run dev
```

For frontend-only iteration you can also run:

```sh
npm run ui
```

## Scripts

- `npm start` - run the Node server
- `npm run dev` - run the Node server in watch mode
- `npm run ui` - run Vite
- `npm run build` - build and typecheck everything
- `npm run typecheck` - typecheck the client
- `npm run typecheckServer` - typecheck the server

## Notes

- The app shell can be served publicly while API and Socket.IO access remain gated by the auth cookie.
- Socket.IO uses the configured `BASE_PATH` for its websocket path.
- The deployment proxy must support websockets.
