import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeading } from '@/components/page-heading';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        title="Settings"
        description="Quiet hours, push budget, live or dry-run mode, retention windows, a kill switch with reason, connector health and re-authorise buttons."
      />
      <Card>
        <CardHeader>
          <CardTitle>Microsoft 365</CardTitle>
          <CardDescription>
            Lance reads your mail and calendar with your delegated consent, and it prepares drafts,
            categories and holds for your approval. It cannot send mail. Connect once; refreshes are
            automatic afterwards. Connect again if the Slack status reports the Graph connector as
            disconnected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href="/api/graph/connect">Connect Microsoft 365</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
