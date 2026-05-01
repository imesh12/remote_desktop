# Agent Placeholder

This directory contains the placeholder project for the future Windows remote desktop agent.

## Intended Responsibilities

- Maintain secure presence for a registered remote machine
- Join remote desktop sessions after control-plane authorization
- Coordinate future screen capture and input injection components
- Report device status and health to the backend

## Current Scope

This scaffold intentionally does not include:

- Native screen capture logic
- WebRTC transport
- Local networking integrations
- Windows service installation

## Placeholder Language Choice

The agent is scaffolded as a Rust placeholder project to leave room for a native Windows implementation later.

## Current MVP Input Injector

The agent now includes a Windows-only input injection path that reads newline-delimited JSON input events from `stdin` and applies them with Win32 APIs.

### Supported Event Shape

```json
{"type":"mouse_move","x":0.5,"y":0.5}
{"type":"mouse_click","button":0}
{"type":"key_down","key":"A"}
{"type":"key_up","key":"A"}
```

Mouse coordinates are normalized from `0.0` to `1.0` and mapped to the current virtual desktop.

### Current Limitation

The live browser demo still uses the temporary browser-based mock agent for WebRTC signaling and media. In the current hybrid mode, that browser agent forwards received WebRTC data-channel input events to the NestJS backend, which streams them into the Rust executable over `stdin`.

## Hybrid Mode

To enable real Windows input injection while keeping the browser-based WebRTC flow:

1. Build the Rust agent executable.
2. Start the NestJS server with `AGENT_EXECUTABLE_PATH` pointing at the built `.exe` if you are not using the default release path.
3. Use the existing browser mock agent UI for screen sharing and signaling.

The server will spawn the Rust agent process and forward newline-delimited JSON input events to it.
