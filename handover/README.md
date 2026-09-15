# Handover pack

Two files, both plain black and white, meant to be sent together by email.

| File | What it is |
| --- | --- |
| `Apron - Platform Overview.docx` | What the platform is, the four portals, and how a request travels from a sentence to confirmed suppliers. Written for someone who has not seen it before and is not technical. |
| `Apron - Sign-in accounts.xlsx` | Every sign-in account: portal, role, name, organisation, email, which portal it opens, and what it can do. 27 accounts across the 4 portals. |

## Before sending

**Fill in the password column.** It is deliberately empty. One password covers every account,
and it is not written into a file that travels by email — put it in the email body, or send it
separately.

**Add the address.** The overview says which portal each account opens (`/admin`, `/ops`,
`/provider`, `/client`) but not the host, because that depends on where it is running.

## Regenerating

Both files are generated from the live database, so they cannot drift from reality:

```bash
node scripts/build-overview-doc.mjs  --out "handover/Apron - Platform Overview.docx"
node scripts/build-account-sheet.mjs --out "handover/Apron - Sign-in accounts.xlsx"
```

The account sheet reads `users` from the running stack. Add a provider or a client and
re-running picks them up.

## A suggested covering note

> Attached is an overview of Apron and the sign-in details.
>
> Apron takes a ground-services request written as one ordinary sentence and turns it into
> confirmed suppliers at an airport — cars, close protection, hotels, catering, fuel and
> hangarage. There are four portals: one for the client making the request, one for the
> operations team running it, one for each supplier company, and an admin console for
> governance.
>
> The overview walks through how a request travels, end to end. The spreadsheet lists every
> account, which portal it opens, and what it can see — all of them use the password in this
> email.
>
> The best way to get a feel for it is the client portal: describe a trip in a sentence and
> follow what it asks you.
