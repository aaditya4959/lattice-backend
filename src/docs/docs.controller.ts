import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import {
  type AuthenticatedRequest,
  JwtAuthGuard,
} from '../auth/jwt-auth.guard';
import { CreateDocDto } from './dto/create-doc.dto';
import { DocRecord, DocsService } from './docs.service';

@Controller('docs')
@UseGuards(JwtAuthGuard)
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateDocDto,
  ): Promise<DocRecord> {
    return this.docs.create(request.user.sub, dto.title);
  }

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<DocRecord[]> {
    return this.docs.listAccessibleTo(request.user.sub);
  }
}
