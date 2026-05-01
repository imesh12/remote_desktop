# Architecture Overview

## Purpose

This repository scaffolds a secure remote desktop platform composed of a backend control plane, a browser-based viewer, and a native Windows agent.

## High-Level Components

### Control Plane

`apps/server` will eventually manage identity, sessions, signaling coordination, device registration, and policy enforcement. In this phase it is limited to empty domain modules:

- `AuthModule`
- `SessionModule`
- `SignalingModule`

### Viewer

`apps/web` is the operator-facing UI shell. It currently provides a single placeholder page for the future remote desktop viewer.

### Agent

`apps/agent` represents the future Windows-hosted machine service. It is intentionally native-oriented and currently contains no machine integration logic.

### Shared Contracts

`packages/shared` is reserved for cross-application types and protocol DTOs so the server and web client can evolve around a shared contract surface.

## Non-Goals for This Scaffold

- Authentication workflows
- Device enrollment
- WebRTC session establishment
- Screen capture or encoding
- Input transport
- Service-to-service wiring
