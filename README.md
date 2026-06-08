# Claude Design App

Describe it → see it → ship it. A live HTML design tool powered by Claude.

## Setup

```bash
cp .env.example .env
# Fill in your values
npm install  # in both /backend and /frontend
```

## Environment Variables

See `.env.example` for all required variables.

## Development

```bash
cd frontend && npm run dev    # Vite dev server
cd backend && npm run dev     # Express with watch
```

## Production (Docker)

```bash
docker build -t claude-design-app .
docker run -p 80:80 --env-file .env claude-design-app
```
