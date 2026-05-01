# Protocol Notes

## Intent

This document reserves a place for the future signaling and control protocol used across the server, web viewer, and Windows agent.

## Planned Contract Areas

- User identity payloads
- Device registration payloads
- Session lifecycle payloads
- Signaling message envelopes

## Current Shared Placeholders

The `packages/shared` package currently exports empty interfaces for:

- `User`
- `Session`
- `Device`
- `SignalingMessage`

## Scope Boundary

No signaling schema, no WebRTC negotiation data, and no transport logic are implemented yet. The protocol surface is deliberately deferred until the connection scaffold phase begins.
