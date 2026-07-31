import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  MicOff,
  Settings2,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Socket } from "socket.io-client";

export type CallParticipant = {
  id: string;
  audio: boolean;
  video: boolean;
};

type CallState = Omit<CallParticipant, "id">;

type RtcSignal = {
  fromId: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type PeerView = {
  stream: MediaStream;
  connectionState: RTCPeerConnectionState;
};

type PeerContext = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  senders: Partial<Record<"audio" | "video", RTCRtpSender>>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  polite: boolean;
  restartAttempts: number;
  rebuildAttempts: number;
  recoveryTimer?: number;
};

type CallPanelProps = {
  socket: Socket | null;
  clientId: string;
  nameMap: Record<string, string>;
  colorMap: Record<string, string>;
  controlsTarget?: HTMLElement | null;
};

const MAX_CALL_PARTICIPANTS = 6;
// TURN details come from VITE_TURN_* at build time so the relay credential
// stays out of the repository. Without them only STUN is used, which is enough
// for everything except symmetric NAT.
const turnUrl = import.meta.env.VITE_TURN_URL;
const turnUsername = import.meta.env.VITE_TURN_USERNAME;
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;
const rtcConfiguration: RTCConfiguration = {
  iceServers: [
    ...(turnUrl && turnUsername && turnCredential
      ? [{ urls: turnUrl, username: turnUsername, credential: turnCredential }]
      : []),
    { urls: import.meta.env.VITE_STUN_URL || "stun:stun.cloudflare.com:3478" },
  ],
};

export function CallPanel({ socket, clientId, nameMap, colorMap, controlsTarget }: CallPanelProps) {
  const call = useWatchyCall(socket, clientId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const remoteParticipants = call.participants.filter(
    (participant) => participant.id !== clientId && (participant.audio || participant.video),
  );
  // Watching is never capped; only the number of people sending is.
  const isFull =
    !call.media.audio && !call.media.video && remoteParticipants.length >= MAX_CALL_PARTICIPANTS;
  const controlsDisabled = !socket?.connected || call.joining || isFull;
  const toolbar = (
    <div className="call-toolbar">
      <div className="call-actions">
        <button
          type="button"
          className={`call-icon-button${call.media.video ? " active" : ""}`}
          onClick={call.toggleVideo}
          disabled={controlsDisabled}
          title={isFull ? "Call is full" : call.media.video ? "Turn camera off" : "Turn camera on"}
          aria-label={call.media.video ? "Turn camera off" : "Turn camera on"}
        >
          {call.media.video ? <Video size={18} /> : <VideoOff size={18} />}
        </button>
        <button
          type="button"
          className={`call-icon-button${call.media.audio ? " active" : ""}`}
          onClick={call.toggleAudio}
          disabled={controlsDisabled}
          title={isFull ? "Call is full" : call.media.audio ? "Turn microphone off" : "Turn microphone on"}
          aria-label={call.media.audio ? "Turn microphone off" : "Turn microphone on"}
        >
          {call.media.audio ? <Mic size={18} /> : <MicOff size={18} />}
        </button>
        <button
          type="button"
          className={`call-icon-button${settingsOpen ? " active" : ""}`}
          onClick={() => setSettingsOpen((open) => !open)}
          title="Camera and microphone settings"
          aria-label="Camera and microphone settings"
          aria-expanded={settingsOpen}
        >
          <Settings2 size={18} />
        </button>
      </div>
    </div>
  );

  return (
    <section className={`call-panel${call.joined ? " joined" : ""}`} aria-label="Camera and microphone call">
      {controlsTarget ? createPortal(toolbar, controlsTarget) : toolbar}
      {call.joining && <span className="call-status">Connecting...</span>}

      {settingsOpen && (
        <div className="call-settings">
          <label>
            <span>Camera</span>
            <select value={call.selectedVideoDevice} onChange={(event) => void call.selectVideoDevice(event.target.value)}>
              <option value="">Default camera</option>
              {call.videoDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Microphone</span>
            <select value={call.selectedAudioDevice} onChange={(event) => void call.selectAudioDevice(event.target.value)}>
              <option value="">Default microphone</option>
              {call.audioDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {call.error && <div className="call-error">{call.error}</div>}

      {call.joined && (call.media.audio || call.media.video || remoteParticipants.length > 0) && (
        <div className="call-strip">
          {(call.media.audio || call.media.video) && (
            <CallTile
              stream={call.localStream}
              name={`${nameMap[clientId] || "You"} (you)`}
              color={colorMap[clientId]}
              audio={call.media.audio}
              video={call.media.video}
              connectionState="connected"
              local
            />
          )}
          {remoteParticipants.map((participant) => {
            const peer = call.peerViews[participant.id];
            return (
              <CallTile
                key={participant.id}
                stream={peer?.stream ?? null}
                name={nameMap[participant.id] || "Guest"}
                color={colorMap[participant.id]}
                audio={participant.audio}
                video={participant.video}
                connectionState={peer?.connectionState ?? "new"}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function useWatchyCall(socket: Socket | null, clientId: string) {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [media, setMedia] = useState<CallState>({ audio: false, video: false });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [peerViews, setPeerViews] = useState<Record<string, PeerView>>({});
  const [error, setError] = useState("");
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState(
    () => localStorage.getItem("watchy-audio-input") || "",
  );
  const [selectedVideoDevice, setSelectedVideoDevice] = useState(
    () => localStorage.getItem("watchy-video-input") || "",
  );
  const socketRef = useRef(socket);
  const joinedRef = useRef(false);
  const mediaRef = useRef<CallState>({ audio: false, video: false });
  const localStreamRef = useRef(new MediaStream());
  const participantsRef = useRef<CallParticipant[]>([]);
  const peersRef = useRef(new Map<string, PeerContext>());

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioDevices(devices.filter((device) => device.kind === "audioinput" && device.deviceId !== "default"));
    setVideoDevices(devices.filter((device) => device.kind === "videoinput" && device.deviceId !== "default"));
  }, []);

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
    const handleDeviceChange = () => void refreshDevices().catch(() => undefined);
    navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshDevices]);

  const updatePeerView = useCallback((peerId: string, patch: Partial<PeerView>) => {
    setPeerViews((current) => {
      const existing = current[peerId] ?? {
        stream: peersRef.current.get(peerId)?.remoteStream ?? new MediaStream(),
        connectionState: "new" as RTCPeerConnectionState,
      };
      return { ...current, [peerId]: { ...existing, ...patch } };
    });
  }, []);

  const closePeer = useCallback((peerId: string) => {
    const context = peersRef.current.get(peerId);
    if (!context) {
      return;
    }
    if (context.recoveryTimer) {
      window.clearTimeout(context.recoveryTimer);
    }
    context.pc.ontrack = null;
    context.pc.onicecandidate = null;
    context.pc.onnegotiationneeded = null;
    context.pc.onconnectionstatechange = null;
    context.pc.close();
    context.remoteStream.getTracks().forEach((track) => track.stop());
    peersRef.current.delete(peerId);
    setPeerViews((current) => {
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);

  const closeAllPeers = useCallback(() => {
    for (const peerId of Array.from(peersRef.current.keys())) {
      closePeer(peerId);
    }
  }, [closePeer]);

  const sendSignal = useCallback((targetId: string, payload: Omit<RtcSignal, "fromId">) => {
    socketRef.current?.emit("CMD:rtcSignal", { targetId, ...payload });
  }, []);

  const ensurePeer = useCallback(
    (peerId: string) => {
      const existing = peersRef.current.get(peerId);
      if (existing) {
        return existing;
      }

      const pc = new RTCPeerConnection(rtcConfiguration);
      const remoteStream = new MediaStream();
      const context: PeerContext = {
        pc,
        remoteStream,
        senders: {},
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: clientId.localeCompare(peerId) > 0,
        restartAttempts: 0,
        rebuildAttempts: 0,
      };
      peersRef.current.set(peerId, context);
      updatePeerView(peerId, { stream: remoteStream, connectionState: "new" });

      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });

      for (const track of localStreamRef.current.getTracks()) {
        context.senders[track.kind as "audio" | "video"] = pc.addTrack(track, localStreamRef.current);
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(peerId, { candidate: event.candidate.toJSON() });
        }
      };

      pc.ontrack = (event) => {
        if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }
        event.track.addEventListener(
          "ended",
          () => {
            remoteStream.removeTrack(event.track);
            updatePeerView(peerId, { stream: remoteStream });
          },
          { once: true },
        );
        updatePeerView(peerId, { stream: remoteStream });
      };

      pc.onnegotiationneeded = async () => {
        try {
          context.makingOffer = true;
          await pc.setLocalDescription();
          if (pc.localDescription) {
            sendSignal(peerId, { description: pc.localDescription.toJSON() });
          }
        } catch (negotiationError) {
          console.warn("Watchy call negotiation failed", negotiationError);
        } finally {
          context.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        updatePeerView(peerId, { connectionState: pc.connectionState });
        if (pc.connectionState === "connected") {
          context.restartAttempts = 0;
          context.rebuildAttempts = 0;
          if (context.recoveryTimer) {
            window.clearTimeout(context.recoveryTimer);
            context.recoveryTimer = undefined;
          }
          return;
        }
        if ((pc.connectionState === "disconnected" || pc.connectionState === "failed") && !context.recoveryTimer) {
          context.recoveryTimer = window.setTimeout(() => {
            context.recoveryTimer = undefined;
            if (
              (pc.connectionState === "disconnected" || pc.connectionState === "failed") &&
              context.restartAttempts < 2
            ) {
              context.restartAttempts += 1;
              pc.restartIce();
              return;
            }
            if (pc.connectionState === "failed" && participantsRef.current.some((participant) => participant.id === peerId)) {
              const delay = Math.min(1000 * 2 ** context.rebuildAttempts, 8000);
              context.rebuildAttempts += 1;
              window.setTimeout(() => {
                closePeer(peerId);
                syncPeers(participantsRef.current);
              }, delay);
            }
          }, pc.connectionState === "failed" ? 1000 : 5000);
        }
      };

      return context;
    },
    [clientId, closePeer, sendSignal, updatePeerView],
  );

  const syncPeers = useCallback(
    (nextParticipants: CallParticipant[]) => {
      if (!joinedRef.current) {
        return;
      }
      const expected = new Set(nextParticipants.map((participant) => participant.id).filter((id) => id !== clientId));
      for (const peerId of expected) {
        ensurePeer(peerId);
      }
      for (const peerId of Array.from(peersRef.current.keys())) {
        if (!expected.has(peerId)) {
          closePeer(peerId);
        }
      }
    },
    [clientId, closePeer, ensurePeer],
  );

  const emitCallState = useCallback((nextMedia: CallState) => {
    mediaRef.current = nextMedia;
    setMedia(nextMedia);
    socketRef.current?.emit("CMD:callState", nextMedia);
  }, []);

  const attachTrackLifecycle = useCallback(
    (track: MediaStreamTrack) => {
      track.addEventListener(
        "ended",
        () => {
          const kind = track.kind as "audio" | "video";
          if (localStreamRef.current.getTracks().some((item) => item.id === track.id)) {
            localStreamRef.current.removeTrack(track);
            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
            emitCallState({ ...mediaRef.current, [kind]: false });
          }
        },
        { once: true },
      );
    },
    [emitCallState],
  );

  useEffect(() => {
    if (!socket) {
      setParticipants([]);
      participantsRef.current = [];
      closeAllPeers();
      return;
    }

    const handleParticipants = (nextParticipants: CallParticipant[]) => {
      const safeParticipants = Array.isArray(nextParticipants)
        ? nextParticipants.filter(
            (participant) =>
              participant &&
              typeof participant.id === "string" &&
              typeof participant.audio === "boolean" &&
              typeof participant.video === "boolean",
          )
        : [];
      participantsRef.current = safeParticipants;
      setParticipants(safeParticipants);
      syncPeers(safeParticipants);
    };

    const handleSignal = async (signal: RtcSignal) => {
      if (!joinedRef.current || !signal || typeof signal.fromId !== "string") {
        return;
      }
      const context = ensurePeer(signal.fromId);
      const { pc } = context;
      try {
        if (signal.description) {
          const readyForOffer =
            !context.makingOffer && (pc.signalingState === "stable" || context.isSettingRemoteAnswerPending);
          const offerCollision = signal.description.type === "offer" && !readyForOffer;
          context.ignoreOffer = !context.polite && offerCollision;
          if (context.ignoreOffer) {
            return;
          }
          context.isSettingRemoteAnswerPending = signal.description.type === "answer";
          await pc.setRemoteDescription(signal.description);
          context.isSettingRemoteAnswerPending = false;
          if (signal.description.type === "offer") {
            await pc.setLocalDescription();
            if (pc.localDescription) {
              sendSignal(signal.fromId, { description: pc.localDescription.toJSON() });
            }
          }
        } else if (signal.candidate) {
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch (candidateError) {
            if (!context.ignoreOffer) {
              throw candidateError;
            }
          }
        }
      } catch (signalError) {
        context.isSettingRemoteAnswerPending = false;
        console.warn("Watchy call signal failed", signalError);
      }
    };

    const handleDisconnect = () => closeAllPeers();
    const handleConnect = () => {
      // The server enrols every connected client, so re-announce our own media
      // state and pick the peers back up.
      socket.emit("CMD:callState", mediaRef.current);
      socket.emit("CMD:callSync");
      syncPeers(participantsRef.current);
    };

    socket.on("REC:callParticipants", handleParticipants);
    socket.on("REC:rtcSignal", handleSignal);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect", handleConnect);
    socket.emit("CMD:callSync");

    return () => {
      socket.off("REC:callParticipants", handleParticipants);
      socket.off("REC:rtcSignal", handleSignal);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect", handleConnect);
      closeAllPeers();
    };
  }, [closeAllPeers, ensurePeer, sendSignal, socket, syncPeers]);

  // Being in the room is being in the call: no join step, receive-only until
  // the camera or microphone is switched on.
  useEffect(() => {
    if (!socket?.connected) {
      joinedRef.current = false;
      setJoined(false);
      return;
    }
    joinedRef.current = true;
    setJoined(true);
    syncPeers(participantsRef.current);
  }, [socket, socket?.connected, syncPeers]);

  const getTrack = useCallback(async (kind: "audio" | "video", deviceId: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media devices are unavailable in this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:
        kind === "audio"
          ? {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              echoCancellation: true,
              noiseSuppression: true,
            }
          : false,
      video:
        kind === "video"
          ? {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              width: { ideal: 640 },
              height: { ideal: 360 },
              frameRate: { ideal: 24, max: 30 },
            }
          : false,
    });
    const track = stream.getTracks()[0];
    if (!track) {
      throw new Error(`No ${kind} track was returned.`);
    }
    return track;
  }, []);

  const installTrack = useCallback(
    async (kind: "audio" | "video", track: MediaStreamTrack) => {
      const oldTracks = localStreamRef.current.getTracks().filter((item) => item.kind === kind);
      oldTracks.forEach((item) => localStreamRef.current.removeTrack(item));
      attachTrackLifecycle(track);
      localStreamRef.current.addTrack(track);

      for (const context of peersRef.current.values()) {
        const sender = context.senders[kind];
        if (sender) {
          await sender.replaceTrack(track);
        } else {
          context.senders[kind] = context.pc.addTrack(track, localStreamRef.current);
        }
      }

      oldTracks.forEach((item) => item.stop());
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
    },
    [attachTrackLifecycle],
  );

  const toggleKind = useCallback(
    async (kind: "audio" | "video") => {
      if (!joinedRef.current) {
        setError("Not connected to the room yet.");
        return;
      }
      const existing = localStreamRef.current.getTracks().find((track) => track.kind === kind && track.readyState === "live");
      if (existing) {
        localStreamRef.current.removeTrack(existing);
        await Promise.all(
          Array.from(peersRef.current.values(), (context) => context.senders[kind]?.replaceTrack(null)),
        );
        existing.stop();
        setLocalStream(
          localStreamRef.current.getTracks().length > 0
            ? new MediaStream(localStreamRef.current.getTracks())
            : null,
        );
        emitCallState({ ...mediaRef.current, [kind]: false });
        return;
      }
      try {
        const deviceId = kind === "audio" ? selectedAudioDevice : selectedVideoDevice;
        const track = await getTrack(kind, deviceId);
        await installTrack(kind, track);
        emitCallState({ ...mediaRef.current, [kind]: true });
        await refreshDevices();
        setError("");
      } catch {
        setError(`${kind === "audio" ? "Microphone" : "Camera"} permission is unavailable.`);
      }
    },
    [emitCallState, getTrack, installTrack, refreshDevices, selectedAudioDevice, selectedVideoDevice],
  );

  const selectDevice = useCallback(
    async (kind: "audio" | "video", deviceId: string) => {
      if (kind === "audio") {
        setSelectedAudioDevice(deviceId);
        localStorage.setItem("watchy-audio-input", deviceId);
      } else {
        setSelectedVideoDevice(deviceId);
        localStorage.setItem("watchy-video-input", deviceId);
      }
      if (!joinedRef.current || !mediaRef.current[kind]) {
        return;
      }

      setJoining(true);
      try {
        const track = await getTrack(kind, deviceId);
        await installTrack(kind, track);
        await refreshDevices();
        setError("");
      } catch {
        setError(`Could not switch ${kind === "audio" ? "microphones" : "cameras"}.`);
      } finally {
        setJoining(false);
      }
    },
    [getTrack, installTrack, refreshDevices],
  );

  useEffect(
    () => () => {
      if (joinedRef.current) {
        socketRef.current?.emit("CMD:callState", { audio: false, video: false });
      }
      joinedRef.current = false;
      closeAllPeers();
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    },
    [closeAllPeers],
  );

  return {
    joined,
    joining,
    media,
    localStream,
    participants,
    peerViews,
    error,
    audioDevices,
    videoDevices,
    selectedAudioDevice,
    selectedVideoDevice,
    selectAudioDevice: (deviceId: string) => selectDevice("audio", deviceId),
    selectVideoDevice: (deviceId: string) => selectDevice("video", deviceId),
    toggleAudio: () => toggleKind("audio"),
    toggleVideo: () => toggleKind("video"),
  };
}

type CallTileProps = {
  stream: MediaStream | null;
  name: string;
  color?: string;
  audio: boolean;
  video: boolean;
  connectionState: RTCPeerConnectionState;
  local?: boolean;
};

function CallTile({ stream, name, color, audio, video, connectionState, local = false }: CallTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playBlocked, setPlayBlocked] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const speaking = useSpeaking(stream, audio);

  const play = useCallback(async () => {
    const element = videoRef.current;
    if (!element || !stream) {
      return;
    }
    try {
      await element.play();
      setPlayBlocked(false);
    } catch {
      if (!local) {
        setPlayBlocked(true);
      }
    }
  }, [local, stream]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) {
      return;
    }
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    if (stream) {
      void play();
    }
    return () => {
      element.srcObject = null;
    };
  }, [play, stream]);

  useEffect(() => {
    const element = videoRef.current;
    if (element) {
      element.muted = local || muted;
      element.volume = volume;
    }
  }, [local, muted, volume]);

  const status = connectionLabel(connectionState);
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <article
      className={`call-tile${speaking ? " speaking" : ""}${video ? " has-camera" : ""}${expanded && video ? " expanded" : ""}`}
    >
      <video ref={videoRef} autoPlay playsInline muted={local || muted} />
      {video && (
        <button
          type="button"
          className="call-expand-hitbox"
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? `Collapse ${name}` : `Expand ${name}`}
          aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
        />
      )}
      {!video && (
        <div className="call-avatar" style={{ background: color || "#3d474d" }} aria-hidden="true">
          {initial}
        </div>
      )}
      <div className="call-tile-topline">
        {!audio && <MicOff size={15} aria-label="Microphone off" />}
        {status && <span className={`call-connection ${connectionState}`}>{status}</span>}
        {!local && (
          <div className="call-volume-controls">
            <button
              type="button"
              className="call-tile-button"
              onClick={() => setMuted((value) => !value)}
              title={muted ? `Unmute ${name}` : `Mute ${name}`}
              aria-label={muted ? `Unmute ${name}` : `Mute ${name}`}
            >
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={muted}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label={`Volume for ${name}`}
            />
          </div>
        )}
      </div>
      {playBlocked && (
        <button type="button" className="call-enable-audio" onClick={() => void play()}>
          Enable audio
        </button>
      )}
    </article>
  );
}

function useSpeaking(stream: MediaStream | null, enabled: boolean) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!stream || !enabled || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    const AudioContextClass = window.AudioContext;
    const context = new AudioContextClass();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let lastSpeaking = false;

    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const value = (sample - 128) / 128;
        sum += value * value;
      }
      const nextSpeaking = Math.sqrt(sum / samples.length) > 0.035;
      if (nextSpeaking !== lastSpeaking) {
        lastSpeaking = nextSpeaking;
        setSpeaking(nextSpeaking);
      }
      frame = window.requestAnimationFrame(measure);
    };
    void context.resume().catch(() => undefined);
    frame = window.requestAnimationFrame(measure);

    return () => {
      window.cancelAnimationFrame(frame);
      source.disconnect();
      void context.close();
    };
  }, [enabled, stream]);

  return speaking;
}

function connectionLabel(state: RTCPeerConnectionState) {
  if (state === "failed") {
    return "Connection failed";
  }
  if (state === "disconnected") {
    return "Reconnecting";
  }
  if (state === "new" || state === "connecting") {
    return "Connecting";
  }
  return "";
}
