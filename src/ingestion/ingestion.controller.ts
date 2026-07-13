import {
  Controller,
  Post,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IngestionService } from './ingestion.service';

@Controller('batches/:batchId/upload')
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('bank-statement')
  @UseInterceptors(FileInterceptor('file'))
  async uploadBankStatement(@Param('batchId') batchId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Arquivo não enviado');
    return this.ingestionService.ingestBankFile(batchId, file);
  }

  @Post('ledger')
  @UseInterceptors(FileInterceptor('file'))
  async uploadLedger(@Param('batchId') batchId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Arquivo não enviado');
    return this.ingestionService.ingestLedgerFile(batchId, file);
  }
}
