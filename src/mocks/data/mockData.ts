/**
 * Mock Data for Development
 * 
 * This file re-exports mock data from the original location.
 * When backend is ready, MSW handlers will replace these with API responses.
 */

export * from '@/data/mockData';

// Re-export specific arrays for services
import { 
  mockUsers as users,
  mockAccounts as accounts,
  mockContacts as contacts,
  mockSales as sales,
  mockProducts as products,
  mockTags as tags,
} from '@/data/mockData';

export const mockUsers = users;
export const mockAccounts = accounts;
export const mockContacts = contacts;
export const mockSales = sales;
export const mockProducts = products;
export const mockTags = tags;
