import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the backend config
vi.mock('@/config/backend.config', () => ({ useBackend: true }));

// Mock the API client
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...args: any[]) => mockGet(...args),
    post: (...args: any[]) => mockPost(...args),
    put: (...args: any[]) => mockPut(...args),
    delete: (...args: any[]) => mockDelete(...args),
  },
  tokenManager: { getToken: () => 'test-token', setToken: vi.fn(), clearToken: vi.fn() },
}));

// Mock cloud service
vi.mock('@/services/email.cloud.service', () => ({
  emailCloudService: {},
}));

describe('Email API Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Cadences', () => {
    it('listCadences calls correct endpoint and maps results', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({
        data: [
          {
            id: '1',
            accountId: 'acc1',
            name: 'Test Cadence',
            active: true,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            steps: [],
            rulesFrom: [],
          },
        ],
      });

      const result = await emailApiService.listCadences();

      expect(mockGet).toHaveBeenCalledWith('/api/email/cadences');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Cadence');
      expect(result[0].account_id).toBe('acc1');
      expect(result[0].steps).toEqual([]);
      expect(result[0].rules).toEqual([]);
    });

    it('getCadence maps camelCase to snake_case', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({
        data: {
          id: '1',
          accountId: 'acc1',
          name: 'Cadence',
          active: true,
          sendAtTime: '10:00',
          startDate: '2026-01-01',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          steps: [{ id: 's1', cadenceId: '1', dayNumber: 1, subject: 'Hi', bodyHtml: '<p>Hi</p>', ordem: 0, active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
          rulesFrom: [],
        },
      });

      const result = await emailApiService.getCadence('1');

      expect(result.send_at_time).toBe('10:00');
      expect(result.start_date).toBe('2026-01-01');
      expect(result.steps).toHaveLength(1);
      expect(result.steps![0].day_number).toBe(1);
      expect(result.steps![0].body_html).toBe('<p>Hi</p>');
    });

    it('createCadence sends POST with correct data', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({ data: { id: '1', name: 'New', accountId: 'acc1', active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', steps: [], rulesFrom: [] } });

      await emailApiService.createCadence({ name: 'New', sendAtTime: '14:00' });

      expect(mockPost).toHaveBeenCalledWith('/api/email/cadences', { name: 'New', sendAtTime: '14:00' });
    });

    it('deleteCadence calls DELETE', async () => {
      const { emailApiService } = await import('../email.service');
      mockDelete.mockResolvedValue({});

      await emailApiService.deleteCadence('1');

      expect(mockDelete).toHaveBeenCalledWith('/api/email/cadences/1');
    });
  });

  describe('Steps', () => {
    it('createStep maps response correctly', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({
        data: { id: 's1', cadenceId: '1', dayNumber: 3, subject: 'Follow up', bodyHtml: '<p>Hey</p>', bodyText: 'Hey', ordem: 1, active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      });

      const result = await emailApiService.createStep('1', { dayNumber: 3, subject: 'Follow up', bodyHtml: '<p>Hey</p>' });

      expect(result.cadence_id).toBe('1');
      expect(result.day_number).toBe(3);
      expect(result.body_html).toBe('<p>Hey</p>');
    });
  });

  describe('Rules', () => {
    it('listRules maps response', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({
        data: [
          { id: 'r1', cadenceId: '1', triggerEvent: 'opened', targetCadenceId: '2', delayHours: 24, active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        ],
      });

      const result = await emailApiService.listRules('1');

      expect(result).toHaveLength(1);
      expect(result[0].trigger_event).toBe('opened');
      expect(result[0].target_cadence_id).toBe('2');
      expect(result[0].delay_hours).toBe(24);
    });

    it('createRule sends correct payload', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({
        data: { id: 'r1', cadenceId: '1', triggerEvent: 'not_opened', targetCadenceId: '3', delayHours: 48, active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      });

      const result = await emailApiService.createRule('1', { triggerEvent: 'not_opened', targetCadenceId: '3', delayHours: 48 });

      expect(mockPost).toHaveBeenCalledWith('/api/email/cadences/1/rules', { triggerEvent: 'not_opened', targetCadenceId: '3', delayHours: 48 });
      expect(result.trigger_event).toBe('not_opened');
    });
  });

  describe('Campaigns', () => {
    it('listCampaigns calls correct endpoint', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({ data: [{ id: 'c1', name: 'Campaign 1' }] });

      const result = await emailApiService.listCampaigns();

      expect(mockGet).toHaveBeenCalledWith('/api/email/campaigns');
      expect(result).toHaveLength(1);
    });

    it('createCampaign sends POST', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({ data: { id: 'c1', name: 'New Campaign' } });

      const result = await emailApiService.createCampaign({ name: 'New Campaign', description: 'Desc' });

      expect(mockPost).toHaveBeenCalledWith('/api/email/campaigns', { name: 'New Campaign', description: 'Desc' });
      expect(result.name).toBe('New Campaign');
    });

    it('addCadenceToCampaign sends POST to correct endpoint', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({});

      await emailApiService.addCadenceToCampaign('c1', 'cad1');

      expect(mockPost).toHaveBeenCalledWith('/api/email/campaigns/c1/cadences', { cadenceId: 'cad1' });
    });

    it('removeCadenceFromCampaign sends DELETE with query param', async () => {
      const { emailApiService } = await import('../email.service');
      mockDelete.mockResolvedValue({});

      await emailApiService.removeCadenceFromCampaign('c1', 'cad1');

      expect(mockDelete).toHaveBeenCalledWith('/api/email/campaigns/c1/cadences?cadenceId=cad1');
    });

    it('getCampaignStats calls correct endpoint', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({ data: { total: 100, sent: 80, delivered: 75, opened: 40, clicked: 10, bounced: 2, failed: 3, enrollments: 50 } });

      const result = await emailApiService.getCampaignStats('c1');

      expect(mockGet).toHaveBeenCalledWith('/api/email/campaigns/c1/stats');
      expect(result.total).toBe(100);
      expect(result.enrollments).toBe(50);
    });
  });

  describe('Inbox', () => {
    it('listInboxMessages calls correct endpoint with filters', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({ data: [{ id: 'm1', from_email: 'test@test.com', subject: 'Re: Hello', read: false }] });

      const result = await emailApiService.listInboxMessages({ read: false, limit: 20 });

      expect(mockGet).toHaveBeenCalledWith('/api/email/inbox', { params: { read: false, limit: 20 } });
      expect(result).toHaveLength(1);
    });

    it('markInboxRead calls PUT', async () => {
      const { emailApiService } = await import('../email.service');
      mockPut.mockResolvedValue({});

      await emailApiService.markInboxRead('m1');

      expect(mockPut).toHaveBeenCalledWith('/api/email/inbox/m1/read');
    });

    it('getUnreadCount returns number', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({ data: { count: 5 } });

      const result = await emailApiService.getUnreadCount();

      expect(mockGet).toHaveBeenCalledWith('/api/email/inbox/unread');
      expect(result).toBe(5);
    });

    it('replyToMessage sends correct payload', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({ data: { success: true } });

      const result = await emailApiService.replyToMessage('m1', { subject: 'Re: Test', bodyHtml: '<p>Reply</p>' });

      expect(mockPost).toHaveBeenCalledWith('/api/email/inbox/reply', { messageId: 'm1', subject: 'Re: Test', bodyHtml: '<p>Reply</p>' });
      expect(result.success).toBe(true);
    });

    it('suggestReply sends messageId and instructions', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({ data: { subject: 'Re: Hi', bodyHtml: '<p>AI reply</p>', bodyText: 'AI reply' } });

      const result = await emailApiService.suggestReply('m1', 'Be formal');

      expect(mockPost).toHaveBeenCalledWith('/api/email/inbox/suggest-reply', { messageId: 'm1', instructions: 'Be formal' });
      expect(result.bodyHtml).toBe('<p>AI reply</p>');
    });
  });

  describe('Search', () => {
    it('searchByEmail calls correct endpoint with email param', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({ data: { contact: { id: 'c1', email: 'test@test.com' }, enrollments: [], sends: [] } });

      const result = await emailApiService.searchByEmail('test@test.com');

      expect(mockGet).toHaveBeenCalledWith('/api/email/search', { params: { email: 'test@test.com' } });
      expect(result.contact?.email).toBe('test@test.com');
    });
  });

  describe('Sends', () => {
    it('listSends maps response correctly', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({
        data: [
          { id: 's1', accountId: 'acc1', contactId: 'c1', toEmail: 'lead@test.com', subject: 'Hi', status: 'delivered', sentAt: '2026-01-01', openedAt: '2026-01-02', createdAt: '2026-01-01' },
        ],
      });

      const result = await emailApiService.listSends({ status: 'delivered' });

      expect(result).toHaveLength(1);
      expect(result[0].to_email).toBe('lead@test.com');
      expect(result[0].opened_at).toBe('2026-01-02');
    });
  });

  describe('Templates', () => {
    it('listTemplates returns mapped data', async () => {
      const { emailApiService } = await import('../email.service');
      mockGet.mockResolvedValue({
        data: [{ id: 't1', accountId: 'acc1', name: 'Welcome', subject: 'Welcome!', bodyHtml: '<p>Hi</p>', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
      });

      const result = await emailApiService.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0].body_html).toBe('<p>Hi</p>');
    });
  });

  describe('Enrollments', () => {
    it('enroll sends correct payload', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({ data: [{ id: 'e1', status: 'active' }] });

      const result = await emailApiService.enroll('cad1', ['c1', 'c2']);

      expect(mockPost).toHaveBeenCalledWith('/api/email/enroll', { cadenceId: 'cad1', contactIds: ['c1', 'c2'] });
      expect(result).toHaveLength(1);
    });

    it('unenroll sends correct payload', async () => {
      const { emailApiService } = await import('../email.service');
      mockPost.mockResolvedValue({});

      await emailApiService.unenroll('cad1', ['c1']);

      expect(mockPost).toHaveBeenCalledWith('/api/email/unenroll', { cadenceId: 'cad1', contactIds: ['c1'] });
    });
  });
});
