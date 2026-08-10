import { IsString, MinLength } from 'class-validator';

export class CreateDocDto {
  @IsString()
  @MinLength(1)
  title!: string;
}
