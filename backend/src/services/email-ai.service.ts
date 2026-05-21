import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

interface GenerateEmailParams {
  accountId: string;
  prompt: string;
  context?: {
    leadName?: string;
    leadEmail?: string;
    companyName?: string;
    stageName?: string;
    previousEmails?: string[];
  };
}

interface GeneratedEmail {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export const emailAiService = {
  /**
   * Generate an email message using OpenAI
   */
  async generateEmail(params: GenerateEmailParams): Promise<GeneratedEmail> {
    const { accountId, prompt, context } = params;

    // Get OpenAI API key from account
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { openaiApiKey: true, nome: true },
    });

    if (!account?.openaiApiKey) {
      throw new Error('Chave da OpenAI não configurada para esta conta.');
    }

    const systemPrompt = `Você é um assistente especializado em criar e-mails de prospecção e vendas para o CRM GoodLeads.
Empresa: ${account.nome}

Regras:
- Escreva em português brasileiro
- Seja profissional mas cordial
- Use variáveis: {nome} para o nome do lead, {empresa} para a empresa
- Retorne EXATAMENTE um JSON com: { "subject": "...", "bodyHtml": "...", "bodyText": "..." }
- O HTML deve ser simples e compatível com e-mail (inline styles)
- Não use imagens externas
- Mantenha o texto conciso e direto`;

    let userPrompt = prompt;
    if (context) {
      const parts = [];
      if (context.leadName) parts.push(`Lead: ${context.leadName}`);
      if (context.leadEmail) parts.push(`Email: ${context.leadEmail}`);
      if (context.stageName) parts.push(`Etapa do funil: ${context.stageName}`);
      if (context.previousEmails?.length) {
        parts.push(`E-mails anteriores na cadência: ${context.previousEmails.length}`);
      }
      if (parts.length > 0) {
        userPrompt = `Contexto:\n${parts.join('\n')}\n\nSolicitação: ${prompt}`;
      }
    }

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${account.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[EmailAI] OpenAI error: ${response.status} ${errorText}`);
        throw new Error(`Erro da OpenAI: ${response.status}`);
      }

      const data: any = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('Resposta vazia da OpenAI');
      }

      const parsed = JSON.parse(content);

      return {
        subject: parsed.subject || 'Sem assunto',
        bodyHtml: parsed.bodyHtml || parsed.body_html || '<p>Conteúdo não gerado</p>',
        bodyText: parsed.bodyText || parsed.body_text || 'Conteúdo não gerado',
      };
    } catch (error: any) {
      logger.error(`[EmailAI] Error generating email: ${error.message}`);
      throw error;
    }
  },

  /**
   * Test OpenAI connection
   */
  async testConnection(apiKey: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (response.ok) {
        return { success: true, message: 'Conexão com OpenAI estabelecida!' };
      }

      return { success: false, message: `Erro ${response.status}: Chave API inválida.` };
    } catch (error: any) {
      return { success: false, message: `Erro de conexão: ${error.message}` };
    }
  },
  /**
   * Generate with a specific API key (for reply suggestions)
   */
  async generateWithKey(apiKey: string, prompt: string) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Você é um assistente de e-mails profissional. Responda em JSON: {"subject":"...","bodyHtml":"...","bodyText":"..."}' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) throw new Error(`OpenAI ${response.status}`);
      const data: any = await response.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      return {
        subject: parsed.subject || '',
        bodyHtml: parsed.bodyHtml || parsed.body_html || '',
        bodyText: parsed.bodyText || parsed.body_text || '',
      };
    } catch (error: any) {
      throw new Error(`Erro ao gerar resposta com IA: ${error.message}`);
    }
  },
};
