import { Module, Global } from '@nestjs/common';
import { RagService } from './rag.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global() 
@Module({
  imports: [PrismaModule],
  providers: [RagService],
  exports: [RagService], // Permite que os outros módulos usem este serviço
})
export class RagModule {}