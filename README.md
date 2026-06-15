# Home Codex Ready

A private Codex-style web app.

## Local setup

1. Unzip this folder.
2. Open terminal inside `home-codex-ready`.
3. Run:

```bash
npm install
```

4. Copy `.env.local.example` and rename it to `.env.local`.
5. Put your real values:

```env
OPENAI_API_KEY=your_key
GROQ_API_KEY=your_groq_key
APP_PASSWORD=your_password
```

6. Run:

```bash
npm run dev
```

7. Open:

```txt
http://localhost:3000
```

## Vercel deploy

Push this folder to GitHub and import it in Vercel.

Add these environment variables in Vercel:

```env
OPENAI_API_KEY=your_key
GROQ_API_KEY=your_groq_key
APP_PASSWORD=your_password
```

Then deploy.
