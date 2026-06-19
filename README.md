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
GEMINI_API_KEY=your_gemini_key
GROQ_API_KEY=your_groq_key
OPENROUTER_API_KEY=your_openrouter_key
APP_PASSWORD=your_password
MAX_INPUT_CHARS=220000
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
GEMINI_API_KEY=your_gemini_key
GROQ_API_KEY=your_groq_key
OPENROUTER_API_KEY=your_openrouter_key
APP_PASSWORD=your_password
MAX_INPUT_CHARS=220000
```

Then deploy.
