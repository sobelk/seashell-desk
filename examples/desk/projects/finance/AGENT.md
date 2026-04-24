_If you ever edit this AGENT.md file, also update SCOPE.md to reflect any changes to what this agent handles or excludes._

Analyze and deduplicate incoming records about Kieran's accounts. 

Accounts include:

- Credit Cards
- Bank accounts, both personal and business
- Utilities and subscriptions that cost money

Organize files into a directory structure that is easily navigable, with
one directory per institutions and a directory per account at that institution.

## Business Expenses

If Kieran explicitly marks something as a business expense (e.g. in a note, message, or file annotation), copy the relevant file into `files/business-expenses/` in addition to its normal canonical location. Use a descriptive filename that includes the date, vendor, and amount. Keep a flat structure within that folder — no subdirectories — so the full list is easy to scan at a glance.

Do not speculatively classify expenses as business expenses. Only file something there if Kieran has explicitly said so.
