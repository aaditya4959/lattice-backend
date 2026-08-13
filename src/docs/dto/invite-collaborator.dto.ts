import { IsEmail } from 'class-validator';

export class InviteCollaboratorDto {
  @IsEmail()
  email!: string;
}
