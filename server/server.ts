import compression from "compression";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { Server, type Socket } from "socket.io";
import { Innertube } from "youtubei.js";

// Load .env from the project root so config (password, cookie secret) survives
// restarts regardless of how the process is launched (e.g. Task Scheduler).
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env"));
} catch {
  // No .env file present; fall back to the ambient environment / defaults.
}

const PORT = Number(process.env.PORT ?? 3090);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_PATH = normalizeBase(process.env.BASE_PATH ?? "/watchy");
const PASSWORD = process.env.WATCHY_PASSWORD ?? "change-me";
const COOKIE_NAME = "watchy_auth";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;
const COOKIE_SECRET =
  process.env.WATCHY_COOKIE_SECRET ??
  crypto.createHash("sha256").update(`watchy:${PASSWORD}`).digest("hex");
const MEDIA_ROOT = path.resolve(process.env.WATCHY_MEDIA_ROOT ?? path.join(process.cwd(), "media"));
const MEDIA_BASE_URL = process.env.WATCHY_MEDIA_BASE_URL ?? `${BASE_PATH}/media`;
const BUILD_DIR = path.resolve(import.meta.dirname, "../build");
const YTDLP_PATH = process.env.YTDLP_PATH ?? "yt-dlp";
const YT_MAX_HEIGHT = Number(process.env.YT_MAX_HEIGHT ?? 1080);
const YT_PLAYLIST_MAX_ITEMS = Number(process.env.YT_PLAYLIST_MAX_ITEMS ?? 100);
const DEBUG_YT_SEEK = process.env.DEBUG_YT_SEEK === "1";
const SUPPORTED_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".mov", ".m3u8"]);
const MESSAGE_REACTIONS = new Set([
  "\u{1F600}",
  "\u{1F603}",
  "\u{1F604}",
  "\u{1F601}",
  "\u{1F606}",
  "\u{1F605}",
  "\u{1F602}",
  "\u{1F923}",
  "\u{1F642}",
  "\u{1F60A}",
  "\u{1F607}",
  "\u{1F970}",
  "\u{1F60D}",
  "\u{1F929}",
  "\u{1F618}",
  "\u{1F617}",
  "\u{1F619}",
  "\u{1F61A}",
  "\u{1F60B}",
  "\u{1F61B}",
  "\u{1F61C}",
  "\u{1F92A}",
  "\u{1F61D}",
  "\u{1F911}",
  "\u{1F917}",
  "\u{1F92D}",
  "\u{1F92B}",
  "\u{1F914}",
  "\u{1F910}",
  "\u{1F928}",
  "\u{1F633}",
  "\u{1F97A}",
  "\u{1F44D}",
  "\u{1F44F}",
  "\u{1F525}",
  "\u{2728}",
  "\u{1F37F}",
  "\u{2764}\u{FE0F}",
  "\u{1F389}",
]);
const SPLASH_REACTIONS = new Set([
  "\u{1F916}",
  "\u{1F496}",
  "\u{1F97A}",
  "\u{1F37F}",
  "\u{1F608}",
  "\u{1F33B}",
  "\u{1F602}",
  "\u{1FAE6}",
  "\u{1F44F}",
  "\u{1F422}",
  "\u{1F975}",
  "\u{1F64F}",
  "\u{2728}",
  "\u{1F62D}",
  "\u{1F440}",
  "\u{2764}\u{FE0F}",
  "\u{1F47B}",
  "\u{1F389}",
  "\u{1F4AA}",
  "\u{263A}\u{FE0F}",
  "\u{1F964}",
  "\u{1F479}",
  "\u{1F913}",
  "\u{1F48B}",
  "\u{1F62E}",
  "\u{1F525}",
  "\u{1F979}",
  "\u{1F434}",
  "\u{1F33C}",
  "\u{1F618}",
  "\u{1F927}",
  "\u{1F978}",
]);

type PlaylistItem = {
  url: string;
  name: string;
  duration: number;
  type: "file";
};

type YouTubeHistoryItem = {
  kind: "video";
  id: string;
  title: string;
  author: string;
  duration: string;
  thumbnail: string;
};

type MediaDirectory = {
  type: "directory";
  name: string;
  path: string;
};

type MediaEntry = PlaylistItem | MediaDirectory;

type SortableMediaEntry = MediaEntry & {
  modifiedMs: number;
};

type SortablePlaylistItem = PlaylistItem & {
  modifiedMs: number;
};

type ChatMessage = {
  id: string;
  name: string;
  actorId?: string;
  msg: string;
  timestamp: string;
  videoTS?: number;
  editedAt?: string;
  replyToId?: string;
  replyToName?: string;
  replyToMsg?: string;
  replyToTimestamp?: string;
  reactions?: Record<string, string[]>;
};

type User = {
  id: string;
  name: string;
};

type HostState = {
  video: string;
  videoTS: number;
  hostSeq: number;
  paused: boolean;
  playbackRate: number;
  loop: boolean;
};

type WatchyState = HostState & {
  playlist: PlaylistItem[];
  ytHistory: YouTubeHistoryItem[];
  chat: ChatMessage[];
  names: Record<string, string>;
  colors: Record<string, string>;
  roster: User[];
  tsMap: Record<string, number>;
};

const state: WatchyState = {
  video: "",
  videoTS: 0,
  hostSeq: 0,
  paused: true,
  playbackRate: 1,
  loop: false,
  playlist: [],
  ytHistory: [],
  chat: [],
  names: {},
  colors: {},
  roster: [],
  tsMap: {},
};
const socketByClientId = new Map<string, string>();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: `${BASE_PATH}/socket.io`,
  transports: ["websocket", "polling"],
});

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(compression());

app.get("/", (_req, res) => res.redirect(BASE_PATH));
app.post(`${BASE_PATH}/api/login`, (req, res) => {
  if (String(req.body?.password ?? "") !== PASSWORD) {
    res.status(401).json({ ok: false });
    return;
  }

  res.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, createAuthToken(), {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: BASE_PATH,
      sameSite: "Lax",
      secure: true,
    }),
  );
  res.json({ ok: true });
});

app.post(`${BASE_PATH}/api/logout`, (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, "", {
      httpOnly: true,
      maxAge: 0,
      path: BASE_PATH,
      sameSite: "Lax",
      secure: true,
    }),
  );
  res.json({ ok: true });
});

app.get(`${BASE_PATH}/api/session`, requireAuth, (_req, res) => {
  res.json({ ok: true });
});

app.get(`${BASE_PATH}/api/media`, requireAuth, async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "").trim().toLowerCase();
    const requestedPath = String(req.query.path ?? "");
    if (query) {
      const files = await searchMediaFiles(MEDIA_ROOT, query);
      res.json(files.slice(0, 200));
      return;
    }
    const entries = await listMediaDirectory(MEDIA_ROOT, requestedPath);
    res.json(entries);
  } catch (error) {
    next(error);
  }
});

app.get(`${BASE_PATH}/api/yt/search`, requireAuth, async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      res.json([]);
      return;
    }
    const yt = await getInnertube();
    const [videoSearch, playlistSearch] = await Promise.all([
      yt.search(query, { type: "video" }),
      yt.search(query, { type: "playlist" }),
    ]);
    const videos = videoSearch.results
      .filter((r: any) => r.type === "Video" && r.id)
      .slice(0, 10)
      .map((r: any) => ({
        kind: "video",
        id: r.id,
        title: textValue(r.title),
        author: r.author?.name ?? textValue(r.author) ?? "",
        duration: r.duration?.text ?? "",
        thumbnail: thumbnailUrl(r.thumbnails),
      }));
    const playlists = playlistSearch.results
      .filter((r: any) => youtubePlaylistResultId(r))
      .slice(0, 8)
      .map((r: any) => ({
        kind: "playlist",
        id: youtubePlaylistResultId(r),
        title: youtubeResultTitle(r),
        author: r.author?.name ?? textValue(r.author) ?? "",
        count: textValue(r.video_count_short) || textValue(r.video_count) || "",
        duration: "",
        thumbnail: youtubeResultThumbnail(r),
      }));
    res.json([...videos, ...playlists]);
  } catch (error) {
    next(error);
  }
});

app.get(`${BASE_PATH}/api/yt/history`, requireAuth, (_req, res) => {
  res.json(state.ytHistory);
});

app.get(`${BASE_PATH}/api/yt/manifest`, requireAuth, async (req, res, next) => {
  try {
    const id = parseYouTubeId(`https://www.youtube.com/watch?v=${String(req.query.v ?? "")}`);
    if (!id) {
      res.status(400).json({ ok: false });
      return;
    }
    const resolved = await resolveYouTube(id);
    res.setHeader("Content-Type", "application/dash+xml");
    res.setHeader("Cache-Control", "no-store");
    res.send(buildDashManifest(id, resolved));
  } catch (error) {
    next(error);
  }
});

app.get(`${BASE_PATH}/api/yt/seg`, requireAuth, async (req, res) => {
  const id = parseYouTubeId(`https://www.youtube.com/watch?v=${String(req.query.v ?? "")}`);
  const itag = Number(req.query.itag);
  if (!id || !Number.isInteger(itag)) {
    res.status(400).end();
    return;
  }
  try {
    await proxyYouTubeSegment(id, itag, req, res, true);
  } catch {
    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.end();
    }
  }
});

app.use(`${BASE_PATH}/media`, requireAuth, express.static(MEDIA_ROOT, { fallthrough: false }));
app.use(BASE_PATH, express.static(BUILD_DIR, { fallthrough: true }));
app.get(`${BASE_PATH}/*splat`, (_req, res) => {
  res.sendFile(path.join(BUILD_DIR, "index.html"));
});

io.use((socket, next) => {
  const cookies = parseCookies(socket.request.headers.cookie);
  if (!verifyAuthToken(cookies[COOKIE_NAME])) {
    next(new Error("unauthorized"));
    return;
  }
  next();
});

io.on("connection", (socket: Socket) => {
  const clientId = sanitizeClientId(socket.handshake.auth?.clientId);
  const existingSocketId = socketByClientId.get(clientId);
  if (existingSocketId && existingSocketId !== socket.id) {
    io.sockets.sockets.get(existingSocketId)?.disconnect(true);
  }
  socketByClientId.set(clientId, socket.id);
  socket.data.clientId = clientId;
  state.names[clientId] ||= "Guest";
  syncRoster();

  socket.emit("REC:host", getHostState());
  socket.emit("REC:nameMap", state.names);
  socket.emit("REC:colorMap", state.colors);
  socket.emit("REC:tsMap", state.tsMap);
  socket.emit("chatinit", state.chat);
  socket.emit("playlist", state.playlist);
  if (state.video && !state.paused) {
    socket.emit("REC:play");
  }
  emitRoster();

  socket.on("CMD:name", (raw: unknown) => {
    const name = String(raw ?? "").trim().slice(0, 40) || "Guest";
    state.names[clientId] = name;
    syncRoster();
    io.emit("REC:nameMap", state.names);
    emitRoster();
  });

  socket.on("CMD:renameUser", (raw: unknown) => {
    const payload = (raw ?? {}) as { id?: unknown; name?: unknown };
    const targetId = String(payload.id ?? "");
    const name = String(payload.name ?? "").trim().slice(0, 40);
    if (!/^[0-9a-f-]{36}$/i.test(targetId) || !(targetId in state.names) || !name) {
      return;
    }
    state.names[targetId] = name;
    syncRoster();
    io.emit("REC:nameMap", state.names);
    emitRoster();
  });

  socket.on("CMD:color", (raw: unknown) => {
    const color = String(raw ?? "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      return;
    }
    state.colors[clientId] = color;
    io.emit("REC:colorMap", state.colors);
  });

  socket.on("CMD:host", async (raw: unknown, ack?: () => void) => {
    try {
      const url = String(raw ?? "");
      const yt = parseYouTubeUrl(url);
      if (yt) {
        try {
          const resolved = await resolveYouTube(yt.id);
          const startParam = yt.startSeconds > 0 ? `&start=${yt.startSeconds}` : "";
          if (DEBUG_YT_SEEK) {
            console.info("[watchy:yt-seek] host", { id: yt.id, startSeconds: yt.startSeconds });
          }
          setHost(`${BASE_PATH}/api/yt/manifest?v=${yt.id}${startParam}`, clientId, resolved.title, yt.startSeconds);
        } catch (error) {
          addSystemChat(clientId, `couldn't load YouTube video (${(error as Error).message})`);
        }
        return;
      }
      setHost(url, clientId);
    } finally {
      ack?.();
    }
  });

  socket.on("CMD:play", () => {
    state.paused = false;
    io.emit("REC:play");
    addSystemChat(clientId, "started the video");
    io.emit("REC:host", getHostState());
  });

  socket.on("CMD:pause", () => {
    state.paused = true;
    io.emit("REC:pause");
    addSystemChat(clientId, "paused the video");
    io.emit("REC:host", getHostState());
  });

  socket.on("CMD:seek", (raw: unknown) => {
    const time = clampTime(Number(raw));
    state.videoTS = time;
    state.tsMap = {};
    io.emit("REC:tsMap", state.tsMap);
    io.emit("REC:seek", time);
    addSystemChat(clientId, `jumped to ${formatTimestamp(time)}`);
    io.emit("REC:host", getHostState());
  });

  socket.on("CMD:playbackRate", (raw: unknown) => {
    const rate = clampPlaybackRate(Number(raw));
    state.playbackRate = rate;
    io.emit("REC:playbackRate", rate);
    addSystemChat(clientId, `set playback to ${rate}x`);
    io.emit("REC:host", getHostState());
  });

  socket.on("CMD:loop", (raw: unknown) => {
    state.loop = Boolean(raw);
    io.emit("REC:loop", state.loop);
    io.emit("REC:host", getHostState());
  });

  socket.on("CMD:ts", (raw: unknown) => {
    const time = clampTime(Number(raw));
    state.tsMap[clientId] = time;
    if (!state.paused) {
      state.videoTS = Math.max(state.videoTS, time);
    }
  });

  socket.on("CMD:chat", (raw: unknown) => {
    const data =
      typeof raw === "object" && raw !== null
        ? (raw as { msg?: unknown; replyToTimestamp?: unknown })
        : { msg: raw };
    const msg = String(data.msg ?? "").trim();
    if (!msg || msg.length > 1000) {
      return;
    }
    const replyToTimestamp = String(data.replyToTimestamp ?? "");
    const replyTarget = replyToTimestamp
      ? state.chat.find((message) => message.timestamp === replyToTimestamp)
      : undefined;
    const chatMessage: ChatMessage = {
      id: clientId,
      name: state.names[clientId] || "Guest",
      msg,
      timestamp: new Date().toISOString(),
      videoTS: state.tsMap[clientId],
    };
    if (replyTarget) {
      chatMessage.replyToId = replyTarget.id;
      chatMessage.replyToName = replyTarget.id
        ? state.names[replyTarget.id] || replyTarget.name
        : replyTarget.name;
      chatMessage.replyToMsg = replyTarget.msg;
      chatMessage.replyToTimestamp = replyTarget.timestamp;
    }
    addChat(chatMessage);
  });

  socket.on("CMD:editChat", (raw: unknown) => {
    const data = raw as { timestamp?: string; msg?: string };
    const timestamp = String(data?.timestamp ?? "");
    const msg = String(data?.msg ?? "").trim();
    if (!timestamp || !msg || msg.length > 1000) {
      return;
    }
    const target = state.chat.find(
      (message) => message.id === clientId && message.timestamp === timestamp,
    );
    if (!target) {
      return;
    }
    target.msg = msg;
    target.editedAt = new Date().toISOString();
    io.emit("chatinit", state.chat);
  });

  socket.on("CMD:messageReaction", (raw: unknown) => {
    const data = raw as { timestamp?: string; value?: string };
    const timestamp = String(data?.timestamp ?? "");
    const value = String(data?.value ?? "");
    if (!timestamp || !MESSAGE_REACTIONS.has(value)) {
      return;
    }
    const target = state.chat.find((message) => message.id && message.timestamp === timestamp);
    if (!target) {
      return;
    }
    target.reactions ||= {};
    target.reactions[value] ||= [];
    if (target.reactions[value].includes(clientId)) {
      target.reactions[value] = target.reactions[value].filter((id) => id !== clientId);
    } else {
      target.reactions[value].push(clientId);
    }
    if (target.reactions[value].length === 0) {
      delete target.reactions[value];
    }
    if (Object.keys(target.reactions).length === 0) {
      delete target.reactions;
    }
    io.emit("chatinit", state.chat);
  });

  socket.on("CMD:playlistAdd", async (raw: unknown, ack?: () => void) => {
    try {
      const url = String(raw ?? "");
      let item: PlaylistItem | null;
      const playlistId = parseYouTubePlaylistId(url);
      if (playlistId) {
        try {
          const items = await resolveYouTubePlaylist(playlistId);
          if (items.length === 0) {
            addSystemChat(clientId, "couldn't queue YouTube playlist (no playable videos found)");
            return;
          }
          state.playlist.push(...items);
          io.emit("playlist", state.playlist);
          addSystemChat(clientId, `added playlist to queue: ${items.length} videos`);
          if (!state.video) {
            playlistNext(clientId);
          }
        } catch (error) {
          addSystemChat(clientId, `couldn't queue YouTube playlist (${(error as Error).message})`);
        }
        return;
      }
      const yt = parseYouTubeUrl(url);
      if (yt) {
        try {
          const resolved = await resolveYouTube(yt.id);
          const startParam = yt.startSeconds > 0 ? `&start=${yt.startSeconds}` : "";
          const nameSuffix = yt.startSeconds > 0 ? ` @ ${formatTimestamp(yt.startSeconds)}` : "";
          item = {
            url: `${BASE_PATH}/api/yt/manifest?v=${yt.id}${startParam}`,
            name: `${resolved.title}${nameSuffix}`,
            duration: resolved.durationSec,
            type: "file",
          };
        } catch (error) {
          addSystemChat(clientId, `couldn't load YouTube video (${(error as Error).message})`);
          return;
        }
      } else {
        item = makePlaylistItem(url);
      }
      if (!item) {
        return;
      }
      state.playlist.push(item);
      io.emit("playlist", state.playlist);
      addSystemChat(clientId, `added to playlist: ${item.name}`);
      if (!state.video) {
        playlistNext(clientId);
      }
    } finally {
      ack?.();
    }
  });

  socket.on("CMD:playlistNext", () => playlistNext(clientId));

  socket.on("CMD:playlistMove", (raw: unknown) => {
    const data = raw as { index?: number; toIndex?: number };
    const index = Number(data?.index);
    const toIndex = Number(data?.toIndex);
    if (!Number.isInteger(index) || !Number.isInteger(toIndex)) {
      return;
    }
    if (index < 0 || index >= state.playlist.length) {
      return;
    }
    const [item] = state.playlist.splice(index, 1);
    state.playlist.splice(Math.max(0, Math.min(toIndex, state.playlist.length)), 0, item);
    io.emit("playlist", state.playlist);
  });

  socket.on("CMD:playlistDelete", (raw: unknown) => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= state.playlist.length) {
      return;
    }
    state.playlist.splice(index, 1);
    io.emit("playlist", state.playlist);
  });

  socket.on("CMD:splashReaction", (raw: unknown) => {
    const value = String(raw ?? "");
    if (!SPLASH_REACTIONS.has(value)) {
      return;
    }
    io.emit("REC:splashReaction", {
      id: crypto.randomUUID(),
      value,
      user: clientId,
      timestamp: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    if (socketByClientId.get(clientId) === socket.id) {
      socketByClientId.delete(clientId);
      delete state.tsMap[clientId];
      syncRoster();
      emitRoster();
      io.emit("REC:tsMap", state.tsMap);
    }
  });
});

setInterval(() => {
  if (Object.keys(state.tsMap).length > 0) {
    io.emit("REC:tsMap", state.tsMap);
  }
}, 1000);

setInterval(() => {
  const before = state.roster.map((user) => user.id).join(",");
  syncRoster();
  const after = state.roster.map((user) => user.id).join(",");
  if (before !== after) {
    emitRoster();
  }
}, 5000);

server.listen(PORT, HOST, () => {
  console.log(`watchy listening on http://${HOST}:${PORT}${BASE_PATH}`);
  console.log(`media root: ${MEDIA_ROOT}`);
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!verifyAuthToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
    res.status(401).json({ ok: false });
    return;
  }
  next();
}

function createAuthToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + COOKIE_MAX_AGE_SECONDS * 1000 }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", COOKIE_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAuthToken(token: string | undefined) {
  if (!token) {
    return false;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", COOKIE_SECRET)
    .update(payload)
    .digest("base64url");
  if (signature.length !== expected.length) {
    return false;
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    maxAge: number;
    path: string;
    sameSite: "Lax" | "Strict";
    secure: boolean;
  },
) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name) {
      cookies[name] = decodeURIComponent(valueParts.join("="));
    }
  }
  return cookies;
}

async function listMediaDirectory(root: string, relativeDir: string): Promise<MediaEntry[]> {
  const rootReal = await fs.realpath(root);
  const targetDir = await resolveSafeMediaPath(rootReal, relativeDir);
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const out: SortableMediaEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    const real = await fs.realpath(fullPath);
    const stats = await fs.stat(real);
    const relative = normalizeMediaRelativePath(path.relative(rootReal, real));
    if (!isSafeRelativePath(relative)) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push({
        type: "directory",
        name: entry.name,
        path: relative,
        modifiedMs: stats.mtimeMs,
      });
      continue;
    }
    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push({ ...makeMediaFile(relative), modifiedMs: stats.mtimeMs });
    }
  }
  return out.sort(sortMediaEntries).map(stripModifiedMs);
}

async function searchMediaFiles(root: string, query: string): Promise<PlaylistItem[]> {
  const rootReal = await fs.realpath(root);
  const out: SortablePlaylistItem[] = [];
  await walk(rootReal);
  return out
    .sort((a, b) => b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name))
    .map(stripPlaylistModifiedMs);

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const real = await fs.realpath(fullPath);
      const relative = normalizeMediaRelativePath(path.relative(rootReal, real));
      if (!isSafeRelativePath(relative)) {
        continue;
      }
      if (query && !relative.toLowerCase().includes(query)) {
        continue;
      }
      const stats = await fs.stat(real);
      out.push({ ...makeMediaFile(relative), modifiedMs: stats.mtimeMs });
    }
  }
}

function sortMediaEntries(a: SortableMediaEntry, b: SortableMediaEntry) {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name);
}

function stripModifiedMs(entry: SortableMediaEntry): MediaEntry {
  const { modifiedMs: _modifiedMs, ...rest } = entry;
  return rest;
}

function stripPlaylistModifiedMs(entry: SortablePlaylistItem): PlaylistItem {
  const { modifiedMs: _modifiedMs, ...rest } = entry;
  return rest;
}

async function resolveSafeMediaPath(rootReal: string, relativeInput: string) {
  const normalized = normalizeMediaRelativePath(relativeInput);
  if (!isSafeRelativePath(normalized)) {
    return rootReal;
  }
  const target = path.resolve(rootReal, normalized);
  const real = await fs.realpath(target);
  const relative = normalizeMediaRelativePath(path.relative(rootReal, real));
  if (!isSafeRelativePath(relative)) {
    return rootReal;
  }
  return real;
}

function makeMediaFile(relative: string): PlaylistItem {
  return {
    url: `${MEDIA_BASE_URL}/${relative.split("/").map(encodeURIComponent).join("/")}`,
    name: relative,
    duration: 0,
    type: "file",
  };
}

function normalizeMediaRelativePath(input: string) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isSafeRelativePath(input: string) {
  return input === "" || (!input.startsWith("../") && input !== ".." && !path.isAbsolute(input));
}

function getHostState(): HostState {
  return {
    video: state.video,
    videoTS: state.videoTS,
    hostSeq: state.hostSeq,
    paused: state.paused,
    playbackRate: state.playbackRate,
    loop: state.loop,
  };
}

// ---------------------------------------------------------------------------
// YouTube support: yt-dlp resolves working stream URLs (handles SABR/PO-token),
// youtubei.js supplies the DASH init/index ranges + codecs that yt-dlp omits,
// and the client plays the resulting DASH manifest via shaka. All streams are
// proxied (Range) so playback is independent of the viewer's IP/CORS.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

type YtTrack = {
  itag: number;
  url: string;
  mime: string;
  codecs: string;
  init: { start: number; end: number };
  index: { start: number; end: number };
  clen: number;
  width?: number;
  height?: number;
  fps?: number;
  bandwidth: number;
  audioSampleRate?: number;
};
type YtResolved = {
  title: string;
  durationSec: number;
  video: YtTrack;
  audio: YtTrack;
  resolvedAt: number;
};

const YT_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const ytCache = new Map<string, YtResolved>();
let innertube: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  if (!innertube) {
    innertube = await Innertube.create({ generate_session_locally: true });
  }
  return innertube;
}

type ParsedYouTubeUrl = {
  id: string;
  startSeconds: number;
};

function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const idLike = (value: string | null) => (value && /^[\w-]{11}$/.test(value) ? value : null);
  let id: string | null = null;
  if (host === "youtu.be") {
    id = idLike(url.pathname.slice(1).split("/")[0]);
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") {
      id = idLike(url.searchParams.get("v"));
    } else {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "v") {
        id = idLike(parts[1] ?? null);
      }
    }
  }
  return id ? { id, startSeconds: parseYouTubeStartSeconds(url) } : null;
}

function parseYouTubeId(input: string): string | null {
  return parseYouTubeUrl(input)?.id ?? null;
}

function parseYouTubePlaylistId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com") {
    return null;
  }
  const id = url.searchParams.get("list");
  return id && /^[\w-]+$/.test(id) ? id : null;
}

function parseYouTubeStartSeconds(url: URL): number {
  return parseTimeParam(url.searchParams.get("t") ?? url.searchParams.get("start"));
}

function parseTimeParam(value: string | null): number {
  if (!value) {
    return 0;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  if (/^\d+$/.test(normalized)) {
    return clampTime(Number(normalized));
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(normalized);
  if (!match || !match[0]) {
    return 0;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return clampTime(hours * 3600 + minutes * 60 + seconds);
}

function parseInternalStartSeconds(input: string): number {
  try {
    const parsed = new URL(input, "http://watchy.local");
    if (parsed.pathname !== `${BASE_PATH}/api/yt/manifest`) {
      return 0;
    }
    return clampTime(Number(parsed.searchParams.get("start") ?? 0));
  } catch {
    return 0;
  }
}

function parseInternalYouTubeId(input: string): string | null {
  try {
    const parsed = new URL(input, "http://watchy.local");
    if (parsed.pathname !== `${BASE_PATH}/api/yt/manifest`) {
      return null;
    }
    const id = parsed.searchParams.get("v") ?? "";
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

type YtDlpFormat = {
  format_id: string;
  url?: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  width?: number;
  fps?: number;
  tbr?: number;
  abr?: number;
  ext?: string;
};

async function ytDlpFormats(id: string): Promise<Map<number, YtDlpFormat>> {
  const { stdout } = await execFileAsync(
    YTDLP_PATH,
    ["-J", "--no-warnings", "--no-playlist", `https://www.youtube.com/watch?v=${id}`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as { formats?: YtDlpFormat[] };
  const map = new Map<number, YtDlpFormat>();
  for (const f of data.formats ?? []) {
    const itag = Number(f.format_id);
    if (Number.isInteger(itag) && f.url) {
      map.set(itag, f);
    }
  }
  return map;
}

function pickBest<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

async function resolveYouTube(id: string): Promise<YtResolved> {
  const cached = ytCache.get(id);
  if (cached && Date.now() - cached.resolvedAt < YT_CACHE_TTL_MS) {
    return cached;
  }

  const [formats, info] = await Promise.all([ytDlpFormats(id), getInnertube().then((yt) => yt.getInfo(id))]);
  const adaptive = info.streaming_data?.adaptive_formats ?? [];

  const byItag = (itag: number) => adaptive.find((f) => f.itag === itag);
  const hasUrl = (itag: number) => formats.has(itag);

  // Prefer H.264 (avc1) <= max height for broad MSE support; fall back to vp9.
  const videoCandidates = adaptive.filter(
    (f) => f.has_video && !f.has_audio && hasUrl(f.itag) && f.init_range && f.index_range && (f.height ?? 0) <= YT_MAX_HEIGHT,
  );
  const videoFmt =
    pickBest(
      videoCandidates.filter((f) => (f.mime_type ?? "").includes("avc1")),
      (f) => (f.height ?? 0) * 1000 + (f.bitrate ?? 0) / 1000,
    ) ?? pickBest(videoCandidates, (f) => (f.height ?? 0) * 1000 + (f.bitrate ?? 0) / 1000);

  const audioCandidates = adaptive.filter(
    (f) => f.has_audio && !f.has_video && hasUrl(f.itag) && f.init_range && f.index_range,
  );
  const audioFmt =
    pickBest(
      audioCandidates.filter((f) => (f.mime_type ?? "").includes("mp4a")),
      (f) => f.bitrate ?? 0,
    ) ?? pickBest(audioCandidates, (f) => f.bitrate ?? 0);

  if (!videoFmt || !audioFmt) {
    throw new Error("No playable YouTube formats found");
  }

  const toTrack = (f: NonNullable<ReturnType<typeof byItag>>): YtTrack => ({
    itag: f.itag,
    url: formats.get(f.itag)!.url!,
    mime: (f.mime_type ?? "").split(";")[0],
    codecs: /codecs="([^"]+)"/.exec(f.mime_type ?? "")?.[1] ?? "",
    init: { start: f.init_range!.start, end: f.init_range!.end },
    index: { start: f.index_range!.start, end: f.index_range!.end },
    clen: Number(f.content_length ?? 0),
    width: f.width,
    height: f.height,
    fps: f.fps,
    bandwidth: f.bitrate ?? f.average_bitrate ?? 1_000_000,
    audioSampleRate: f.audio_sample_rate ? Number(f.audio_sample_rate) : undefined,
  });

  const resolved: YtResolved = {
    title: info.basic_info.title ?? "YouTube video",
    durationSec: info.basic_info.duration ?? 0,
    video: toTrack(videoFmt),
    audio: toTrack(audioFmt),
    resolvedAt: Date.now(),
  };
  ytCache.set(id, resolved);
  return resolved;
}

async function resolveYouTubePlaylist(id: string): Promise<PlaylistItem[]> {
  let playlist = await getInnertube().then((yt) => yt.getPlaylist(id));
  const items: PlaylistItem[] = [];
  const seen = new Set<string>();
  while (items.length < YT_PLAYLIST_MAX_ITEMS) {
    for (const raw of playlist.items as any[]) {
      const videoId = playlistVideoId(raw);
      if (!videoId || seen.has(videoId)) {
        continue;
      }
      seen.add(videoId);
      items.push({
        url: `${BASE_PATH}/api/yt/manifest?v=${videoId}`,
        name: playlistVideoTitle(raw),
        duration: playlistVideoDuration(raw),
        type: "file",
      });
      if (items.length >= YT_PLAYLIST_MAX_ITEMS) {
        break;
      }
    }
    if (items.length >= YT_PLAYLIST_MAX_ITEMS || !playlist.has_continuation) {
      break;
    }
    playlist = await playlist.getContinuation();
  }
  return items;
}

function playlistVideoId(item: any): string | null {
  const id = item?.id ?? (item?.content_type === "VIDEO" ? item?.content_id : null);
  return typeof id === "string" && /^[\w-]{11}$/.test(id) ? id : null;
}

function playlistVideoTitle(item: any): string {
  return textValue(item?.title) || textValue(item?.metadata?.title) || "YouTube video";
}

function playlistVideoDuration(item: any): number {
  const seconds = Number(item?.duration?.seconds ?? item?.length_seconds ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

async function proxyYouTubeSegment(
  id: string,
  itag: number,
  req: Request,
  res: Response,
  allowReresolve: boolean,
): Promise<void> {
  const resolved = await resolveYouTube(id);
  const track = resolved.video.itag === itag ? resolved.video : resolved.audio.itag === itag ? resolved.audio : null;
  if (!track) {
    res.status(404).end();
    return;
  }

  const headers: Record<string, string> = {};
  const range = req.headers.range;
  if (range) {
    headers.Range = range;
  }
  const upstream = await fetch(track.url, { headers });

  if ((upstream.status === 403 || upstream.status === 410) && allowReresolve) {
    ytCache.delete(id);
    await proxyYouTubeSegment(id, itag, req, res, false);
    return;
  }
  if (!upstream.ok && upstream.status !== 206) {
    res.status(502).end();
    return;
  }

  res.status(upstream.status);
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  }
  if (!upstream.headers.get("accept-ranges")) {
    res.setHeader("Accept-Ranges", "bytes");
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as any).pipe(res);
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function buildDashManifest(id: string, r: YtResolved): string {
  const duration = `PT${r.durationSec}S`;
  const seg = (itag: number) => `${BASE_PATH}/api/yt/seg?v=${id}&itag=${itag}`;
  const v = r.video;
  const a = r.audio;
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${duration}" minBufferTime="PT1.5S">
  <Period>
    <AdaptationSet mimeType="${v.mime}" contentType="video" segmentAlignment="true">
      <Representation id="video" codecs="${xmlEscape(v.codecs)}" bandwidth="${v.bandwidth}" width="${v.width ?? 0}" height="${v.height ?? 0}"${v.fps ? ` frameRate="${v.fps}"` : ""}>
        <BaseURL>${xmlEscape(seg(v.itag))}</BaseURL>
        <SegmentBase indexRange="${v.index.start}-${v.index.end}">
          <Initialization range="${v.init.start}-${v.init.end}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="${a.mime}" contentType="audio" segmentAlignment="true">
      <Representation id="audio" codecs="${xmlEscape(a.codecs)}" bandwidth="${a.bandwidth}"${a.audioSampleRate ? ` audioSamplingRate="${a.audioSampleRate}"` : ""}>
        <BaseURL>${xmlEscape(seg(a.itag))}</BaseURL>
        <SegmentBase indexRange="${a.index.start}-${a.index.end}">
          <Initialization range="${a.init.start}-${a.init.end}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function setHost(url: string, clientId?: string, label?: string, startSeconds = 0) {
  const cleanUrl = url.trim().slice(0, 4000);
  if (cleanUrl && !isAllowedMediaUrl(cleanUrl)) {
    return;
  }
  const previousVideo = state.video;
  const initialTime = cleanUrl ? clampTime(startSeconds || parseInternalStartSeconds(cleanUrl)) : 0;
  state.video = cleanUrl;
  state.videoTS = initialTime;
  state.hostSeq += 1;
  state.paused = !cleanUrl;
  state.playbackRate = 1;
  state.loop = false;
  state.tsMap = {};
  recordYouTubeHistory(cleanUrl, label);
  if (DEBUG_YT_SEEK && initialTime > 0) {
    console.info("[watchy:yt-seek] emit", { video: state.video, videoTS: state.videoTS, hostSeq: state.hostSeq });
  }
  io.emit("REC:host", getHostState());
  io.emit("REC:tsMap", state.tsMap);
  if (initialTime > 0) {
    io.emit("REC:seek", initialTime);
  }
  if (clientId && previousVideo !== cleanUrl) {
    addSystemChat(
      clientId,
      cleanUrl ? `switched video to: ${label || mediaNameFromUrl(cleanUrl)}` : "cleared the video",
    );
  }
}

function recordYouTubeHistory(url: string, label?: string) {
  const id = parseInternalYouTubeId(url);
  if (!id) {
    return;
  }
  const title = label?.replace(/\s+@\s+\d{1,2}:\d{2}(?::\d{2})?$/, "").trim() || "YouTube video";
  const item: YouTubeHistoryItem = {
    kind: "video",
    id,
    title,
    author: "",
    duration: "",
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
  state.ytHistory = [item, ...state.ytHistory.filter((entry) => entry.id !== id)].slice(0, 40);
}

function playlistNext(clientId?: string) {
  const next = state.playlist.shift();
  io.emit("playlist", state.playlist);
  if (next) {
    setHost(next.url, clientId, next.name);
  } else {
    setHost("", clientId);
  }
}

function makePlaylistItem(url: string): PlaylistItem | null {
  const cleanUrl = url.trim().slice(0, 4000);
  if (!isAllowedMediaUrl(cleanUrl)) {
    return null;
  }
  return {
    url: cleanUrl,
    name: mediaNameFromUrl(cleanUrl),
    duration: 0,
    type: "file",
  };
}

function isAllowedMediaUrl(url: string) {
  // Internal same-origin proxy/manifest paths (e.g. YouTube DASH manifest) are set
  // by the server itself and are trusted.
  if (url.startsWith(`${BASE_PATH}/api/yt/`)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function mediaNameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(parts[parts.length - 1] ?? url);
    return last || url;
  } catch {
    return url;
  }
}

function textValue(value: any): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.simpleText === "string") {
    return value.simpleText;
  }
  if (Array.isArray(value.runs)) {
    return value.runs.map((run: any) => run?.text ?? "").join("");
  }
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean).join(" ");
  }
  return "";
}

function thumbnailUrl(thumbnails: any): string {
  return Array.isArray(thumbnails)
    ? thumbnails[thumbnails.length - 1]?.url ?? thumbnails[0]?.url ?? ""
    : "";
}

function youtubePlaylistResultId(result: any): string | null {
  const id = result?.id ?? (result?.content_type === "PLAYLIST" ? result?.content_id : null);
  return typeof id === "string" && /^[\w-]+$/.test(id) ? id : null;
}

function youtubeResultTitle(result: any): string {
  return textValue(result?.title) || textValue(result?.metadata?.title) || "YouTube playlist";
}

function youtubeResultThumbnail(result: any): string {
  return thumbnailUrl(result?.thumbnails) || thumbnailUrl(result?.content_image?.image?.thumbnails);
}

function addChat(message: ChatMessage) {
  state.chat.push(message);
  state.chat = state.chat.slice(-100);
  io.emit("REC:chat", message);
}

function addSystemChat(clientId: string, msg: string) {
  addChat({
    id: "",
    actorId: clientId,
    name: state.names[clientId] || "Guest",
    msg,
    timestamp: new Date().toISOString(),
    videoTS: state.tsMap[clientId],
  });
}

function syncRoster() {
  const connectedClientIds = new Set<string>();
  for (const [clientId, socketId] of socketByClientId) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket?.connected) {
      connectedClientIds.add(clientId);
    } else {
      socketByClientId.delete(clientId);
      delete state.tsMap[clientId];
    }
  }
  state.roster = Array.from(connectedClientIds)
    .sort((a, b) => (state.names[a] || "Guest").localeCompare(state.names[b] || "Guest"))
    .map((id) => ({ id, name: state.names[id] || "Guest" }));
}

function emitRoster() {
  io.emit("roster", state.roster);
}

function sanitizeClientId(input: unknown) {
  const value = String(input ?? "");
  if (/^[0-9a-f-]{36}$/i.test(value)) {
    return value;
  }
  return crypto.randomUUID();
}

function clampTime(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 7 * 24 * 60 * 60) : 0;
}

function clampPlaybackRate(value: number) {
  return [0.25, 0.5, 1, 1.5, 2].includes(value) ? value : 1;
}

function formatTimestamp(value: number) {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

function normalizeBase(input: string) {
  const withSlash = input.startsWith("/") ? input : `/${input}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}
