import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

const BCRYPT_SALT_ROUNDS = 10;

export interface AuthTokenPayload {
  sub: string;
  email: string;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505'
  );
}

/**
 * Ticket: SCRUM-37 (LAT-E2). Password hashing (bcrypt) + JWT issuance only — validating
 * a token on protected routes/`join` is SCRUM-38's job, not this one.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async register(
    email: string,
    password: string,
  ): Promise<{ id: string; email: string }> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    try {
      const user = await this.users.create(email, passwordHash);
      return { id: user.id, email: user.email };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }
      throw err;
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string }> {
    const user = await this.users.findByEmail(email);
    // Same generic error whether the email doesn't exist or the password is wrong —
    // distinguishing the two would let a caller enumerate registered emails.
    const invalidCredentials = (): UnauthorizedException =>
      new UnauthorizedException('Invalid email or password');
    if (!user) throw invalidCredentials();

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) throw invalidCredentials();

    const payload: AuthTokenPayload = { sub: user.id, email: user.email };
    return { accessToken: await this.jwt.signAsync(payload) };
  }
}
