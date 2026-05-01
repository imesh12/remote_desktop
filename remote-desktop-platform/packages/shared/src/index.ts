export interface User {}

export interface Session {}

export interface Device {}

export interface SignalSessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export type InputEvent =
  | { type: 'mouse_move'; x: number; y: number }
  | { type: 'mouse_click'; button: number }
  | { type: 'key_down'; key: string }
  | { type: 'key_up'; key: string };

export interface SignalIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalData =
  | { kind: 'offer'; description: SignalSessionDescription }
  | { kind: 'answer'; description: SignalSessionDescription }
  | { kind: 'ice_candidate'; candidate: SignalIceCandidate };

export type SignalingMessage =
  | { type: 'register_agent'; deviceId: string }
  | { type: 'register_viewer'; userId: string }
  | { type: 'create_session'; deviceId: string }
  | { type: 'session_request'; sessionId: string }
  | { type: 'session_accept'; sessionId: string }
  | { type: 'signal'; sessionId: string; data: SignalData };
