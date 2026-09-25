# How Lance uses your data

Lance is Valliance's assistant. Before you connect anything, here is what it does with your data and other people's.

## What Lance reads

- Your Microsoft 365 mail and calendar, through the sign-in you give it.
- Your Jamie meetings: transcripts, summaries and action items, through the Jamie key you give it.
- The tasks under your name in Valliance's Notion All Tasks database.

It reads nobody else's mailbox or meetings. Your mail and meetings include other people: colleagues, clients and suppliers. Lance reads what they wrote to you, or said in a meeting with you, in the same way it reads your own.

## What Lance does with it

- Sorts your incoming mail and spots requests, promises and follow-ups.
- Prepares your morning brief, meeting preparation and weekly review.
- Suggests actions in your private Slack channel: a draft reply, a calendar hold, a task.

To do this it sends the text it needs to a language model, Anthropic's Claude. Mail goes to it for sorting; meeting transcripts go to it for debriefs and meeting preparation.

## What Lance never does

- It never sends email. It can only create drafts, which you send yourself.
- It acts only when you approve, and for your first five working days it acts on nothing at all.
- Nobody else sees your mail, meetings, drafts or briefs through Lance. Lance admins see only whether it is working for you and what it costs, never what it read.

## How long Lance keeps it

- Copies of your mail: 90 days.
- Copies of your meeting transcripts: 180 days.
- What the language model returned for a message: at most as long as the message.
- A record of what Lance read and did, without the content: two years.
- Names and email addresses of the people and organisations you deal with: kept, and shared with other Lance users, without saying whose mailbox they came from.

## While Lance is in pilot

Lance does not yet know which organisations are Valliance's clients. It treats every outside contact as unknown, so it asks you before every action and does not raise client alerts for you.

## Leaving

You can stop at any time: ask a Lance admin to offboard you. Lance then deletes your credentials, closes your Slack channel and removes its copies of your mail and transcripts the same day. If your Lance role is removed in Entra, this happens automatically after seven days.

Questions about your data go to Valliance's Data Protection Officer.
