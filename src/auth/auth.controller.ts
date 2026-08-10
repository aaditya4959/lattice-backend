import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { type AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto): Promise<{ id: string; email: string }> {
    return this.auth.register(dto.email, dto.password);
  }

  // Nest defaults POST to 201 Created, right for register (a new resource) but wrong
  // for login — no resource is created, just a token issued.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<{ accessToken: string }> {
    return this.auth.login(dto.email, dto.password);
  }

  /**
   * First real use of JwtAuthGuard — also just a generically useful endpoint (a
   * frontend checking "am I logged in, and as whom" without decoding the JWT itself).
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() request: AuthenticatedRequest): { sub: string; email: string } {
    return request.user;
  }
}
