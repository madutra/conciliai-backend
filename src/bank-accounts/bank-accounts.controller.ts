import { Body, Controller, Get, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(@Body() body: { name: string; bankCode?: string; accountNumber?: string }) {
    return this.prisma.bankAccount.create({
      data: { name: body.name, bankCode: body.bankCode, accountNumber: body.accountNumber },
    });
  }

  @Get()
  async findAll() {
    return this.prisma.bankAccount.findMany({ orderBy: { createdAt: 'desc' } });
  }
}
