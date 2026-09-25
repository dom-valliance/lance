import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchNotionUserByEmail, resolveNotionUserId } from './principalUser.js';
import { fromNotionUser, notionUserListSchema } from './types.js';

const fixture = notionUserListSchema.parse(
  JSON.parse(readFileSync(new URL('./__fixtures__/users.json', import.meta.url), 'utf8')),
);
const users = fixture.results.map(fromNotionUser);

describe('matchNotionUserByEmail', () => {
  it('finds the one person whose email matches', () => {
    expect(matchNotionUserByEmail(users, 'principal.one@example.test')).toEqual({
      status: 'matched',
      notionUserId: '1fdd872b-594c-8146-b22f-00028f1f5a41',
    });
  });

  it('ignores case and surrounding spaces in either email', () => {
    expect(matchNotionUserByEmail(users, ' colleague.two@example.TEST ')).toEqual({
      status: 'matched',
      notionUserId: '2a0e1c55-0b7d-4c1e-9f0a-3c4d5e6f7a81',
    });
  });

  it('refuses to pick between two users with the same email', () => {
    expect(matchNotionUserByEmail(users, 'shared@example.test')).toEqual({
      status: 'ambiguous',
      candidates: 2,
    });
  });

  it('matches no bot and no guest without an email', () => {
    expect(matchNotionUserByEmail(users, 'lance@example.test')).toEqual({ status: 'unmatched' });
    expect(matchNotionUserByEmail(users, '')).toEqual({ status: 'unmatched' });
  });
});

describe('resolveNotionUserId', () => {
  it('returns a known id without listing users', async () => {
    let listed = 0;
    const result = await resolveNotionUserId({
      email: 'principal.one@example.test',
      current: 'already-known',
      listUsers: () => {
        listed += 1;
        return Promise.resolve(users);
      },
      save: () => Promise.reject(new Error('must not save')),
    });
    expect(result).toEqual({ status: 'known', notionUserId: 'already-known' });
    expect(listed).toBe(0);
  });

  it('saves the matched id when none was recorded', async () => {
    const saved: string[] = [];
    const result = await resolveNotionUserId({
      email: 'Colleague.Two@example.test',
      current: null,
      listUsers: () => Promise.resolve(users),
      save: (id) => {
        saved.push(id);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({
      status: 'resolved',
      notionUserId: '2a0e1c55-0b7d-4c1e-9f0a-3c4d5e6f7a81',
    });
    expect(saved).toEqual(['2a0e1c55-0b7d-4c1e-9f0a-3c4d5e6f7a81']);
  });

  it('saves nothing when the email is ambiguous or unknown', async () => {
    const saved: string[] = [];
    const save = (id: string): Promise<void> => {
      saved.push(id);
      return Promise.resolve();
    };
    const listUsers = (): Promise<typeof users> => Promise.resolve(users);

    await expect(
      resolveNotionUserId({ email: 'shared@example.test', current: null, listUsers, save }),
    ).resolves.toEqual({ status: 'ambiguous', candidates: 2 });
    await expect(
      resolveNotionUserId({ email: 'nobody@example.test', current: null, listUsers, save }),
    ).resolves.toEqual({ status: 'unmatched' });
    expect(saved).toEqual([]);
  });
});
