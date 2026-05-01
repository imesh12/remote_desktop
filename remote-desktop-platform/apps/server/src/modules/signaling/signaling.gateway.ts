import { randomUUID } from 'node:crypto';
import { InputEvent, SignalingMessage } from '@remote-desktop/shared';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WsException
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { SignalingAgentService } from './signaling-agent.service';

type ConnectionType = 'agent' | 'viewer';

interface ConnectionRegistration {
  type: ConnectionType;
  id: string;
}

interface SessionLink {
  agent: string;
  viewer: string;
  status: 'pending' | 'active';
}

@WebSocketGateway({
  cors: {
    origin: '*'
  }
})
export class SignalingGateway
  implements OnGatewayDisconnect
{
  constructor(
    private readonly signalingAgentService: SignalingAgentService
  ) {}

  private readonly agents = new Map<string, Socket>();
  private readonly viewers = new Map<string, Socket>();
  private readonly sessions = new Map<string, SessionLink>();
  private readonly registrations = new Map<string, ConnectionRegistration>();
  private readonly activeSessionByParticipant = new Map<string, string>();

  handleDisconnect(client: Socket): void {
    const registration = this.registrations.get(client.id);
    if (!registration) {
      return;
    }

    this.unregisterParticipant(client.id, registration);
  }

  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SignalingMessage
  ): void {
    switch (payload.type) {
      case 'register_agent':
        this.registerAgent(client, payload.deviceId);
        return;
      case 'register_viewer':
        this.registerViewer(client, payload.userId);
        return;
      case 'create_session':
        this.createSession(client, payload.deviceId);
        return;
      case 'session_request':
        throw new WsException('session_request is sent by the server only');
      case 'session_accept':
        this.acceptSession(client, payload.sessionId);
        return;
      case 'signal':
        this.forwardSignal(client, payload);
        return;
      default:
        throw new WsException('Unsupported signaling message');
    }
  }

  @SubscribeMessage('input_event')
  handleInputEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: InputEvent
  ): void {
    const registration = this.getRegisteredParticipant(client, 'agent');
    const sessionId = this.activeSessionByParticipant.get(
      this.participantKey('agent', registration.id)
    );

    if (!sessionId) {
      throw new WsException('Agent does not have an active session');
    }

    try {
      this.signalingAgentService.forwardInputEvent(payload);
    } catch (error) {
      throw new WsException(
        error instanceof Error ? error.message : 'Failed to forward input event'
      );
    }
  }

  private registerAgent(client: Socket, deviceId: string): void {
    this.assertNonEmpty(deviceId, 'deviceId');
    this.unregisterExistingClient(client);
    this.disconnectReplacedSocket(this.agents.get(deviceId), client.id);

    this.agents.set(deviceId, client);
    this.registrations.set(client.id, { type: 'agent', id: deviceId });
  }

  private registerViewer(client: Socket, userId: string): void {
    this.assertNonEmpty(userId, 'userId');
    this.unregisterExistingClient(client);
    this.disconnectReplacedSocket(this.viewers.get(userId), client.id);

    this.viewers.set(userId, client);
    this.registrations.set(client.id, { type: 'viewer', id: userId });
  }

  private createSession(client: Socket, deviceId: string): void {
    this.assertNonEmpty(deviceId, 'deviceId');

    const viewer = this.getRegisteredParticipant(client, 'viewer');
    const agentSocket = this.agents.get(deviceId);
    if (!agentSocket) {
      throw new WsException(`Agent ${deviceId} is not connected`);
    }

    this.assertParticipantAvailable('viewer', viewer.id);
    this.assertParticipantAvailable('agent', deviceId);

    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      agent: deviceId,
      viewer: viewer.id,
      status: 'pending'
    });

    agentSocket.emit('message', {
      type: 'session_request',
      sessionId
    } satisfies SignalingMessage);
  }

  private acceptSession(client: Socket, sessionId: string): void {
    this.assertNonEmpty(sessionId, 'sessionId');

    const agent = this.getRegisteredParticipant(client, 'agent');
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new WsException(`Session ${sessionId} was not found`);
    }

    if (session.agent !== agent.id) {
      throw new WsException('Agent is not authorized for this session');
    }

    const viewerSocket = this.viewers.get(session.viewer);
    if (!viewerSocket) {
      this.sessions.delete(sessionId);
      throw new WsException(`Viewer ${session.viewer} is not connected`);
    }

    this.assertParticipantAvailable('viewer', session.viewer, sessionId);
    this.assertParticipantAvailable('agent', session.agent, sessionId);

    session.status = 'active';
    this.activeSessionByParticipant.set(this.participantKey('viewer', session.viewer), sessionId);
    this.activeSessionByParticipant.set(this.participantKey('agent', session.agent), sessionId);

    const accepted: SignalingMessage = {
      type: 'session_accept',
      sessionId
    };

    client.emit('message', accepted);
    viewerSocket.emit('message', accepted);
  }

  private forwardSignal(
    client: Socket,
    payload: Extract<SignalingMessage, { type: 'signal' }>
  ): void {
    const registration = this.getRegistrationForSocket(client);
    this.assertNonEmpty(payload.sessionId, 'sessionId');
    const sessionId = payload.sessionId;

    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') {
      throw new WsException(`Session ${sessionId} is not active`);
    }

    if (
      (registration.type === 'viewer' && session.viewer !== registration.id) ||
      (registration.type === 'agent' && session.agent !== registration.id)
    ) {
      throw new WsException(
        'Connection is not a participant in the requested session'
      );
    }

    const targetSocket =
      registration.type === 'viewer'
        ? this.agents.get(session.agent)
        : this.viewers.get(session.viewer);

    if (!targetSocket) {
      this.clearSession(sessionId);
      throw new WsException('The remote peer is no longer connected');
    }

    targetSocket.emit('message', payload);
  }

  private getRegisteredParticipant(
    client: Socket,
    expectedType: ConnectionType
  ): ConnectionRegistration {
    const registration = this.getRegistrationForSocket(client);
    if (registration.type !== expectedType) {
      throw new WsException(
        `This action requires a ${expectedType} connection`
      );
    }

    return registration;
  }

  private getRegistrationForSocket(client: Socket): ConnectionRegistration {
    const registration = this.registrations.get(client.id);
    if (!registration) {
      throw new WsException('Connection must register before sending messages');
    }

    return registration;
  }

  private unregisterExistingClient(client: Socket): void {
    const existing = this.registrations.get(client.id);
    if (!existing) {
      return;
    }

    this.unregisterParticipant(client.id, existing);
  }

  private unregisterParticipant(
    socketId: string,
    registration: ConnectionRegistration
  ): void {
    if (registration.type === 'agent') {
      if (this.agents.get(registration.id)?.id === socketId) {
        this.agents.delete(registration.id);
      }
    } else {
      if (this.viewers.get(registration.id)?.id === socketId) {
        this.viewers.delete(registration.id);
      }
    }

    this.registrations.delete(socketId);
    this.clearSessionsForParticipant(registration.type, registration.id);
  }

  private clearSessionsForParticipant(
    type: ConnectionType,
    participantId: string
  ): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (
        (type === 'agent' && session.agent === participantId) ||
        (type === 'viewer' && session.viewer === participantId)
      ) {
        this.clearSession(sessionId);
      }
    }

    this.activeSessionByParticipant.delete(this.participantKey(type, participantId));
  }

  private clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);
    this.activeSessionByParticipant.delete(
      this.participantKey('agent', session.agent)
    );
    this.activeSessionByParticipant.delete(
      this.participantKey('viewer', session.viewer)
    );
  }

  private disconnectReplacedSocket(
    existing: Socket | undefined,
    currentSocketId: string
  ): void {
    if (!existing || existing.id === currentSocketId) {
      return;
    }

    existing.disconnect(true);
  }

  private assertParticipantAvailable(
    type: ConnectionType,
    participantId: string,
    ignoredSessionId?: string
  ): void {
    const activeSessionId = this.findSessionForParticipant(
      type,
      participantId,
      ignoredSessionId
    );

    if (activeSessionId) {
      throw new WsException(
        `${type} ${participantId} already has a pending or active session`
      );
    }
  }

  private findSessionForParticipant(
    type: ConnectionType,
    participantId: string,
    ignoredSessionId?: string
  ): string | undefined {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId === ignoredSessionId) {
        continue;
      }

      if (
        (type === 'agent' && session.agent === participantId) ||
        (type === 'viewer' && session.viewer === participantId)
      ) {
        return sessionId;
      }
    }

    return undefined;
  }

  private participantKey(type: ConnectionType, participantId: string): string {
    return `${type}:${participantId}`;
  }

  private assertNonEmpty(value: string, fieldName: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new WsException(`${fieldName} must be a non-empty string`);
    }
  }
}
