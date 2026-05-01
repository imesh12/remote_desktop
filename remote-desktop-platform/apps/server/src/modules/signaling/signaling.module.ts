import { Module } from '@nestjs/common';
import { SignalingAgentService } from './signaling-agent.service';
import { SignalingGateway } from './signaling.gateway';

@Module({
  providers: [SignalingGateway, SignalingAgentService]
})
export class SignalingModule {}
