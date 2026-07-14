import { Module } from '@nestjs/common';
import { AiAgentsModule } from '../ai-agents/ai-agents.module';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { OfxParserService } from './parsers/ofx-parser.service';
import { CsvParserService } from './parsers/csv-parser.service';
import { XlsxParserService } from './parsers/xlsx-parser.service';
import { PdfParserService } from './parsers/pdf-parser.service';

@Module({
  // AiAgentsModule entra pelo Parser Agent: fallback do PDF quando o
  // parser determinístico não valida o layout
  imports: [AiAgentsModule],
  controllers: [IngestionController],
  providers: [IngestionService, OfxParserService, CsvParserService, XlsxParserService, PdfParserService],
})
export class IngestionModule {}
