# Köni documentation site

This is the public Next.js documentation experience for Köni. The repository's
Markdown files remain the maintainer reference; this application presents the
core concepts, configuration model, CLI, and graph/runtime visualizations as a
guided product experience.

## Local development

Use Node.js 22 or newer:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000>. Before publishing a change, run:

```sh
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
```

## Deployment

The app is configured for Vercel in `vercel.json`. Set
`NEXT_PUBLIC_SITE_URL` when deploying outside Vercel so canonical metadata and
the sitemap use the public origin. On Vercel, the production project URL is
detected automatically.

No runtime service, database, or secret is required. All documentation routes
are statically rendered during the production build.
