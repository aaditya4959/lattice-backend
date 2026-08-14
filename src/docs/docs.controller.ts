import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AuthenticatedRequest,
  JwtAuthGuard,
} from '../auth/jwt-auth.guard';
import { SnapshotService } from '../persistence/snapshot.service';
import { CreateDocDto } from './dto/create-doc.dto';
import { InviteCollaboratorDto } from './dto/invite-collaborator.dto';
import { CollaboratorRecord, DocRecord, DocsService } from './docs.service';

export interface DocDetailResponse extends DocRecord {
  latestSnapshotAt: Date | null;
}

/**
 * Ticket: SCRUM-40 (LAT-E2)
 */
@Controller('docs')
@UseGuards(JwtAuthGuard)
export class DocsController {
  constructor(
    private readonly docs: DocsService,
    private readonly snapshots: SnapshotService,
  ) {}

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

  /**
   * A user with no access gets the same 404 as a doc that doesn't exist at all — see
   * requireAccessible() below, shared with DELETE and invite.
   */
  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<DocDetailResponse> {
    const doc = await this.requireAccessible(id, request.user.sub);
    const snapshot = await this.snapshots.getLatest(id);
    return { ...doc, latestSnapshotAt: snapshot?.createdAt ?? null };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    const doc = await this.requireAccessible(id, request.user.sub);
    this.requireOwner(doc, request.user.sub, 'delete this doc');
    await this.docs.delete(id);
  }

  @Post(':id/invite')
  async invite(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: InviteCollaboratorDto,
  ): Promise<CollaboratorRecord> {
    const doc = await this.requireAccessible(id, request.user.sub);
    this.requireOwner(doc, request.user.sub, 'invite collaborators');
    return this.docs.inviteCollaborator(id, dto.email);
  }

  /**
   * Two allowed actors, not just the owner: the owner removing anyone, or a
   * collaborator removing themselves (leaving a doc they don't own). The owner can
   * never be the target — deleting the doc (DELETE /docs/:id) is the only way to
   * remove them, since a doc without an owner has no one left to authorize future
   * changes to it.
   */
  @Delete(':id/collaborators/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCollaborator(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    const doc = await this.requireAccessible(id, request.user.sub);
    if (targetUserId === doc.ownerId) {
      throw new BadRequestException(
        "Can't remove the owner — delete the doc instead (DELETE /docs/:id)",
      );
    }
    if (doc.ownerId !== request.user.sub && request.user.sub !== targetUserId) {
      throw new ForbiddenException(
        'Only the owner can remove a different collaborator',
      );
    }
    const removed = await this.docs.removeCollaborator(id, targetUserId);
    if (!removed) {
      throw new NotFoundException('Not a collaborator on this doc');
    }
  }

  /**
   * Loads a doc the caller has some access to (owner or collaborator), or throws a
   * generic 404 — a user with zero access gets the identical response as a nonexistent
   * doc ID, so this can't be used to enumerate which doc IDs are real.
   */
  private async requireAccessible(
    docId: string,
    userId: string,
  ): Promise<DocRecord> {
    const doc = await this.docs.findAccessible(docId, userId);
    if (!doc) throw new NotFoundException('Doc not found');
    return doc;
  }

  /**
   * Only meaningful once requireAccessible() has already confirmed the caller can see
   * the doc — a non-owner collaborator gets 403 here (the doc IS visible to them, they
   * just lack this permission), which is a different case from the 404 above.
   */
  private requireOwner(doc: DocRecord, userId: string, action: string): void {
    if (doc.ownerId !== userId) {
      throw new ForbiddenException(`Only the owner can ${action}`);
    }
  }
}
