import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { OfxParserService } from './parsers/ofx-parser.service';
import { CsvParserService } from './parsers/csv-parser.service';

@Module({
  controllers: [IngestionController],
  providers: [IngestionService, OfxParserService, CsvParserService],
})
export class IngestionModule {}
