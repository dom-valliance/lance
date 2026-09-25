import { describe, expect, it } from 'vitest';
import { isPrincipalsLiveTask } from './data.js';

const PRINCIPAL_NOTION_ID = '1fdd872b-594c-8146-b22f-00028f1f5a41';

describe('isPrincipalsLiveTask', () => {
  it("keeps a Notion task assigned to the principal's Notion user", () => {
    expect(
      isPrincipalsLiveTask('notion', { assigneeIds: [PRINCIPAL_NOTION_ID] }, PRINCIPAL_NOTION_ID),
    ).toBe(true);
  });

  it("drops somebody else's Notion task", () => {
    expect(
      isPrincipalsLiveTask('notion', { assigneeIds: ['someone-else'] }, PRINCIPAL_NOTION_ID),
    ).toBe(false);
  });

  it('keeps no Notion task while the principal has no Notion user id', () => {
    expect(isPrincipalsLiveTask('notion', { assigneeIds: [PRINCIPAL_NOTION_ID] }, null)).toBe(
      false,
    );
  });
});
