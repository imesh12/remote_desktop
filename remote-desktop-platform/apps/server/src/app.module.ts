import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { SessionModule } from './modules/session/session.module';
import { SignalingModule } from './modules/signaling/signaling.module';

@Module({
  imports: [AuthModule, SessionModule, SignalingModule]
})
export class AppModule {}
