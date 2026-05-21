/**
 * Services Layer Barrel Export
 * 
 * Dynamically selects between Supabase Cloud and Express Backend
 * services based on the VITE_USE_BACKEND flag.
 */

import { useBackend } from '@/config/backend.config';

// Auth service (mock-based, separate from AuthContext)
export { authService } from './auth.service';

// Accounts
import { accountsCloudService } from './accounts.cloud.service';
import { accountsBackendService } from './accounts.backend.service';
export const accountsCloudOrBackend = useBackend ? accountsBackendService : accountsCloudService;

// Users
import { usersCloudService } from './users.cloud.service';
import { usersBackendService } from './users.backend.service';
export const usersCloudOrBackend = useBackend ? usersBackendService : usersCloudService;

// Contacts
import { contactsCloudService } from './contacts.cloud.service';
import { contactsBackendService } from './contacts.backend.service';
export const contactsCloudOrBackend = useBackend ? contactsBackendService : contactsCloudService;

// Tags
import { tagsCloudService } from './tags.cloud.service';
import { tagsBackendService } from './tags.backend.service';
export const tagsCloudOrBackend = useBackend ? tagsBackendService : tagsCloudService;

// These services already use apiClient with mock fallback - no cloud equivalent needed
export { accountsService } from './accounts.service';
export { usersService } from './users.service';
export { contactsService } from './contacts.service';
export { salesService } from './sales.service';
export { productsService } from './products.service';
export { tagsService } from './tags.service';

// Finance & Calendar backend services
export { financeBackendService } from './finance.backend.service';
export { calendarBackendService } from './calendar.backend.service';
