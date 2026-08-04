import { describe, it, expect } from 'vitest';
import { extractConnectedNumber } from './evolution.service';

/**
 * O fetchInstances da Evolution muda de shape entre versões. O extrator precisa
 * ser defensivo: array vs objeto; ownerJid/owner/number/wid; raiz vs aninhado
 * em `instance`; JID com @s.whatsapp.net.
 */
describe('extractConnectedNumber', () => {
  it('array com ownerJid (JID) → E.164 com +', () => {
    const raw = [{ name: 'inst-1', ownerJid: '5534993383017@s.whatsapp.net' }];
    expect(extractConnectedNumber(raw, 'inst-1')).toBe('+5534993383017');
  });

  it('objeto único (não-array) com owner', () => {
    const raw = { instanceName: 'inst-1', owner: '5534993383017@s.whatsapp.net' };
    expect(extractConnectedNumber(raw)).toBe('+5534993383017');
  });

  it('aninhado em instance.owner', () => {
    const raw = [{ instance: { instanceName: 'inst-1', owner: '551199998888@s.whatsapp.net' } }];
    expect(extractConnectedNumber(raw, 'inst-1')).toBe('+551199998888');
  });

  it('campo number puro (sem JID)', () => {
    const raw = [{ name: 'inst-1', number: '+55 34 99338-3017' }];
    expect(extractConnectedNumber(raw, 'inst-1')).toBe('+5534993383017');
  });

  it('escolhe a instância certa pelo nome quando há várias', () => {
    const raw = [
      { name: 'outra', ownerJid: '5511000000000@s.whatsapp.net' },
      { name: 'inst-1', ownerJid: '5534993383017@s.whatsapp.net' },
    ];
    expect(extractConnectedNumber(raw, 'inst-1')).toBe('+5534993383017');
  });

  it('sem nome casando → cai na primeira', () => {
    const raw = [{ name: 'x', ownerJid: '5534993383017@s.whatsapp.net' }];
    expect(extractConnectedNumber(raw, 'nao-existe')).toBe('+5534993383017');
  });

  it('sem candidato de número → null', () => {
    expect(extractConnectedNumber([{ name: 'inst-1', state: 'open' }], 'inst-1')).toBeNull();
  });

  it('raw vazio/null → null', () => {
    expect(extractConnectedNumber(null)).toBeNull();
    expect(extractConnectedNumber([])).toBeNull();
    expect(extractConnectedNumber(undefined)).toBeNull();
  });

  it('candidato sem dígitos → null', () => {
    expect(extractConnectedNumber([{ name: 'i', owner: '@s.whatsapp.net' }], 'i')).toBeNull();
  });
});
