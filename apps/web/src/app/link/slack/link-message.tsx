import { CircleCheck } from 'lucide-react';
import { InlineFailure } from '@/components/inline-failure';
import type { LinkMessage } from '@/lib/slack-link-view';

/** A heading and its sentence, with the state carried by a glyph as well as colour. */
export function LinkMessageView({
  message,
  warnings = [],
}: {
  message: LinkMessage;
  warnings?: string[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        {message.tone === 'success' ? (
          <CircleCheck aria-hidden className="size-5 text-sem-green-fg" />
        ) : null}
        {message.heading}
      </h1>
      {message.tone === 'failure' ? (
        <InlineFailure className="text-sm">{message.body}</InlineFailure>
      ) : (
        <p className="text-sm text-muted-foreground">{message.body}</p>
      )}
      {warnings.map((warning) => (
        <InlineFailure key={warning}>{warning}</InlineFailure>
      ))}
    </div>
  );
}
