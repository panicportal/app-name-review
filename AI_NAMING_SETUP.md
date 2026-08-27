# AI naming workshop setup

The embedded assistant is optional. All existing Name Studio features continue to work when it is disabled.

## Vercel environment variables

Add these in **Vercel project → Settings → Environment Variables**, then redeploy:

- `OPENAI_API_KEY` — a server-side OpenAI API key. Never prefix it with `NEXT_PUBLIC_` and never place it in browser JavaScript.
- `OPENAI_NAMING_MODEL` — optional model override. If omitted, the API route uses `gpt-5-mini`.

The app checks `/api/naming-assistant` and clearly reports whether the secure server connection is configured. A ChatGPT subscription is not used as a website API key; OpenAI API billing is managed separately.

## Stored data and safety

- The browser sends the selected portrait, exact traits, lock state, and at most 80 unused matching bank candidates to the server route.
- The server requests structured JSON. The assistant cannot write to Name Studio directly.
- A team member must press **Apply**, after which the browser revalidates first-name uniqueness, exact surname routes, two-trait structure, greenlit protection, and full-name uniqueness.
- Uploaded Markdown banks are kept separately in the existing Upstash/Redis project store, with original Markdown and parsed entries.
