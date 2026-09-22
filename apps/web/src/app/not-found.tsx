import { TextLink } from '@/components/text-link';

export default function NotFound() {
  return (
    <div className="rounded-xl bg-card p-6 text-sm">
      There is nothing at this address. <TextLink href="/today">Go to Today</TextLink>.
    </div>
  );
}
