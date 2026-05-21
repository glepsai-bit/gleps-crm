import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FolderOpen, Users } from 'lucide-react';
import EmailCampaignsTab from '@/components/email/EmailCampaignsTab';
import EmailAudiencesTab from '@/components/email/EmailAudiencesTab';
import EmailQuotaCard from '@/components/email/EmailQuotaCard';

export default function AdminEmailsPage() {
  return (
    <div className="page-container space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">E-mails</h1>
        <p className="text-muted-foreground">Automação de e-mails com campanhas, cadências e assistente IA</p>
      </div>

      <EmailQuotaCard />

      <Tabs defaultValue="campaigns" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-[400px]">
          <TabsTrigger value="campaigns" className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Campanhas
          </TabsTrigger>
          <TabsTrigger value="audiences" className="flex items-center gap-2">
            <Users className="w-4 h-4" />
            Públicos
          </TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="mt-6">
          <EmailCampaignsTab />
        </TabsContent>

        <TabsContent value="audiences" className="mt-6">
          <EmailAudiencesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
