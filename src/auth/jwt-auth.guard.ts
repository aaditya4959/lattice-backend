import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthTokenPayload } from './auth.service';

export interface AuthenticatedRequest extends Request {
  user: AuthTokenPayload;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/**
 * A hand-rolled `CanActivate` guard using `JwtService` directly, not
 * `@nestjs/passport`/`passport-jwt`. Consistent with this project's established
 * preference (ADR-0002, SyncGateway's hand-rolled message dispatch) for a transparent
 * few lines over a framework abstraction when the abstraction isn't buying much —
 * Passport's strategy pattern exists to support many auth schemes behind one
 * interface, and this app has exactly one (JWT bearer tokens).
 *
 * Ticket: SCRUM-38 (LAT-E2)
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    try {
      request.user = await this.jwt.verifyAsync<AuthTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }
}
