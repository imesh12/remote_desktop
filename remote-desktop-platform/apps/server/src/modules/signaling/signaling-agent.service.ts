import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InputEvent } from '@remote-desktop/shared';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

@Injectable()
export class SignalingAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalingAgentService.name);
  private process: ChildProcessWithoutNullStreams | null = null;

  onModuleInit(): void {
    try {
      this.ensureProcess();
    } catch (error) {
      this.logger.warn(
        error instanceof Error ? error.message : 'Rust agent process is unavailable'
      );
    }
  }

  onModuleDestroy(): void {
    this.stopProcess();
  }

  forwardInputEvent(event: InputEvent): void {
    const process = this.ensureProcess();
    if (!process.stdin.writable) {
      throw new Error('Rust agent stdin is not writable');
    }

    process.stdin.write(`${JSON.stringify(event)}\n`);
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed && this.process.exitCode === null) {
      return this.process;
    }

    const executablePath = this.resolveExecutablePath();
    if (!existsSync(executablePath)) {
      throw new Error(
        `Rust agent executable was not found at ${executablePath}. Set AGENT_EXECUTABLE_PATH or build apps/agent first.`
      );
    }

    this.logger.log(`Starting Rust agent process from ${executablePath}`);
    const process = spawn(executablePath, [], {
      stdio: 'pipe'
    });

    process.stdout.on('data', (chunk: Buffer) => {
      this.logger.log(`[agent] ${chunk.toString().trim()}`);
    });

    process.stderr.on('data', (chunk: Buffer) => {
      this.logger.warn(`[agent] ${chunk.toString().trim()}`);
    });

    process.on('exit', (code, signal) => {
      this.logger.warn(
        `Rust agent process exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`
      );
      this.process = null;
    });

    this.process = process;
    return process;
  }

  private resolveExecutablePath(): string {
    return (
      process.env.AGENT_EXECUTABLE_PATH ||
      resolve(
        __dirname,
        '../../../../agent/target/release/remote-desktop-agent.exe'
      )
    );
  }

  private stopProcess(): void {
    if (!this.process || this.process.killed) {
      return;
    }

    this.process.kill();
    this.process = null;
  }
}
