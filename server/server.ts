import compression from "compression";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Server, type Socket } from "socket.io";

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
  paused: boolean;
  playbackRate: number;
  loop: boolean;
};

type WatchyState = HostState & {
  playlist: PlaylistItem[];
  chat: ChatMessage[];
  names: Record<string, string>;
  colors: Record<string, string>;
  roster: User[];
  tsMap: Record<string, number>;
};

const state: WatchyState = {
  video: "",
  videoTS: 0,
  paused: true,
  playbackRate: 1,
  loop: false,
  playlist: [],
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

  socket.on("CMD:host", (raw: unknown) => {
    setHost(String(raw ?? ""), clientId);
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

  socket.on("CMD:playlistAdd", (raw: unknown) => {
    const item = makePlaylistItem(String(raw ?? ""));
    if (!item) {
      return;
    }
    state.playlist.push(item);
    io.emit("playlist", state.playlist);
    addSystemChat(clientId, `added to playlist: ${item.name}`);
    if (!state.video) {
      playlistNext(clientId);
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
    paused: state.paused,
    playbackRate: state.playbackRate,
    loop: state.loop,
  };
}

function setHost(url: string, clientId?: string, label?: string) {
  const cleanUrl = url.trim().slice(0, 4000);
  if (cleanUrl && !isAllowedMediaUrl(cleanUrl)) {
    return;
  }
  const previousVideo = state.video;
  state.video = cleanUrl;
  state.videoTS = 0;
  state.paused = !cleanUrl;
  state.playbackRate = 1;
  state.loop = false;
  state.tsMap = {};
  io.emit("REC:host", getHostState());
  io.emit("REC:tsMap", state.tsMap);
  if (clientId && previousVideo !== cleanUrl) {
    addSystemChat(
      clientId,
      cleanUrl ? `switched video to: ${label || mediaNameFromUrl(cleanUrl)}` : "cleared the video",
    );
  }
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
    const last = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? url);
    return last || url;
  } catch {
    return url;
  }
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
