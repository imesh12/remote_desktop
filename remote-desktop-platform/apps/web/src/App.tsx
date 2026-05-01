import {
  forwardRef,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  InputEvent as RemoteInputEvent,
  SignalData,
  SignalIceCandidate,
  SignalSessionDescription,
  SignalingMessage
} from '@remote-desktop/shared';
import { io, type Socket } from 'socket.io-client';

type Mode = 'viewer' | 'agent';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3000';
const DEFAULT_DEVICE_ID = 'device-local-demo';
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function App() {
  const mode = useMemo<Mode>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'agent' ? 'agent' : 'viewer';
  }, []);

  return mode === 'agent' ? <AgentConsole /> : <ViewerConsole />;
}

function ViewerConsole() {
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingCandidatesRef = useRef<SignalIceCandidate[]>([]);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle');
  const [status, setStatus] = useState('Ready to start a local WebRTC session.');
  const [viewerId] = useState(() => `viewer-${crypto.randomUUID().slice(0, 8)}`);
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE_ID);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputChannelState, setInputChannelState] = useState('idle');

  useEffect(() => {
    const socket = io(SIGNALING_URL, {
      transports: ['websocket']
    });

    socketRef.current = socket;
    setConnectionState('connecting');
    setStatus('Connecting to signaling server...');

    socket.on('connect', () => {
      setConnectionState('connected');
      setErrorMessage(null);
      socket.emit('message', {
        type: 'register_viewer',
        userId: viewerId
      } satisfies SignalingMessage);
      setStatus('Viewer registered. Open ?mode=agent in another tab to start.');
    });

    socket.on('disconnect', () => {
      setConnectionState('idle');
      setStatus('Disconnected from signaling server.');
    });

    socket.on('connect_error', (error) => {
      setConnectionState('error');
      setErrorMessage(error.message);
      setStatus('Unable to connect to signaling server.');
    });

    socket.on('message', (message: SignalingMessage) => {
      void handleViewerMessage(message);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      releaseMedia(localStreamRef);
      clearVideoRef(localVideoRef);
      clearVideoRef(remoteVideoRef);
      cleanupPeer(peerRef, dataChannelRef);
    };
  }, [viewerId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      sendInputEvent(dataChannelRef.current, {
        type: 'key_down',
        key: event.key
      });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      sendInputEvent(dataChannelRef.current, {
        type: 'key_up',
        key: event.key
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  async function handleViewerMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'session_accept':
        sessionIdRef.current = message.sessionId;
        setActiveSessionId(message.sessionId);
        setStatus(`Session ${message.sessionId} accepted. Creating offer...`);
        await createOffer(message.sessionId);
        return;
      case 'signal':
        if (message.sessionId !== sessionIdRef.current) {
          return;
        }

        await applyViewerSignal(message.data);
        return;
      default:
        return;
    }
  }

  async function startSession(): Promise<void> {
    try {
      setErrorMessage(null);
      setStatus('Preparing viewer connection...');

      releaseMedia(localStreamRef);
      localStreamRef.current = null;
      pendingCandidatesRef.current = [];
      clearVideoRef(localVideoRef);

      remoteStreamRef.current = new MediaStream();
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }

      sessionIdRef.current = null;
      setActiveSessionId(null);
      setStatus(`Requesting session for device ${deviceId}...`);

      socketRef.current?.emit('message', {
        type: 'create_session',
        deviceId
      } satisfies SignalingMessage);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      setStatus('Could not start the viewer session.');
    }
  }

  async function createOffer(sessionId: string): Promise<void> {
    cleanupPeer(peerRef, dataChannelRef);

    const peer = createPeerConnection(
      sessionId,
      socketRef.current,
      remoteStreamRef.current,
      setStatus
    );

    peer.addTransceiver('video', { direction: 'recvonly' });
    const inputChannel = peer.createDataChannel('input');
    setupViewerDataChannel(inputChannel, setInputChannelState);
    dataChannelRef.current = inputChannel;

    peerRef.current = peer;

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    if (!offer.sdp) {
      throw new Error('Offer SDP is missing');
    }

    sendSignal(socketRef.current, sessionId, {
      kind: 'offer',
      description: {
        type: 'offer',
        sdp: offer.sdp
      }
    });

    setStatus('Offer sent. Waiting for answer and ICE exchange...');
  }

  async function applyViewerSignal(data: SignalData): Promise<void> {
    const peer = peerRef.current;
    if (!peer) {
      return;
    }

    if (data.kind === 'answer') {
      await peer.setRemoteDescription(
        new RTCSessionDescription(toSessionDescriptionInit(data.description))
      );
      await flushPendingIceCandidates(peer, pendingCandidatesRef.current);
      setStatus('Answer received. Finalizing ICE exchange...');
      return;
    }

    if (data.kind === 'ice_candidate') {
      await enqueueOrApplyIceCandidate(
        peer,
        data.candidate,
        pendingCandidatesRef.current
      );
    }
  }

  function handleMouseMove(event: ReactMouseEvent<HTMLVideoElement>): void {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    sendInputEvent(dataChannelRef.current, {
      type: 'mouse_move',
      x: normalizePointerCoordinate(event.clientX, rect.left, rect.width),
      y: normalizePointerCoordinate(event.clientY, rect.top, rect.height)
    });
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLVideoElement>): void {
    sendInputEvent(dataChannelRef.current, {
      type: 'mouse_click',
      button: event.button
    });
  }

  return (
    <main className="app-shell">
      <section className="dashboard-card">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Secure Remote Desktop Platform</p>
            <h1>Remote Desktop Viewer</h1>
          </div>
          <a className="mode-link" href="?mode=agent">
            Open Mock Agent Mode
          </a>
        </div>

        <p className="description">
          This viewer creates the WebRTC offer, relays signaling through the
          NestJS gateway, and renders the remote screen stream once ICE
          completes.
        </p>

        <div className="status-grid">
          <StatusPill label="Mode" value="viewer" />
          <StatusPill label="Socket" value={connectionState} />
          <StatusPill label="Input" value={inputChannelState} />
          <StatusPill
            label="Session"
            value={activeSessionId ? 'active' : 'waiting'}
          />
        </div>

        <div className="control-row">
          <label className="field">
            <span>Signaling server</span>
            <input value={SIGNALING_URL} readOnly />
          </label>

          <label className="field">
            <span>Device ID</span>
            <input
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
            />
          </label>
        </div>

        <div className="button-row">
          <button
            className="primary-button"
            disabled={connectionState !== 'connected'}
            onClick={() => {
              void startSession();
            }}
          >
            Start Viewer Session
          </button>
        </div>

        <div className="session-meta">
          <span>Viewer ID: {viewerId}</span>
          <span>Session ID: {activeSessionId ?? 'pending'}</span>
        </div>

        <div className="video-grid">
          <VideoPanel
            ref={localVideoRef}
            muted
            subtitle="No local media is published in viewer mode"
            title="Viewer Preview"
          />
          <VideoPanel
            ref={remoteVideoRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            subtitle="Remote browser-captured desktop stream"
            title="Remote Screen"
          />
        </div>

        <div className="status-block">
          <strong>Status</strong>
          <p>{status}</p>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </div>
      </section>
    </main>
  );
}

function AgentConsole() {
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingCandidatesRef = useRef<SignalIceCandidate[]>([]);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle');
  const [status, setStatus] = useState(
    'Waiting to register the mock agent with the signaling server.'
  );
  const [deviceId] = useState(DEFAULT_DEVICE_ID);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputChannelState, setInputChannelState] = useState('idle');
  const [lastInputEvent, setLastInputEvent] = useState<string>('No input yet.');

  useEffect(() => {
    const socket = io(SIGNALING_URL, {
      transports: ['websocket']
    });

    socketRef.current = socket;
    setConnectionState('connecting');
    setStatus('Connecting mock agent to signaling server...');

    socket.on('connect', () => {
      setConnectionState('connected');
      setErrorMessage(null);
      socket.emit('message', {
        type: 'register_agent',
        deviceId
      } satisfies SignalingMessage);
      setStatus(`Agent ${deviceId} registered. Waiting for session requests...`);
    });

    socket.on('disconnect', () => {
      setConnectionState('idle');
      setStatus('Mock agent disconnected from signaling server.');
    });

    socket.on('connect_error', (error) => {
      setConnectionState('error');
      setErrorMessage(error.message);
      setStatus('Mock agent could not connect to signaling server.');
    });

    socket.on('message', (message: SignalingMessage) => {
      void handleAgentMessage(message);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      releaseMedia(localStreamRef);
      clearVideoRef(localVideoRef);
      clearVideoRef(remoteVideoRef);
      cleanupPeer(peerRef, dataChannelRef);
    };
  }, [deviceId]);

  async function handleAgentMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'session_request':
        await acceptIncomingSession(message.sessionId);
        return;
      case 'signal':
        if (message.sessionId !== sessionIdRef.current) {
          return;
        }

        await applyAgentSignal(message.data);
        return;
      default:
        return;
    }
  }

  async function acceptIncomingSession(sessionId: string): Promise<void> {
    try {
      setErrorMessage(null);
      setStatus(`Session request ${sessionId} received. Choose a screen or window to share...`);

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });

      releaseMedia(localStreamRef);
      localStreamRef.current = stream;
      pendingCandidatesRef.current = [];
      sessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          setStatus('Screen sharing stopped.');
        });
      }

      remoteStreamRef.current = new MediaStream();
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }

      cleanupPeer(peerRef, dataChannelRef);

      const peer = createPeerConnection(
        sessionId,
        socketRef.current,
        remoteStreamRef.current,
        setStatus
      );

      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream);
      }

      peer.ondatachannel = (event) => {
        const channel = event.channel;
        setupAgentDataChannel(
          channel,
          socketRef.current,
          setInputChannelState,
          setLastInputEvent
        );
        dataChannelRef.current = channel;
      };

      peerRef.current = peer;

      socketRef.current?.emit('message', {
        type: 'session_accept',
        sessionId
      } satisfies SignalingMessage);

      setStatus(
        `Session ${sessionId} accepted. Waiting for viewer offer and ICE candidates...`
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      setStatus('Mock agent could not accept the session.');
    }
  }

  async function applyAgentSignal(data: SignalData): Promise<void> {
    const peer = peerRef.current;
    const sessionId = sessionIdRef.current;
    if (!peer || !sessionId) {
      return;
    }

    if (data.kind === 'offer') {
      await peer.setRemoteDescription(
        new RTCSessionDescription(toSessionDescriptionInit(data.description))
      );
      await flushPendingIceCandidates(peer, pendingCandidatesRef.current);

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      if (!answer.sdp) {
        throw new Error('Answer SDP is missing');
      }

      sendSignal(socketRef.current, sessionId, {
        kind: 'answer',
        description: {
          type: 'answer',
          sdp: answer.sdp
        }
      });

      setStatus('Offer received. Answer sent back to viewer.');
      return;
    }

    if (data.kind === 'ice_candidate') {
      await enqueueOrApplyIceCandidate(
        peer,
        data.candidate,
        pendingCandidatesRef.current
      );
    }
  }

  return (
    <main className="app-shell">
      <section className="dashboard-card">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Secure Remote Desktop Platform</p>
            <h1>Mock Agent Console</h1>
          </div>
          <a className="mode-link" href="?mode=viewer">
            Open Viewer Mode
          </a>
        </div>

        <p className="description">
          This temporary browser-based agent stands in for the future native
          host process. It answers the offer and publishes a browser-based
          screen capture stream so the viewer can render the remote desktop end
          to end.
        </p>

        <div className="status-grid">
          <StatusPill label="Mode" value="agent" />
          <StatusPill label="Socket" value={connectionState} />
          <StatusPill label="Input" value={inputChannelState} />
          <StatusPill
            label="Session"
            value={activeSessionId ? 'active' : 'waiting'}
          />
        </div>

        <div className="control-row">
          <label className="field">
            <span>Signaling server</span>
            <input value={SIGNALING_URL} readOnly />
          </label>

          <label className="field">
            <span>Device ID</span>
            <input value={deviceId} readOnly />
          </label>
        </div>

        <div className="session-meta">
          <span>Device ID: {deviceId}</span>
          <span>Session ID: {activeSessionId ?? 'pending'}</span>
        </div>

        <div className="video-grid">
          <VideoPanel
            ref={localVideoRef}
            muted
            subtitle="Local screen-share preview"
            title="Shared Screen"
          />
          <VideoPanel
            ref={remoteVideoRef}
            subtitle="Viewer mode does not publish media"
            title="Viewer Stream"
          />
        </div>

        <div className="status-block">
          <strong>Status</strong>
          <p>{status}</p>
          <p>Last input: {lastInputEvent}</p>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </div>
      </section>
    </main>
  );
}

function createPeerConnection(
  sessionId: string,
  socket: Socket | null,
  remoteStream: MediaStream | null,
  setStatus: (value: string) => void
): RTCPeerConnection {
  const peer = new RTCPeerConnection({
    iceServers: ICE_SERVERS
  });

  peer.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    sendSignal(socket, sessionId, {
      kind: 'ice_candidate',
      candidate: toSignalIceCandidate(event.candidate)
    });
  };

  peer.onconnectionstatechange = () => {
    setStatus(`Peer connection state: ${peer.connectionState}`);
  };

  peer.oniceconnectionstatechange = () => {
    setStatus(`ICE connection state: ${peer.iceConnectionState}`);
  };

  peer.ontrack = (event) => {
    const stream = remoteStream ?? new MediaStream();

    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      const exists = stream.getTracks().some((candidate) => candidate.id === track.id);
      if (!exists) {
        stream.addTrack(track);
      }
    }
  };

  return peer;
}

function sendSignal(
  socket: Socket | null,
  sessionId: string,
  data: SignalData
): void {
  socket?.emit('message', {
    type: 'signal',
    sessionId,
    data
  } satisfies SignalingMessage);
}

function sendInputEvent(
  channel: RTCDataChannel | null,
  event: RemoteInputEvent
): void {
  if (!channel || channel.readyState !== 'open') {
    return;
  }

  channel.send(JSON.stringify(event));
}

async function enqueueOrApplyIceCandidate(
  peer: RTCPeerConnection,
  candidate: SignalIceCandidate,
  queue: SignalIceCandidate[]
): Promise<void> {
  if (peer.remoteDescription) {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
    return;
  }

  queue.push(candidate);
}

async function flushPendingIceCandidates(
  peer: RTCPeerConnection,
  queue: SignalIceCandidate[]
): Promise<void> {
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate) {
      continue;
    }

    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function toSignalIceCandidate(candidate: RTCIceCandidate): SignalIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment
  };
}

function toSessionDescriptionInit(
  description: SignalSessionDescription
): RTCSessionDescriptionInit {
  return {
    type: description.type,
    sdp: description.sdp
  };
}

function releaseMedia(
  streamRef: MutableRefObject<MediaStream | null>
): void {
  const stream = streamRef.current;
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }

  streamRef.current = null;
}

function cleanupPeer(
  peerRef: MutableRefObject<RTCPeerConnection | null>,
  dataChannelRef?: MutableRefObject<RTCDataChannel | null>
): void {
  if (dataChannelRef?.current) {
    dataChannelRef.current.close();
    dataChannelRef.current = null;
  }

  const peer = peerRef.current;
  if (!peer) {
    return;
  }

  peer.onicecandidate = null;
  peer.ontrack = null;
  peer.close();
  peerRef.current = null;
}

function clearVideoRef(
  videoRef: MutableRefObject<HTMLVideoElement | null>
): void {
  if (videoRef.current) {
    videoRef.current.srcObject = null;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'An unknown error occurred.';
}

function normalizePointerCoordinate(
  value: number,
  start: number,
  size: number
): number {
  if (size <= 0) {
    return 0;
  }

  return clamp((value - start) / size, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function setupViewerDataChannel(
  channel: RTCDataChannel,
  setInputChannelState: (value: string) => void
): void {
  setInputChannelState(channel.readyState);
  channel.onopen = () => {
    setInputChannelState(channel.readyState);
  };
  channel.onclose = () => {
    setInputChannelState(channel.readyState);
  };
  channel.onerror = () => {
    setInputChannelState('error');
  };
}

function setupAgentDataChannel(
  channel: RTCDataChannel,
  socket: Socket | null,
  setInputChannelState: (value: string) => void,
  setLastInputEvent: (value: string) => void
): void {
  setInputChannelState(channel.readyState);
  channel.onopen = () => {
    setInputChannelState(channel.readyState);
  };
  channel.onclose = () => {
    setInputChannelState(channel.readyState);
  };
  channel.onerror = () => {
    setInputChannelState('error');
  };
  channel.onmessage = (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as RemoteInputEvent;
      setLastInputEvent(JSON.stringify(parsed));
      socket?.emit('input_event', parsed);
    } catch (error) {
      setLastInputEvent(`Invalid input payload: ${String(event.data)}`);
    }
  };
}

type VideoPanelProps = {
  muted?: boolean;
  onMouseDown?: (event: ReactMouseEvent<HTMLVideoElement>) => void;
  onMouseMove?: (event: ReactMouseEvent<HTMLVideoElement>) => void;
  subtitle: string;
  title: string;
};

const VideoPanel = forwardRef<HTMLVideoElement, VideoPanelProps>(
  function VideoPanel(
    { muted = false, onMouseDown, onMouseMove, subtitle, title },
    ref
  ) {
    return (
      <article className="video-panel">
        <div className="video-meta">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <video
          ref={ref}
          autoPlay
          className="video-frame"
          muted={muted}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          playsInline
          tabIndex={0}
        />
      </article>
    );
  }
);

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
