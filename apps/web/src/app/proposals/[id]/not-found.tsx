import { TextLink } from '@/components/text-link';

export default function ProposalNotFound() {
  return (
    <div className="rounded-xl bg-card p-6 text-sm">
      No proposal carries that id. <TextLink href="/proposals">Back to proposals</TextLink>.
    </div>
  );
}
