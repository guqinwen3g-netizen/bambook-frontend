import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const schema = fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

describe('entity linking Prisma schema', () => {
  it('defines EntityReference with targetPath, provenance, status, and lifecycle indexes', () => {
    expect(schema).toContain('model EntityReference');
    expect(schema).toContain('targetPath String?');
    expect(schema).toContain('source     String?');
    expect(schema).toContain('status     String  @default("active")');
    expect(schema).toContain('@@index([ownerType, ownerId])');
    expect(schema).toContain('@@index([targetType, targetId])');
    expect(schema).toContain('@@unique([ownerType, ownerId, fieldKey, targetType, targetId, targetPath])');
  });

  it('defines EntityAlias and EntityLink without creating a second canonical profile table', () => {
    expect(schema).toContain('model EntityAlias');
    expect(schema).toContain('model EntityLink');
    expect(schema).not.toContain('model CanonicalProfile');
    expect(schema).toContain('@@index([normalized])');
    expect(schema).toContain('@@index([fromType, fromId])');
    expect(schema).toContain('@@index([toType, toId])');
  });
});
