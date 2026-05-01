# Secure Remote Desktop Platform

This repository is a production-oriented monorepo scaffold for a secure remote desktop platform built around a web viewer, a backend control plane, and a Windows host agent.

## Project Vision

The long-term goal is a secure, WebRTC-based remote desktop system that lets authorized users view and control remote Windows machines through a browser experience backed by a central control plane.

This repository is intentionally limited to scaffolding only. It does not implement authentication, signaling, screen capture, WebRTC transport, or device networking yet.

## Architecture Summary

The platform is split into three primary surfaces:

- `apps/server`: NestJS control plane for authentication, sessions, and signaling APIs.
- `apps/web`: React-based viewer shell for the remote desktop experience.
- `apps/agent`: Windows agent placeholder that will eventually run on the remote machine.

Shared TypeScript contracts live in `packages/shared`, while `infra` and `docs` hold environment scaffolding and design notes.

## Module Roles

### Server = Control Plane

The backend will own account-level concerns, session orchestration, device registration, and signaling endpoints. In this scaffold, it contains only empty NestJS modules for the future backend domains.

### Web = Viewer

The frontend will eventually host the operator-facing remote desktop viewer. For now, it is a minimal React shell that renders a placeholder page.

### Agent = Remote Machine Service

The agent will ultimately run on Windows hosts and manage device presence, secure session participation, screen/input integration, and local machine controls. At this stage it is only a placeholder Rust project plus documentation.

## MVP Note

MVP phase 1 = connection scaffold only.

That means this repository currently focuses on monorepo layout, package boundaries, and minimal buildable shells rather than working remote desktop functionality.

## Workspace Layout

```text
remote-desktop-platform/
├── apps/
│   ├── agent/
│   ├── server/
│   └── web/
├── docs/
├── infra/
├── packages/
│   └── shared/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

## Getting Started

### JavaScript Workspace

```bash
pnpm install
pnpm build
```

### Development

```bash
pnpm dev
```

pnpm --filter web dev
pnpm --filter server dev

### Agent Placeholder

The agent scaffold is written as a Rust placeholder project. Building it will require a local Rust toolchain (`cargo`) once agent work begins.

## Current Scope

- No authentication logic
- No session orchestration logic
- No WebRTC implementation
- No screen capture
- No device control
- No networking between services
