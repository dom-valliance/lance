import { TextLink } from '@/components/text-link';

export default function CommitmentNotFound() {
  return (
    <div className="rounded-xl bg-card p-6 text-sm">
      No commitment carries that id. <TextLink href="/commitments">Back to commitments</TextLink>.
    </div>
  );
}
