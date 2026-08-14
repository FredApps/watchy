// Troll: an AI watch-along companion backed by the OpenClaw gateway.
//
// It samples the playing video with ffmpeg every FRAME_INTERVAL_MS, keeps a
// short rolling buffer of frames, and posts a chat comment every 5-10 minutes.
// Users can also @mention it for an off-schedule reply.
//
// Everything runs server-side so Troll works with no browser open and every
// viewer sees the same comment.
import { execFile } from "node:child_process";
import path from "node:path";

// Read lazily, never at module scope: ES imports are evaluated before the
// importing module's body, so server.ts has not called loadEnvFile() yet when
// this module is first evaluated. Reading env here would always see it empty.
function config() {
  return {
    url: (process.env.OPENCLAW_URL ?? "https://claw.ayrien.se").replace(/\/+$/, ""),
    token: process.env.OPENCLAW_TOKEN ?? "",
    model: process.env.OPENCLAW_MODEL ?? "openclaw",
    discordChannel: process.env.OPENCLAW_DISCORD_CHANNEL ?? "",
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    sessionKey: resolveSessionKey(),
  };
}

// Without an explicit session key the gateway mints a fresh random session per
// request, so Troll would remember nothing between comments. Joining the
// channel's own session key is what gives it continuity with Discord.
function resolveSessionKey() {
  const explicit = process.env.OPENCLAW_SESSION_KEY?.trim();
  if (explicit) {
    return explicit;
  }
  const channel = process.env.OPENCLAW_DISCORD_CHANNEL?.trim();
  return channel ? `agent:main:discord:channel:${channel}` : "";
}

const FRAME_INTERVAL_MS = 10_000;
const TICK_INTERVAL_MS = 30_000;
const MIN_COMMENT_GAP_MS = 5 * 60_000;
const MAX_COMMENT_GAP_MS = 10 * 60_000;
// The model overshoots length instructions, so the cap is enforced in code.
const MAX_COMMENT_CHARS = 160;
const FRAME_BUFFER_SIZE = 6;
// The gateway rejects more than 8 image parts per request (and 20 MB total);
// frames are ~11 KB each, so the real cost of more frames is latency.
const FRAMES_PER_REQUEST = 3;
// Reasoning eats a chunk of the budget before any prose appears; 80 tokens came
// back empty with finish_reason "length" during testing.
const MAX_TOKENS = 600;
const REQUEST_TIMEOUT_MS = 90_000;

export const TROLL_ID = "troll-openclaw";
export const DEFAULT_TROLL_NAME = "Troll";

export type TrollState = {
  /** False while muted by `pause`; `resume` brings it back. */
  active: boolean;
  name: string;
  /** No gateway token means Troll cannot run at all. */
  configured: boolean;
};

export type TrollContext = {
  video: string;
  videoTS: number;
  paused: boolean;
  viewers: number;
  title: string;
  recentChat: { name: string; msg: string }[];
};

export type TrollDeps = {
  mediaRoot: string;
  mediaBaseUrl: string;
  resolveMediaPath: (relative: string) => Promise<string | null>;
  getContext: () => TrollContext;
  postMessage: (text: string) => void;
  onStateChange: (state: TrollState) => void;
  onTypingChange: (typing: boolean) => void;
};

export function createTroll(deps: TrollDeps) {
  // Troll watches whenever it is configured; `pause` mutes it, `resume` unmutes.
  let muted = false;
  let name = DEFAULT_TROLL_NAME;
  let frames: string[] = [];
  let lastCommentAt = 0;
  let nextGapMs = randomGap();
  let inFlight = false;
  // Held so `stop` can cancel a generation that is already running.
  let currentRun: AbortController | null = null;

  function randomGap() {
    return MIN_COMMENT_GAP_MS + Math.random() * (MAX_COMMENT_GAP_MS - MIN_COMMENT_GAP_MS);
  }

  function configured() {
    return Boolean(config().token);
  }

  function getState(): TrollState {
    return { active: configured() && !muted, name, configured: configured() };
  }

  // Only comment when there is something to watch and someone to watch it with.
  function shouldRun(context: TrollContext) {
    return !muted && configured() && Boolean(context.video) && !context.paused && context.viewers > 0;
  }

  // Media URLs are built as `${mediaBaseUrl}/${encodeURIComponent(...)}`, so
  // reverse that to get a path on disk. Anything not under the media base (a
  // YouTube manifest, a pasted remote URL) has no local file to sample.
  async function localPathFor(videoUrl: string) {
    if (!videoUrl.startsWith(deps.mediaBaseUrl)) {
      return null;
    }
    const relative = videoUrl
      .slice(deps.mediaBaseUrl.length)
      .replace(/^\/+/, "")
      .split("/")
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .join("/");
    if (!relative) {
      return null;
    }
    const resolved = await deps.resolveMediaPath(relative);
    if (!resolved || path.relative(deps.mediaRoot, resolved).startsWith("..")) {
      return null;
    }
    return resolved;
  }

  function extractFrame(file: string, atSeconds: number) {
    return new Promise<string | null>((resolve) => {
      execFile(
        config().ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          String(Math.max(0, Math.floor(atSeconds))),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=512:-2",
          "-f",
          "image2",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 20_000 },
        (error, stdout) => {
          if (error || !stdout?.length) {
            resolve(null);
            return;
          }
          resolve(stdout.toString("base64"));
        },
      );
    });
  }

  // Oldest to newest, evenly spaced, always including the most recent frame.
  function pickFrames(count: number) {
    if (frames.length <= count) {
      return [...frames];
    }
    const step = (frames.length - 1) / (count - 1);
    const picked: string[] = [];
    for (let index = 0; index < count; index += 1) {
      picked.push(frames[Math.round(index * step)]);
    }
    return picked;
  }

  async function captureFrame() {
    const context = deps.getContext();
    if (!shouldRun(context)) {
      return;
    }
    const file = await localPathFor(context.video);
    if (!file) {
      return;
    }
    const frame = await extractFrame(file, context.videoTS);
    if (!frame) {
      return;
    }
    frames.push(frame);
    if (frames.length > FRAME_BUFFER_SIZE) {
      frames = frames.slice(-FRAME_BUFFER_SIZE);
    }
  }

  function systemPrompt(context: TrollContext) {
    const persona = [
      `You are ${name}, watching a movie together with friends in a shared watch room.`,
      "You are snarky, funny and opinionated, but never mean to the people in the room.",
      `Reply with ONE single comment of at most ${MAX_COMMENT_CHARS} characters.`,
      "No preamble, no quotes, no stage directions, no markdown. Just the comment.",
      "React to what you actually see on screen. Never describe the frame like a caption.",
    ];
    const { discordChannel } = config();
    if (discordChannel) {
      // Troll runs inside the channel's own session, so it has the Discord
      // tooling in reach. Right now it is speaking in the watch room instead.
      persona.push(
        `This is the shared session for Discord channel ${discordChannel}, so keep your usual voice and memory.`,
        "You are NOT in Discord right now, you are in the Watchy watch room.",
        "Never send a Discord message, never call a Discord tool, and never mirror this comment to the channel.",
        "Your reply is delivered to the watch room automatically just by answering here.",
      );
    }
    if (context.title) {
      persona.push(`Currently playing: ${context.title}`);
    }
    return persona.join(" ");
  }

  function buildMessages(context: TrollContext, instruction: string) {
    const content: Record<string, unknown>[] = [];
    const chatLines = context.recentChat
      .map((line) => `${line.name}: ${line.msg}`)
      .join("\n")
      .slice(-2000);
    const preamble = chatLines ? `Recent chat in the room:\n${chatLines}\n\n${instruction}` : instruction;
    content.push({ type: "text", text: preamble });
    // Spread the picks across the buffer so it reads motion over ~a minute
    // rather than one still. The gateway caps a request at 8 image parts.
    for (const frame of pickFrames(FRAMES_PER_REQUEST)) {
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame}` } });
    }
    return [
      { role: "system", content: systemPrompt(context) },
      { role: "user", content },
    ];
  }

  async function askOpenClaw(messages: unknown[]) {
    const controller = new AbortController();
    currentRun = controller;
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { url, token, model, sessionKey } = config();
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(sessionKey ? { "x-openclaw-session-key": sessionKey } : {}),
        },
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages }),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.warn(`troll: gateway returned ${response.status}`);
        return null;
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : null;
    } catch (error) {
      console.warn("troll: gateway request failed", error instanceof Error ? error.message : error);
      return null;
    } finally {
      clearTimeout(timer);
      if (currentRun === controller) {
        currentRun = null;
      }
    }
  }

  // The model ignores the character limit, so trim to a word boundary.
  function clamp(text: string) {
    const clean = text.replace(/\s+/g, " ").replace(/^["'\s]+|["'\s]+$/g, "");
    if (clean.length <= MAX_COMMENT_CHARS) {
      return clean;
    }
    const cut = clean.slice(0, MAX_COMMENT_CHARS - 1);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > MAX_COMMENT_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }

  // Scheduled comments need something to look at and stay silent on failure -
  // one more spontaneous line is not worth explaining a gateway hiccup for.
  // A direct reply owes the person who asked an answer either way: it goes
  // ahead with no frames rather than vanish, and reports if the call fails.
  async function speak(instruction: string, options: { requireFrames: boolean; onFailure?: string }) {
    if (inFlight) {
      if (options.onFailure) {
        deps.postMessage(`${name} is still replying to someone else, try again in a moment.`);
      }
      return;
    }
    const context = deps.getContext();
    if (options.requireFrames && !frames.length) {
      return;
    }
    inFlight = true;
    deps.onTypingChange(true);
    try {
      const reply = await askOpenClaw(buildMessages(context, instruction));
      if (reply?.trim()) {
        deps.postMessage(clamp(reply));
        lastCommentAt = Date.now();
        nextGapMs = randomGap();
      } else if (options.onFailure) {
        deps.postMessage(options.onFailure);
      }
    } finally {
      inFlight = false;
      deps.onTypingChange(false);
    }
  }

  function tick() {
    const context = deps.getContext();
    if (!shouldRun(context) || inFlight) {
      return;
    }
    if (Date.now() - lastCommentAt < nextGapMs) {
      return;
    }
    void speak("React to what is happening on screen right now.", { requireFrames: true });
  }

  return {
    getState,
    isConfigured: configured,
    start() {
      setInterval(() => void captureFrame(), FRAME_INTERVAL_MS);
      setInterval(tick, TICK_INTERVAL_MS);
    },
    setName(next: string) {
      const clean = next.replace(/\s+/g, " ").trim().slice(0, 24);
      if (!clean || clean === name) {
        return;
      }
      name = clean;
      deps.onStateChange(getState());
    },
    /**
     * Handles a chat message. Returns a short acknowledgement for the bare
     * `stop` / `pause` / `resume` commands, or null when the message was not a
     * command (mentions are answered by Troll itself, not acknowledged here).
     */
    handleChat(message: string) {
      if (!configured()) {
        return null;
      }
      switch (message.trim().toLowerCase()) {
        case "stop": {
          // Cancel whatever is being generated right now; stay watching.
          currentRun?.abort();
          currentRun = null;
          lastCommentAt = Date.now();
          nextGapMs = randomGap();
          return `stopped ${name}'s current job`;
        }
        case "pause": {
          if (muted) {
            return null;
          }
          muted = true;
          currentRun?.abort();
          currentRun = null;
          deps.onStateChange(getState());
          return `muted ${name}`;
        }
        case "resume": {
          if (!muted) {
            return null;
          }
          muted = false;
          // Start the clock fresh so resuming does not fire a comment instantly.
          lastCommentAt = Date.now();
          nextGapMs = randomGap();
          deps.onStateChange(getState());
          return `unmuted ${name}`;
        }
        default:
          break;
      }

      if (muted) {
        return null;
      }
      const mention = new RegExp(`@${escapeRegExp(name)}\\b`, "i");
      if (!mention.test(message)) {
        return null;
      }
      const asked = message.replace(mention, "").trim();
      // Grab the frame at the moment of the mention first: the scheduled
      // capture can be up to 10s stale, and the answer should reflect what is
      // on screen when they asked, not what was there before.
      void (async () => {
        await captureFrame();
        await speak(
          asked
            ? `Someone in the room said to you: "${asked}". Answer them directly.`
            : "Someone called your name. Respond to the room.",
          { requireFrames: false, onFailure: `${name} couldn't come up with anything, try again?` },
        );
      })();
      return null;
    },
  };
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
