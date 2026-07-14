import { Body, Controller, Get, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountNature } from '@prisma/client';

@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(
    @Body() body: { name: string; bankCode?: string; accountNumber?: string; nature?: AccountNature },
  ) {
    return this.prisma.bankAccount.create({
      data: {
        name: body.name,
        bankCode: body.bankCode,
        accountNumber: body.accountNumber,
        nature: body.nature ?? 'ASSET',
      },
    });
  }

  @Get()
  async findAll() {
    return this.prisma.bankAccount.findMany({ orderBy: { createdAt: 'desc' } });
  }
}
