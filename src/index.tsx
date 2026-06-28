import "./index.css";

import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import { chatEmojiCategories, chatEmojiSearchText, chatEmojiShortcodes } from "./emojiData";

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

type SplashReaction = {
  id: string;
  value: string;
  user: string;
  timestamp: number;
};

type YouTubeResult = {
  id: string;
  title: string;
  author: string;
  duration: string;
  thumbnail: string;
};

const basePath = "/watchy";
const apiPath = `${basePath}/api`;
const defaultChatWidth = 266;

type EmojiSuggestion = { code: string; emoji: string };
const shortcodeList = Object.keys(chatEmojiShortcodes).sort();
function lookupEmojiSuggestions(query: string, limit = 8): EmojiSuggestion[] {
  const q = query.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const code of shortcodeList) {
    if (code.startsWith(q)) {
      starts.push(code);
    } else if (code.includes(q)) {
      contains.push(code);
    }
  }
  return [...starts, ...contains].slice(0, limit).map((code) => ({ code, emoji: chatEmojiShortcodes[code] }));
}
const emojiValues = [
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
];
const splashValues = [
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
];

function App() {
  const [sessionState, setSessionState] = useState<"checking" | "locked" | "ready">("checking");

  useEffect(() => {
    fetch(`${apiPath}/session`)
      .then((res) => setSessionState(res.ok ? "ready" : "locked"))
      .catch(() => setSessionState("locked"));
  }, []);

  if (sessionState === "checking") {
    return <div className="center-screen">Loading Watchy...</div>;
  }

  if (sessionState === "locked") {
    return <Login onLogin={() => setSessionState("ready")} />;
  }

  return <WatchRoom />;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const response = await fetch(`${apiPath}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.ok) {
      onLogin();
    } else {
      setError("Wrong password.");
    }
  }

  return (
    <main className="center-screen">
      <form className="login-panel" onSubmit={submit}>
        <h1>Watchy</h1>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
        />
        <button type="submit">Enter</button>
        {error && <div className="error">{error}</div>}
      </form>
    </main>
  );
}

function WatchRoom() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState<HostState>({
    video: "",
    videoTS: 0,
    paused: true,
    playbackRate: 1,
    loop: false,
  });
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [roster, setRoster] = useState<User[]>([]);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [colorMap, setColorMap] = useState<Record<string, string>>({});
  const [tsMap, setTsMap] = useState<Record<string, number>>({});
  const [name, setName] = useState(getStoredName);
  const [nameConfirmed, setNameConfirmed] = useState(Boolean(getCookie("watchy_name")));
  const [nameColor, setNameColor] = useState(localStorage.getItem("watchy-name-color") || "#f5f7f8");
  const [urlInput, setUrlInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [emojiSuggest, setEmojiSuggest] = useState<{
    items: EmojiSuggestion[];
    index: number;
    start: number;
    end: number;
  } | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState(chatEmojiCategories[0].id);
  const [emojiSearch, setEmojiSearch] = useState("");
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaResults, setMediaResults] = useState<MediaEntry[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, MediaEntry[] | undefined>>({});
  const [mediaLoading, setMediaLoading] = useState(false);
  const [ytQuery, setYtQuery] = useState("");
  const [ytResults, setYtResults] = useState<YouTubeResult[]>([]);
  const [ytLoading, setYtLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);
  const [stageSize, setStageSize] = useState<{ width?: number; height?: number }>({});
  const [resumeBlocked, setResumeBlocked] = useState(false);
  const [volume, setVolume] = useState(Number(localStorage.getItem("watchy-volume") ?? "1"));
  const [muted, setMuted] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatWidth, setChatWidth] = useState(Number(localStorage.getItem("watchy-chat-width") ?? String(defaultChatWidth)));
  const [rosterOpen, setRosterOpen] = useState(false);
  const [renamingUser, setRenamingUser] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isTheater, setIsTheater] = useState(false);
  const [autoTheaterAttempted, setAutoTheaterAttempted] = useState(false);
  const [resumeTheater, setResumeTheater] = useState(getCookie("watchy_resume_theater") !== "0");
  const [splashes, setSplashes] = useState<SplashReaction[]>([]);
  const appShellRef = useRef<HTMLElement | null>(null);
  const watchColumnRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const reactionRowRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const shouldPlayRef = useRef(false);
  const hlsRef = useRef<any>(null);
  const shakaRef = useRef<any>(null);
  const clientId = useMemo(getOrCreateClientId, []);
  const leaderTime = useMemo(() => {
    const values = Object.values(tsMap).filter((value) => Number.isFinite(value));
    return values.length ? Math.max(...values) : host.videoTS;
  }, [host.videoTS, tsMap]);
  const visibleChatEmojis = useMemo(() => {
    const query = emojiSearch.trim().toLowerCase();
    const values = query
      ? chatEmojiCategories.flatMap((category) => category.values)
      : chatEmojiCategories.find((category) => category.id === emojiCategory)?.values ?? chatEmojiCategories[0].values;
    return values.filter((value, index, list) => {
      if (list.indexOf(value) !== index) {
        return false;
      }
      if (!query) {
        return true;
      }
      return `${value} ${chatEmojiSearchText[value] ?? ""}`.toLowerCase().includes(query);
    });
  }, [emojiCategory, emojiSearch]);

  useEffect(() => {
    if (!nameConfirmed) {
      return;
    }
    const nextSocket = io({
      path: `${basePath}/socket.io`,
      transports: ["websocket", "polling"],
      auth: { clientId },
    });
    setSocket(nextSocket);

    nextSocket.on("connect", () => {
      setConnected(true);
      nextSocket.emit("CMD:name", name);
      nextSocket.emit("CMD:color", nameColor);
    });
    nextSocket.on("disconnect", () => setConnected(false));
    nextSocket.on("connect_error", () => setConnected(false));
    nextSocket.on("REC:host", (data: HostState) => setHost(data));
    nextSocket.on("REC:play", () => {
      shouldPlayRef.current = true;
      if (videoRef.current) {
        playWhenReady(videoRef.current);
      }
    });
    nextSocket.on("REC:pause", () => {
      shouldPlayRef.current = false;
      setResumeBlocked(false);
      videoRef.current?.pause();
    });
    nextSocket.on("REC:seek", (time: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
    });
    nextSocket.on("REC:playbackRate", (rate: number) => {
      if (videoRef.current) {
        videoRef.current.playbackRate = rate;
      }
      setHost((prev) => ({ ...prev, playbackRate: rate }));
    });
    nextSocket.on("REC:loop", (loop: boolean) => setHost((prev) => ({ ...prev, loop })));
    nextSocket.on("REC:tsMap", (data: Record<string, number>) => setTsMap(data));
    nextSocket.on("REC:nameMap", (data: Record<string, string>) => setNameMap(data));
    nextSocket.on("REC:colorMap", (data: Record<string, string>) => setColorMap(data));
    nextSocket.on("chatinit", (data: ChatMessage[]) => setChat(data));
    nextSocket.on("REC:chat", (message: ChatMessage) => {
      setChat((prev) => [...prev, message].slice(-100));
    });
    nextSocket.on("playlist", (data: PlaylistItem[]) => setPlaylist(data));
    nextSocket.on("roster", (data: User[]) => setRoster(data));
    nextSocket.on("REC:splashReaction", (data: SplashReaction) => {
      setSplashes((prev) => [...prev, data]);
      window.setTimeout(() => {
        setSplashes((prev) => prev.filter((item) => item.id !== data.id));
      }, 1700);
    });

    return () => {
      nextSocket.close();
    };
  }, [clientId, nameConfirmed]);

  useEffect(() => {
    if (!socket || !nameConfirmed) {
      return;
    }
    localStorage.setItem("watchy-name", name);
    setCookie("watchy_name", name, 3650);
    socket.emit("CMD:name", name);
  }, [name, nameConfirmed, socket]);

  useEffect(() => {
    if (!socket) {
      return;
    }
    localStorage.setItem("watchy-name-color", nameColor);
    socket.emit("CMD:color", nameColor);
  }, [nameColor, socket]);

  useEffect(() => {
    setCookie("watchy_resume_theater", resumeTheater ? "1" : "0", 3650);
  }, [resumeTheater]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    localStorage.setItem("watchy-volume", String(volume));
    video.volume = volume;
  }, [volume]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    loadVideo(video, host.video).then(() => {
      video.loop = host.loop;
      video.playbackRate = host.playbackRate || 1;
      shouldPlayRef.current = Boolean(host.video && !host.paused);
      if (host.videoTS > 0 && Math.abs(video.currentTime - host.videoTS) > 2) {
        video.currentTime = host.videoTS;
      }
      if (host.paused) {
        setResumeBlocked(false);
        video.pause();
      } else {
        playWhenReady(video);
      }
    });

    async function loadVideo(target: HTMLVideoElement, url: string) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (shakaRef.current) {
        await shakaRef.current.destroy().catch(() => undefined);
        shakaRef.current = null;
      }
      target.pause();
      target.removeAttribute("src");
      target.load();
      if (!url) {
        return;
      }
      // YouTube videos are served as a DASH manifest and played via shaka/MSE on
      // the same <video> element, so all sync logic keeps working unchanged.
      if (url.includes("/api/yt/manifest")) {
        const shaka = (await import("shaka-player/dist/shaka-player.compiled.js")).default;
        shaka.polyfill.installAll();
        const player = new shaka.Player();
        shakaRef.current = player;
        await player.attach(target);
        await player.load(url);
        return;
      }
      if (url.toLowerCase().includes(".m3u8") && !target.canPlayType("application/vnd.apple.mpegurl")) {
        const Hls = (await import("hls.js")).default;
        const hls = new Hls();
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(target);
        return;
      }
      target.src = url;
      target.load();
    }
  }, [host.video]);

  useEffect(() => {
    shouldPlayRef.current = Boolean(host.video && !host.paused);
    if (host.paused) {
      setResumeBlocked(false);
      videoRef.current?.pause();
    } else if (videoRef.current && host.video) {
      playWhenReady(videoRef.current);
    }
  }, [host.paused, host.video]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.loop = host.loop;
      video.playbackRate = host.playbackRate || 1;
    }
  }, [host.loop, host.playbackRate]);

  useEffect(() => {
    if (!socket) {
      return;
    }
    const interval = window.setInterval(() => {
      if (videoRef.current && host.video) {
        socket.emit("CMD:ts", videoRef.current.currentTime);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [socket, host.video]);

  useEffect(() => {
    const updateStageSize = () => {
      const column = watchColumnRef.current;
      if (!column || !host.video) {
        setStageSize({});
        return;
      }
      const styles = window.getComputedStyle(column);
      const paddingX = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      const paddingY = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
      const gap = Number.parseFloat(styles.rowGap) || 0;
      const contentWidth = Math.max(0, column.clientWidth - paddingX);
      const controlsHeight = controlsRef.current?.getBoundingClientRect().height ?? 0;
      const reactionsHeight = reactionRowRef.current?.getBoundingClientRect().height ?? 0;
      const isFullscreen = Boolean(document.fullscreenElement);
      const mediaReserve = isFullscreen ? 0 : 96;
      const rowCount = isFullscreen ? 3 : controlsHeight > 0 ? 4 : 3;
      // In normal (windowed) mode, the column is sized to 100vh which can extend
      // under the OS taskbar/status bar, hiding the bottom controls. Bound the
      // stage by the actually-visible viewport and keep a small safe margin so
      // the controls stay on screen (shrinking the video to fit).
      const columnTop = column.getBoundingClientRect().top;
      const safeBottom = isFullscreen ? 0 : 24;
      const availableHeight = isFullscreen
        ? column.clientHeight
        : Math.min(column.clientHeight, window.innerHeight - columnTop - safeBottom);
      const maxStageHeight = Math.max(
        160,
        availableHeight - paddingY - controlsHeight - reactionsHeight - mediaReserve - gap * (rowCount - 1),
      );
      const ratio = Number.isFinite(videoAspectRatio) && videoAspectRatio > 0 ? videoAspectRatio : 16 / 9;
      const width = Math.min(contentWidth, maxStageHeight * ratio);
      const height = width / ratio;
      setStageSize({
        width: Math.max(160, Math.floor(width)),
        height: Math.max(120, Math.floor(height)),
      });
    };

    updateStageSize();
    const observer = new ResizeObserver(updateStageSize);
    if (watchColumnRef.current) {
      observer.observe(watchColumnRef.current);
    }
    if (controlsRef.current) {
      observer.observe(controlsRef.current);
    }
    if (reactionRowRef.current) {
      observer.observe(reactionRowRef.current);
    }
    window.addEventListener("resize", updateStageSize);
    document.addEventListener("fullscreenchange", updateStageSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateStageSize);
      document.removeEventListener("fullscreenchange", updateStageSize);
    };
  }, [host.video, videoAspectRatio]);

  useEffect(() => {
    const updateTheaterState = () => setIsTheater(Boolean(document.fullscreenElement));
    updateTheaterState();
    document.addEventListener("fullscreenchange", updateTheaterState);
    return () => document.removeEventListener("fullscreenchange", updateTheaterState);
  }, []);

  useEffect(() => {
    if (!nameConfirmed || autoTheaterAttempted || document.fullscreenElement) {
      return;
    }
    setAutoTheaterAttempted(true);
    window.setTimeout(() => {
      appShellRef.current?.requestFullscreen().catch(() => undefined);
    }, 250);
  }, [autoTheaterAttempted, nameConfirmed]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setMediaLoading(true);
      try {
        const response = await fetch(`${apiPath}/media?q=${encodeURIComponent(mediaQuery)}`, {
          signal: controller.signal,
        });
        if (response.ok) {
          setMediaResults(await response.json());
        }
      } finally {
        setMediaLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [mediaQuery]);

  useEffect(() => {
    const query = ytQuery.trim();
    if (!query) {
      setYtResults([]);
      setYtLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setYtLoading(true);
      try {
        const response = await fetch(`${apiPath}/yt/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (response.ok) {
          setYtResults(await response.json());
        }
      } catch {
        // aborted or failed; ignore
      } finally {
        setYtLoading(false);
      }
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [ytQuery]);

  async function toggleFolder(path: string) {
    if (expandedFolders[path]) {
      setExpandedFolders((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      return;
    }
    const response = await fetch(`${apiPath}/media?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      return;
    }
    const entries = await response.json();
    setExpandedFolders((prev) => ({ ...prev, [path]: entries }));
  }

  function playUrl(url: string) {
    socket?.emit("CMD:host", url);
  }

  function addToPlaylist(url: string) {
    socket?.emit("CMD:playlistAdd", url);
  }

  function submitUrl(event: FormEvent) {
    event.preventDefault();
    const value = urlInput.trim();
    if (!value) {
      return;
    }
    playUrl(value);
  }

  function submitChat(event: FormEvent) {
    event.preventDefault();
    if (!chatInput.trim()) {
      return;
    }
    if (editingMessage) {
      socket?.emit("CMD:editChat", {
        timestamp: editingMessage.timestamp,
        msg: chatInput,
      });
      setEditingMessage(null);
    } else {
      socket?.emit("CMD:chat", {
        msg: chatInput,
        replyToTimestamp: replyingTo?.timestamp,
      });
      setReplyingTo(null);
    }
    setChatInput("");
    setEmojiPickerOpen(false);
    scrollChatToBottom();
  }

  function submitName(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      return;
    }
    setName(cleanName);
    localStorage.setItem("watchy-name", cleanName);
    setCookie("watchy_name", cleanName, 3650);
    setNameConfirmed(true);
  }

  function startEditing(message: ChatMessage) {
    setEditingMessage(message);
    setReplyingTo(null);
    setChatInput(message.msg);
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }

  function cancelEditing() {
    setEditingMessage(null);
    setChatInput("");
  }

  function startReply(message: ChatMessage) {
    setReplyingTo(message);
    setEditingMessage(null);
    setChatInput("");
    scrollChatToBottom();
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }

  function cancelReply() {
    setReplyingTo(null);
  }

  function addChatEmoji(value: string) {
    setChatInput((current) => `${current}${value}`);
    scrollChatToBottom();
  }

  function handleChatInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setChatInput(value);
    const caret = event.target.selectionStart ?? value.length;
    const match = /(?:^|\s):([a-zA-Z0-9_+-]{1,})$/.exec(value.slice(0, caret));
    if (match) {
      const items = lookupEmojiSuggestions(match[1]);
      if (items.length) {
        setEmojiSuggest({ items, index: 0, start: caret - match[1].length - 1, end: caret });
        return;
      }
    }
    setEmojiSuggest(null);
  }

  function applyEmojiSuggestion(item: EmojiSuggestion) {
    if (!emojiSuggest) {
      return;
    }
    const { start, end } = emojiSuggest;
    const next = `${chatInput.slice(0, start)}${item.emoji} ${chatInput.slice(end)}`;
    setChatInput(next);
    setEmojiSuggest(null);
    const caret = start + item.emoji.length + 1;
    requestAnimationFrame(() => {
      const el = chatInputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function handleChatInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!emojiSuggest) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setEmojiSuggest((s) => s && { ...s, index: (s.index + 1) % s.items.length });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setEmojiSuggest((s) => s && { ...s, index: (s.index - 1 + s.items.length) % s.items.length });
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      applyEmojiSuggestion(emojiSuggest.items[emojiSuggest.index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEmojiSuggest(null);
    }
  }

  function startRenameUser(user: User) {
    setRenamingUser(user.id);
    setRenameValue(nameMap[user.id] || user.name);
  }

  function submitRenameUser(event: FormEvent) {
    event.preventDefault();
    const name = renameValue.trim();
    if (renamingUser && name) {
      if (renamingUser === clientId) {
        setName(name);
        localStorage.setItem("watchy-name", name);
        setCookie("watchy_name", name, 3650);
        socket?.emit("CMD:name", name);
      } else {
        socket?.emit("CMD:renameUser", { id: renamingUser, name });
      }
    }
    setRenamingUser(null);
    setRenameValue("");
  }

  function toggleMessageReaction(message: ChatMessage, value: string) {
    socket?.emit("CMD:messageReaction", {
      timestamp: message.timestamp,
      value,
    });
    setReactionPickerFor(null);
    scrollChatToBottom();
  }

  function togglePlay() {
    if (!socket || !host.video) {
      return;
    }
    if (videoRef.current?.paused) {
      socket.emit("CMD:play");
    } else {
      socket.emit("CMD:pause");
    }
  }

  function seek(value: number) {
    socket?.emit("CMD:seek", value);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!socket || !host.video) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const current = videoRef.current?.currentTime ?? 0;
        seek(Math.max(0, current - 5));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const current = videoRef.current?.currentTime ?? 0;
        const max = videoRef.current?.duration || duration || Infinity;
        seek(Math.min(max, current + 5));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [socket, host.video, duration]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat]);

  function scrollChatToBottom() {
    stickToBottomRef.current = true;
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  function syncToLeader() {
    if (videoRef.current) {
      videoRef.current.currentTime = leaderTime;
      if (!host.paused) {
        videoRef.current.play().catch(() => undefined);
      }
    }
  }

  function skipNext() {
    socket?.emit("CMD:playlistNext");
  }

  function toggleTheater() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
      return;
    }
    appShellRef.current?.requestFullscreen().catch(() => undefined);
  }

  function updateVideoMetrics(target: HTMLVideoElement) {
    setDuration(target.duration || 0);
    if (target.videoWidth > 0 && target.videoHeight > 0) {
      setVideoAspectRatio(target.videoWidth / target.videoHeight);
    }
    playWhenReady(target);
  }

  function playWhenReady(target: HTMLVideoElement) {
    const attemptPlay = () => {
      if (shouldPlayRef.current && target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        target
          .play()
          .then(() => setResumeBlocked(false))
          .catch(() => {
            if (shouldPlayRef.current) {
              setResumeBlocked(true);
            }
          });
      }
    };
    attemptPlay();
    [80, 200, 500, 1000, 1800, 3000, 5000].forEach((delay) => window.setTimeout(attemptPlay, delay));
  }

  function resumePlayback() {
    shouldPlayRef.current = true;
    if (resumeTheater && !document.fullscreenElement) {
      appShellRef.current?.requestFullscreen().catch(() => undefined);
    }
    videoRef.current
      ?.play()
      .then(() => setResumeBlocked(false))
      .catch(() => setResumeBlocked(true));
  }

  function startChatResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatWidth;
    let latestWidth = startWidth;
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestWidth = Math.max(180, Math.min(520, startWidth + startX - moveEvent.clientX));
      setChatWidth(latestWidth);
    };
    const onPointerUp = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      localStorage.setItem("watchy-chat-width", String(Math.round(latestWidth)));
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }

  function resetChatWidth() {
    setChatWidth(defaultChatWidth);
    localStorage.setItem("watchy-chat-width", String(defaultChatWidth));
  }

  return (
    <main
      className={`app-shell ${host.video ? "has-video" : "no-video"} ${playlistOpen ? "playlist-open" : ""} ${
        chatOpen ? "chat-open" : "chat-collapsed"
      }`}
      style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
      ref={appShellRef}
    >
      <section className="watch-column" ref={watchColumnRef}>
        <div
          className="stage"
          style={
            {
              "--video-aspect-ratio": String(videoAspectRatio),
              width: stageSize.width ? `${stageSize.width}px` : undefined,
              height: stageSize.height ? `${stageSize.height}px` : undefined,
            } as React.CSSProperties
          }
        >
          {!host.video && <div className="empty-state">Pick something to watch.</div>}
          <video
            ref={videoRef}
            className="video"
            autoPlay={!host.paused}
            playsInline
            onClick={togglePlay}
            onTimeUpdate={(event) => {
              setCurrentTime(event.currentTarget.currentTime);
              if (shouldPlayRef.current && event.currentTarget.paused) {
                playWhenReady(event.currentTarget);
              }
            }}
            onLoadedMetadata={(event) => updateVideoMetrics(event.currentTarget)}
            onDurationChange={(event) => updateVideoMetrics(event.currentTarget)}
            onCanPlay={(event) => playWhenReady(event.currentTarget)}
            onEnded={skipNext}
            muted={muted}
          />
          {resumeBlocked && host.video && !host.paused && (
            <div className="resume-overlay">
              <div className="resume-panel">
                <button type="button" className="resume-button" onClick={resumePlayback}>
                  Resume
                </button>
                <label className="resume-theater">
                  <input
                    type="checkbox"
                    checked={resumeTheater}
                    onChange={(event) => setResumeTheater(event.target.checked)}
                  />
                  <span>Theater</span>
                </label>
              </div>
            </div>
          )}
          <div className="splash-layer">
            {splashes.map((splash) => (
              <span key={splash.id} className="splash" style={splashStyle(splash, colorMap[splash.user])}>
                {splash.value}
              </span>
            ))}
          </div>
        </div>

        {host.video && (
          <div className="controls" ref={controlsRef}>
            <button type="button" onClick={togglePlay}>
              {host.paused ? "Play" : "Pause"}
            </button>
            <button type="button" onClick={syncToLeader}>
              Sync
            </button>
            <button type="button" onClick={skipNext} disabled={!playlist.length}>
              Next
            </button>
            <button type="button" className={playlistOpen ? "active" : ""} onClick={() => setPlaylistOpen((prev) => !prev)}>
              Playlist ({playlist.length})
            </button>
            <span className="time">{formatTimestamp(currentTime)}</span>
            <input
              className="timeline"
              type="range"
              min={0}
              max={Number.isFinite(duration) && duration > 0 ? duration : Math.max(currentTime, leaderTime, 1)}
              step={0.1}
              value={Math.min(currentTime, Number.isFinite(duration) && duration > 0 ? duration : Math.max(currentTime, 1))}
              onChange={(event) => seek(Number(event.target.value))}
            />
            <span className="time">{formatTimestamp(duration)}</span>
            <select value={host.playbackRate} onChange={(event) => socket?.emit("CMD:playbackRate", Number(event.target.value))}>
              {[0.25, 0.5, 1, 1.5, 2].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}x
                </option>
              ))}
            </select>
            <button type="button" className={host.loop ? "active" : ""} onClick={() => socket?.emit("CMD:loop", !host.loop)}>
              Loop
            </button>
            <button type="button" onClick={() => setMuted((prev) => !prev)}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
            <button type="button" className="theater-button" onClick={toggleTheater}>
              {isTheater ? "Exit" : "Theater"}
            </button>
          </div>
        )}

        <div
          className="reaction-row"
          ref={reactionRowRef}
          style={{ "--reaction-count": splashValues.length } as React.CSSProperties}
        >
          {splashValues.map((value) => (
            <button key={value} type="button" className="reaction-button" onClick={() => socket?.emit("CMD:splashReaction", value)}>
              {value}
            </button>
          ))}
        </div>

        <section className="media-panel">
          <form className="url-row" onSubmit={submitUrl}>
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="Paste a direct video URL"
            />
            <button type="submit">Watch</button>
            <button type="button" onClick={() => addToPlaylist(urlInput.trim())} disabled={!urlInput.trim()}>
              Queue
            </button>
          </form>
          <div className="section-title">YouTube</div>
          <input
            value={ytQuery}
            onChange={(event) => setYtQuery(event.target.value)}
            placeholder="Search YouTube"
          />
          {(ytLoading || ytResults.length > 0) && (
            <div className="yt-list">
              {ytLoading && <div className="muted">Searching...</div>}
              {ytResults.map((result) => {
                const watchUrl = `https://www.youtube.com/watch?v=${result.id}`;
                return (
                  <div className="yt-item" key={result.id}>
                    {result.thumbnail && <img className="yt-thumb" src={result.thumbnail} alt="" loading="lazy" />}
                    <div className="yt-meta">
                      <span className="yt-title" title={result.title}>
                        {result.title}
                      </span>
                      <span className="yt-sub">
                        {result.author}
                        {result.duration ? ` · ${result.duration}` : ""}
                      </span>
                      <div className="yt-actions">
                        <button type="button" onClick={() => playUrl(watchUrl)}>
                          Watch
                        </button>
                        <button type="button" onClick={() => addToPlaylist(watchUrl)}>
                          Queue
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="section-title">Local media</div>
          <input
            value={mediaQuery}
            onChange={(event) => setMediaQuery(event.target.value)}
            placeholder="Search local media"
          />
          <div className="media-list">
            {mediaLoading && <div className="muted">Searching...</div>}
            {mediaResults.map((item) => (
              <MediaEntryRow
                key={item.type === "directory" ? item.path : item.url}
                item={item}
                level={0}
                expandedFolders={expandedFolders}
                toggleFolder={toggleFolder}
                playUrl={playUrl}
                addToPlaylist={addToPlaylist}
              />
            ))}
          </div>
        </section>
      </section>

      <aside className="side-column">
        {chatOpen && (
          <div
            className="chat-resize-handle"
            onDoubleClick={resetChatWidth}
            onPointerDown={startChatResize}
            title="Drag to resize chat. Double-click to reset."
          />
        )}
        <button
          type="button"
          className="chat-toggle"
          onClick={() => setChatOpen((open) => !open)}
          title={chatOpen ? "Hide chat" : "Show chat"}
        >
          {chatOpen ? "\u203A" : "\u2039"}
        </button>

        {chatOpen && (
          <>
        {!nameConfirmed && (
          <div className="name-gate" role="dialog" aria-modal="true" aria-label="Choose a username">
            <form className="name-gate-panel" onSubmit={submitName}>
              <div className="section-title">Choose a name</div>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Username"
                maxLength={40}
              />
              <button type="submit" disabled={!name.trim()}>
                Continue
              </button>
            </form>
          </div>
        )}

        <label className="name-field">
          <span>Name</span>
          <div className="name-row">
            <input value={name} onChange={(event) => setName(event.target.value)} />
            <input
              className="name-color"
              type="color"
              value={nameColor}
              onChange={(event) => setNameColor(event.target.value)}
              title="Name color"
            />
          </div>
        </label>

        {playlistOpen && (
          <section className="playlist">
            <div className="section-title">Playlist ({playlist.length})</div>
            {playlist.length === 0 && <div className="muted">No queued videos.</div>}
            {playlist.map((item, index) => (
              <div className="playlist-item" key={`${item.url}-${index}`}>
                <button type="button" onClick={() => socket?.emit("CMD:host", item.url)}>
                  Play
                </button>
                <button type="button" onClick={() => socket?.emit("CMD:playlistMove", { index, toIndex: 0 })}>
                  Top
                </button>
                <button type="button" onClick={() => socket?.emit("CMD:playlistDelete", index)}>
                  X
                </button>
                <span title={item.name}>{item.name}</span>
              </div>
            ))}
          </section>
        )}

        <section className="chat">
          <div className="chat-heading">
            <button type="button" className="section-title chat-title-button" onClick={() => setRosterOpen((open) => !open)}>
              Chat ({roster.length} watching{connected ? "" : ", reconnecting"})
              <span>{rosterOpen ? "\u25BE" : "\u25B8"}</span>
            </button>
            {rosterOpen && (
              <div className="roster-list">
                {roster.length === 0 && <div className="muted">No one is connected.</div>}
                {roster.map((user) => (
                  <div className="roster-item" key={user.id}>
                    <span className="roster-dot" style={{ background: colorMap[user.id] || "#8d989f" }} />
                    {renamingUser === user.id ? (
                      <form className="roster-rename" onSubmit={submitRenameUser}>
                        <input
                          autoFocus
                          value={renameValue}
                          maxLength={40}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onBlur={() => setRenamingUser(null)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setRenamingUser(null);
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <>
                        <span className="roster-name">{nameMap[user.id] || user.name}</span>
                        <button
                          type="button"
                          className="icon-button roster-rename-button"
                          title="Rename"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => startRenameUser(user)}
                        >
                          {"✎"}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            className="messages"
            ref={messagesRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            {chat.map((message) => (
              <div className={message.id ? "message" : "message system"} key={`${message.timestamp}-${message.id}-${message.msg}`}>
                <div className="message-meta">
                  <strong style={{ color: colorMap[message.id || message.actorId || ""] || undefined }}>
                    {nameMap[message.id || message.actorId || ""] || message.name}
                  </strong>
                  <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
                  {message.videoTS != null && <span>@ {formatTimestamp(message.videoTS)}</span>}
                  {message.editedAt && <span>edited</span>}
                  {message.id && (
                    <div className="message-title-actions">
                      <button type="button" className="icon-button" onClick={() => startReply(message)} title="Reply">
                        {"\u21A9"}
                      </button>
                      {message.id === clientId && (
                        <button type="button" className="icon-button" onClick={() => startEditing(message)} title="Edit">
                          {"\u270E"}
                        </button>
                      )}
                      <button
                        type="button"
                        className={`icon-button ${reactionPickerFor === message.timestamp ? "active" : ""}`}
                        onClick={() => setReactionPickerFor((current) => (current === message.timestamp ? null : message.timestamp))}
                        title="React"
                      >
                        {"\u263A"}
                      </button>
                    </div>
                  )}
                </div>
                {message.replyToMsg && (
                  <div className="reply-quote">
                    <strong style={{ color: message.replyToId ? colorMap[message.replyToId] : undefined }}>
                      {message.replyToName || "Someone"}
                    </strong>
                    <span>{renderMarkdown(message.replyToMsg)}</span>
                  </div>
                )}
                <div className="message-body">{renderMarkdown(message.msg)}</div>
                {message.id && (
                  <>
                    {Object.entries(message.reactions ?? {}).length > 0 && (
                      <div className="message-reaction-summary" aria-label="Message reactions">
                        {Object.entries(message.reactions ?? {}).map(([value, users]) => (
                          <button
                            key={value}
                            type="button"
                            className={`reaction-chip ${users.includes(clientId) ? "active" : ""}`}
                            onClick={() => toggleMessageReaction(message, value)}
                            title="Toggle reaction"
                          >
                            <span>{value}</span>
                            <span>{users.length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {reactionPickerFor === message.timestamp && (
                      <div className="message-emoji-picker">
                        {emojiValues.map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={message.reactions?.[value]?.includes(clientId) ? "active" : ""}
                            onClick={() => toggleMessageReaction(message, value)}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          {replyingTo && (
            <div className="editing-row">
              Replying to {nameMap[replyingTo.id] || replyingTo.name || "message"}: {truncate(replyingTo.msg, 42)}
              <button type="button" className="link-button" onClick={cancelReply}>
                Cancel
              </button>
            </div>
          )}
          {editingMessage && (
            <div className="editing-row">
              Editing sent message
              <button type="button" className="link-button" onClick={cancelEditing}>
                Cancel
              </button>
            </div>
          )}
          {emojiPickerOpen && (
            <div className="emoji-picker">
              <input
                className="emoji-search"
                value={emojiSearch}
                onChange={(event) => setEmojiSearch(event.target.value)}
                placeholder="Search emoji"
              />
              <div className="emoji-categories">
                {chatEmojiCategories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={!emojiSearch && emojiCategory === category.id ? "active" : ""}
                    title={category.label}
                    aria-label={category.label}
                    onClick={() => {
                      setEmojiCategory(category.id);
                      setEmojiSearch("");
                    }}
                  >
                    {category.icon}
                  </button>
                ))}
              </div>
              <div className="emoji-grid">
                {visibleChatEmojis.length === 0 && <div className="muted">No emoji found.</div>}
                {visibleChatEmojis.map((value) => (
                  <button key={value} type="button" onClick={() => addChatEmoji(value)}>
                    {value}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="chat-input-wrap">
            {emojiSuggest && (
              <div className="emoji-suggest">
                {emojiSuggest.items.map((item, i) => (
                  <button
                    type="button"
                    key={item.code}
                    className={i === emojiSuggest.index ? "active" : ""}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyEmojiSuggestion(item);
                    }}
                  >
                    <span className="se">{item.emoji}</span>
                    <span className="sc">:{item.code}:</span>
                  </button>
                ))}
              </div>
            )}
            <form className="chat-form" onSubmit={submitChat}>
              <button
                type="button"
                className={emojiPickerOpen ? "active" : ""}
                onClick={() => setEmojiPickerOpen((open) => !open)}
                title="Emoji"
              >
                {"\u{1F600}"}
              </button>
              <input
                ref={chatInputRef}
                value={chatInput}
                onChange={handleChatInputChange}
                onKeyDown={handleChatInputKeyDown}
                onBlur={() => setEmojiSuggest(null)}
                placeholder="Message..."
              />
              <button type="submit">{editingMessage ? "Save" : "Send"}</button>
            </form>
          </div>
        </section>
          </>
        )}
      </aside>
    </main>
  );
}

function renderMarkdown(input: string): React.ReactNode[] {
  const lines = input.split("\n");
  const bulletPattern = /^\s*[-*]\s+(.*)$/;
  const orderedPattern = /^\s*\d+[.)]\s+(.*)$/;
  const headerPattern = /^(#{1,3})\s+(.*)$/;
  const subtextPattern = /^-#\s+(.*)$/;
  const quotePattern = /^>\s?(.*)$/;
  const fencePattern = /^```/;

  const blocks: React.ReactNode[] = [];
  let para: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let listType: "ul" | "ol" | null = null;
  let blockKey = 0;

  const flushPara = () => {
    if (para.length) {
      blocks.push(<span key={`p-${blockKey++}`}>{para}</span>);
      para = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      const items = listItems;
      blocks.push(
        listType === "ol" ? (
          <ol key={`l-${blockKey++}`} className="chat-list">
            {items}
          </ol>
        ) : (
          <ul key={`l-${blockKey++}`} className="chat-list">
            {items}
          </ul>
        ),
      );
      listItems = [];
      listType = null;
    }
  };
  const flushBlocks = () => {
    flushPara();
    flushList();
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    // Fenced code block: ```optional-lang ... ```
    if (fencePattern.test(line.trim())) {
      flushBlocks();
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !fencePattern.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index++;
      }
      blocks.push(
        <pre key={`code-${blockKey++}`} className="chat-codeblock">
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Blockquote: group consecutive `> ` (or `>>> `) lines.
    const tripleQuote = line.startsWith(">>> ");
    if (tripleQuote || quotePattern.test(line)) {
      flushBlocks();
      const quoteLines: React.ReactNode[] = [];
      if (tripleQuote) {
        // `>>> ` quotes everything that follows.
        const first = line.slice(4);
        quoteLines.push(...renderMarkdownLine(first, `q-${index}`));
        index++;
        while (index < lines.length) {
          quoteLines.push(<br key={`qbr-${index}`} />, ...renderMarkdownLine(lines[index], `q-${index}`));
          index++;
        }
      } else {
        let first = true;
        while (index < lines.length && quotePattern.test(lines[index])) {
          const content = quotePattern.exec(lines[index])![1];
          if (!first) {
            quoteLines.push(<br key={`qbr-${index}`} />);
          }
          quoteLines.push(...renderMarkdownLine(content, `q-${index}`));
          first = false;
          index++;
        }
        index--; // for-loop will increment
      }
      blocks.push(
        <blockquote key={`quote-${blockKey++}`} className="chat-quote">
          {quoteLines}
        </blockquote>,
      );
      continue;
    }

    const subtext = subtextPattern.exec(line);
    const header = headerPattern.exec(line);
    const bullet = bulletPattern.exec(line);
    const ordered = orderedPattern.exec(line);

    if (subtext) {
      flushBlocks();
      blocks.push(
        <div key={`sub-${blockKey++}`} className="chat-subtext">
          {renderMarkdownLine(subtext[1], `sub-${index}`)}
        </div>,
      );
    } else if (header) {
      flushBlocks();
      const level = header[1].length;
      blocks.push(
        <div key={`h-${blockKey++}`} className={`chat-h${level}`}>
          {renderMarkdownLine(header[2], `h-${index}`)}
        </div>,
      );
    } else if (bullet || ordered) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (listType && listType !== type) {
        flushList();
      }
      listType = type;
      const content = bullet ? bullet[1] : ordered![1];
      listItems.push(<li key={`li-${index}`}>{renderMarkdownLine(content, `li-${index}`)}</li>);
    } else {
      flushList();
      if (para.length) {
        para.push(<br key={`br-${index}`} />);
      }
      para.push(...renderMarkdownLine(line, `line-${index}`));
    }
  }
  flushBlocks();
  return blocks;
}

function renderMarkdownLine(input: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Ordered by precedence: longer delimiters first so e.g. *** is not eaten by **.
  const tokenPattern = new RegExp(
    [
      "\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)", // [text](url)
      "(https?:\\/\\/[^\\s<]+)", // bare url
      "`([^`]+)`", // `code`
      "\\*\\*\\*([\\s\\S]+?)\\*\\*\\*", // ***bold italic***
      "\\*\\*([\\s\\S]+?)\\*\\*", // **bold**
      "__([\\s\\S]+?)__", // __underline__
      "~~([\\s\\S]+?)~~", // ~~strikethrough~~
      "\\|\\|([\\s\\S]+?)\\|\\|", // ||spoiler||
      "\\*([\\s\\S]+?)\\*", // *italic*
      "_([\\s\\S]+?)_", // _italic_
      ":([a-zA-Z0-9_+-]+):", // :shortcode:
    ].join("|"),
    "g",
  );
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input))) {
    if (match.index > cursor) {
      nodes.push(input.slice(cursor, match.index));
    }
    const [
      raw,
      linkText,
      linkUrl,
      bareUrl,
      codeText,
      boldItalic,
      bold,
      underline,
      strike,
      spoiler,
      italicStar,
      italicUnderscore,
      shortcode,
    ] = match;
    const key = `${keyPrefix}-${match.index}`;
    const inner = (text: string) => renderMarkdownLine(text, key);
    if (linkUrl && linkText) {
      nodes.push(
        <a key={key} href={linkUrl} target="_blank" rel="noreferrer">
          {linkText}
        </a>,
      );
    } else if (bareUrl) {
      nodes.push(
        <a key={key} href={bareUrl} target="_blank" rel="noreferrer">
          {bareUrl}
        </a>,
      );
    } else if (codeText) {
      nodes.push(<code key={key}>{codeText}</code>);
    } else if (boldItalic) {
      nodes.push(
        <strong key={key}>
          <em>{inner(boldItalic)}</em>
        </strong>,
      );
    } else if (bold) {
      nodes.push(<strong key={key}>{inner(bold)}</strong>);
    } else if (underline) {
      nodes.push(<u key={key}>{inner(underline)}</u>);
    } else if (strike) {
      nodes.push(<s key={key}>{inner(strike)}</s>);
    } else if (spoiler) {
      nodes.push(
        <span
          key={key}
          className="spoiler"
          role="button"
          tabIndex={0}
          onClick={(event) => event.currentTarget.classList.add("revealed")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.currentTarget.classList.add("revealed");
            }
          }}
        >
          {inner(spoiler)}
        </span>,
      );
    } else if (italicStar || italicUnderscore) {
      nodes.push(<em key={key}>{inner(italicStar || italicUnderscore)}</em>);
    } else if (shortcode) {
      const emoji = chatEmojiShortcodes[shortcode.toLowerCase()];
      nodes.push(emoji ?? raw);
    }
    cursor = match.index + raw.length;
  }
  if (cursor < input.length) {
    nodes.push(input.slice(cursor));
  }
  return nodes;
}

function MediaEntryRow({
  item,
  level,
  expandedFolders,
  toggleFolder,
  playUrl,
  addToPlaylist,
}: {
  item: MediaEntry;
  level: number;
  expandedFolders: Record<string, MediaEntry[] | undefined>;
  toggleFolder: (path: string) => void;
  playUrl: (url: string) => void;
  addToPlaylist: (url: string) => void;
}) {
  if (item.type === "directory") {
    const children = expandedFolders[item.path];
    const isExpanded = Boolean(children);
    return (
      <div className="media-folder-group">
        <button
          type="button"
          className="media-folder"
          style={{ paddingLeft: 10 + level * 16 }}
          onClick={() => toggleFolder(item.path)}
        >
          <span className="folder-caret">{isExpanded ? "▾" : "▸"}</span>
          <span title={item.path}>{item.name}</span>
        </button>
        {children?.map((child) => (
          <MediaEntryRow
            key={child.type === "directory" ? child.path : child.url}
            item={child}
            level={level + 1}
            expandedFolders={expandedFolders}
            toggleFolder={toggleFolder}
            playUrl={playUrl}
            addToPlaylist={addToPlaylist}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="media-item" style={{ paddingLeft: level * 16 }} key={item.url}>
      <button type="button" onClick={() => playUrl(item.url)}>
        Play
      </button>
      <button type="button" onClick={() => addToPlaylist(item.url)}>
        Queue
      </button>
      <span title={item.name}>{item.name.split("/").at(-1) || item.name}</span>
    </div>
  );
}

function getOrCreateClientId() {
  let id = localStorage.getItem("watchy-client-id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem("watchy-client-id", id);
  }
  return id;
}

function getStoredName() {
  return getCookie("watchy_name");
}

function getCookie(name: string) {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function setCookie(name: string, value: string, days: number) {
  const maxAge = Math.max(0, Math.floor(days * 24 * 60 * 60));
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${basePath}; SameSite=Lax; Secure`;
}

function formatTimestamp(input: number) {
  if (!Number.isFinite(input)) {
    return "LIVE";
  }
  const total = Math.max(0, Math.floor(input));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

function truncate(input: string, max: number) {
  return input.length > max ? `${input.slice(0, max)}...` : input;
}

function splashStyle(splash: SplashReaction, color?: string): React.CSSProperties {
  const seed = Array.from(splash.id).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    left: `${8 + (seed % 76)}%`,
    top: `${10 + ((seed * 7) % 66)}%`,
    "--splash-color": color || "#f5f7f8",
  } as React.CSSProperties;
}

createRoot(document.getElementById("root")!).render(<App />);
