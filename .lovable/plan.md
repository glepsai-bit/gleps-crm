

## Correção: Login admin@mychooice.com

### Problema
O usuário `admin@mychooice.com` **não existe no seed do backend Express**. O seed só cria 3 super admins: `superadmin@sistema.com`, `admin@gleps.com.br`, e `glepsai@gmail.com`. Por isso, no EasyPanel (que usa o backend Express), o login falha com "Credenciais inválidas".

No Lovable Cloud (preview), o usuário existe no banco mas a senha pode estar incorreta.

### Correções

**1. Adicionar `admin@mychooice.com` ao seed do backend** (`backend/src/prisma/seed.ts`)
- Incluir na lista `criticalAdmins`:
```typescript
{ email: 'admin@mychooice.com', nome: 'Admin MyChooice' },
```
- Isso garante que o usuário será criado/atualizado com senha `Admin@123` no próximo deploy.

**2. Resetar senha no Lovable Cloud**
- Chamar a Edge Function `set-user-password` para garantir que a senha `Admin@123` está correta no banco do Supabase para o usuário `admin@mychooice.com`.

### Resultado
- Login funciona no EasyPanel (após redeploy com novo seed)
- Login funciona no Lovable Cloud (após reset de senha)

