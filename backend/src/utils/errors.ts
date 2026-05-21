export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

// Reverse lookup: resolve machine-readable code from ErrorCodes message
const errorMessageToCode: Record<string, string> = {};
// Populated lazily after ErrorCodes is defined (see bottom of file)

function resolveCode(message: string, fallback: string): string {
  return errorMessageToCode[message] || fallback;
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Não autorizado') {
    super(message, 401, resolveCode(message, 'UNAUTHORIZED'));
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Acesso negado') {
    super(message, 403, resolveCode(message, 'FORBIDDEN'));
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Recurso') {
    super(`${resource} não encontrado`, 404, 'NOT_FOUND', { resource });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super('Muitas requisições. Tente novamente mais tarde.', 429, 'RATE_LIMIT_EXCEEDED');
  }
}

// Error codes mapping
export const ErrorCodes = {
  // Auth
  INVALID_CREDENTIALS: 'Credenciais inválidas',
  USER_INACTIVE: 'Usuário inativo',
  USER_SUSPENDED: 'Usuário suspenso',
  ACCOUNT_PAUSED: 'Conta pausada',
  TOKEN_EXPIRED: 'Token expirado',
  TOKEN_INVALID: 'Token inválido',
  REFRESH_TOKEN_INVALID: 'Refresh token inválido',
  PASSWORD_INVALID: 'Senha incorreta',

  // Resources
  ACCOUNT_NOT_FOUND: 'Conta não encontrada',
  USER_NOT_FOUND: 'Usuário não encontrado',
  CONTACT_NOT_FOUND: 'Contato não encontrado',
  PRODUCT_NOT_FOUND: 'Produto não encontrado',
  SALE_NOT_FOUND: 'Venda não encontrada',
  TAG_NOT_FOUND: 'Tag não encontrada',
  FUNNEL_NOT_FOUND: 'Funil não encontrado',
  EVENT_NOT_FOUND: 'Evento não encontrado',

  // Validation
  EMAIL_IN_USE: 'Email já cadastrado',
  USER_LIMIT_EXCEEDED: 'Limite de usuários da conta excedido',
  CONTACT_HAS_SALES: 'Contato possui vendas e não pode ser excluído',
  TAG_HAS_LEADS: 'Tag possui leads e não pode ser excluída',
  PRODUCT_HAS_SALES: 'Produto possui vendas e não pode ser excluído',
  SALE_ALREADY_REFUNDED: 'Venda já foi estornada',
  ITEM_ALREADY_REFUNDED: 'Item já foi estornado',

  // Permissions
  PERMISSION_DENIED: 'Permissão negada',
  SUPER_ADMIN_REQUIRED: 'Apenas Super Admin pode realizar esta ação',
  ADMIN_REQUIRED: 'Apenas Admin pode realizar esta ação',
} as const;

// Populate reverse lookup: message → KEY (machine-readable code)
Object.entries(ErrorCodes).forEach(([key, message]) => {
  errorMessageToCode[message] = key;
});
