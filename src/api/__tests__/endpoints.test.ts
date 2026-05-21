import { describe, it, expect } from 'vitest';
import { API_ENDPOINTS } from '../endpoints';

describe('API_ENDPOINTS', () => {
  describe('EMAIL endpoints', () => {
    it('has all cadence endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.CADENCES).toBe('/api/email/cadences');
      expect(API_ENDPOINTS.EMAIL.CADENCE('abc')).toBe('/api/email/cadences/abc');
      expect(API_ENDPOINTS.EMAIL.CADENCE_STEPS('abc')).toBe('/api/email/cadences/abc/steps');
      expect(API_ENDPOINTS.EMAIL.CADENCE_RULES('abc')).toBe('/api/email/cadences/abc/rules');
    });

    it('has step and rule endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.STEP('s1')).toBe('/api/email/steps/s1');
      expect(API_ENDPOINTS.EMAIL.RULE('r1')).toBe('/api/email/rules/r1');
    });

    it('has template endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.TEMPLATES).toBe('/api/email/templates');
      expect(API_ENDPOINTS.EMAIL.TEMPLATE('t1')).toBe('/api/email/templates/t1');
    });

    it('has enrollment endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.ENROLL).toBe('/api/email/enroll');
      expect(API_ENDPOINTS.EMAIL.UNENROLL).toBe('/api/email/unenroll');
      expect(API_ENDPOINTS.EMAIL.ENROLLMENTS).toBe('/api/email/enrollments');
    });

    it('has send endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.SENDS).toBe('/api/email/sends');
      expect(API_ENDPOINTS.EMAIL.SEND_STATS).toBe('/api/email/sends/stats');
    });

    it('has AI and settings endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.AI_GENERATE).toBe('/api/email/ai/generate');
      expect(API_ENDPOINTS.EMAIL.SETTINGS).toBe('/api/email/settings');
      expect(API_ENDPOINTS.EMAIL.PROCESS_QUEUE).toBe('/api/email/process');
    });

    it('has test endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.TEST_SENDGRID).toBe('/api/email/test-connection');
      expect(API_ENDPOINTS.EMAIL.TEST_SEND).toBe('/api/email/test-send');
      expect(API_ENDPOINTS.EMAIL.TEST_OPENAI).toBe('/api/email/test-openai');
    });

    it('has search endpoint', () => {
      expect(API_ENDPOINTS.EMAIL.SEARCH).toBe('/api/email/search');
    });

    it('has campaign endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.CAMPAIGNS).toBe('/api/email/campaigns');
      expect(API_ENDPOINTS.EMAIL.CAMPAIGN('c1')).toBe('/api/email/campaigns/c1');
      expect(API_ENDPOINTS.EMAIL.CAMPAIGN_CADENCES('c1')).toBe('/api/email/campaigns/c1/cadences');
      expect(API_ENDPOINTS.EMAIL.CAMPAIGN_STATS('c1')).toBe('/api/email/campaigns/c1/stats');
    });

    it('has inbox endpoints', () => {
      expect(API_ENDPOINTS.EMAIL.INBOX).toBe('/api/email/inbox');
      expect(API_ENDPOINTS.EMAIL.INBOX_UNREAD).toBe('/api/email/inbox/unread');
      expect(API_ENDPOINTS.EMAIL.INBOX_MESSAGE('m1')).toBe('/api/email/inbox/m1');
      expect(API_ENDPOINTS.EMAIL.INBOX_MARK_READ('m1')).toBe('/api/email/inbox/m1/read');
      expect(API_ENDPOINTS.EMAIL.INBOX_REPLY).toBe('/api/email/inbox/reply');
      expect(API_ENDPOINTS.EMAIL.INBOX_SUGGEST_REPLY).toBe('/api/email/inbox/suggest-reply');
    });
  });

  describe('All endpoint groups exist', () => {
    it('has AUTH endpoints', () => {
      expect(API_ENDPOINTS.AUTH.LOGIN).toBeDefined();
      expect(API_ENDPOINTS.AUTH.ME).toBeDefined();
    });

    it('has ACCOUNTS endpoints', () => {
      expect(API_ENDPOINTS.ACCOUNTS.LIST).toBeDefined();
      expect(API_ENDPOINTS.ACCOUNTS.CREATE).toBeDefined();
    });

    it('has CONTACTS endpoints', () => {
      expect(API_ENDPOINTS.CONTACTS.LIST).toBeDefined();
      expect(API_ENDPOINTS.CONTACTS.SEARCH).toBeDefined();
    });

    it('has PROSPECTING endpoints', () => {
      expect(API_ENDPOINTS.PROSPECTING.EXTRACT).toBeDefined();
      expect(API_ENDPOINTS.PROSPECTING.DISPATCH).toBeDefined();
    });
  });
});
