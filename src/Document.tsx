import type { ParentProps } from 'solid-js';
import { HydrationScript } from '@solidjs/web';

// The document shell — the new index.html: picked up by the src/Document.*
// convention, it wraps the app in the plugin's generated entries and must
// render the full <html>. Head tags go here. It is compiled only into the
// prerendered static shell and ships zero client-side JS: in client mode
// <HydrationScript /> is stripped from the shell, and it activates when the
// app flips to SSR (`ssr: true` in vite.config.ts) — no document changes
// needed. Delete this file to fall back to the plugin's built-in shell.
export default function Document(props: ParentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#10b981" />
        <meta
          name="description"
          content="A fast, mobile-friendly web-based instrument tuner. Free, no install, works in your browser."
        />
        <meta
          name="keywords"
          content="tuner, instrument tuner, guitar tuner, violin tuner, chromatic tuner, online tuner, web tuner, free tuner"
        />
        <link rel="canonical" href="https://tuner.kennan.dev/" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Kennan's Tuner" />
        <meta property="og:title" content="Kennan's Tuner" />
        <meta
          property="og:description"
          content="A fast, mobile-friendly web-based instrument tuner. Free, no install, works in your browser."
        />
        <meta property="og:url" content="https://tuner.kennan.dev/" />
        <meta property="og:image" content="https://tuner.kennan.dev/og-image.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:title" content="Kennan's Tuner" />
        <meta
          name="twitter:description"
          content="A fast, mobile-friendly web-based instrument tuner."
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="https://tuner.kennan.dev/og-image.png" />
        <link rel="icon" type="image/svg+xml" href="/half-sharp.svg" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Tuner" />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          innerHTML={JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: "Kennan's Tuner",
            url: 'https://tuner.kennan.dev/',
            description:
              'A fast, mobile-friendly web-based instrument tuner. Free, no install, works in your browser.',
            applicationCategory: 'MultimediaApplication',
            operatingSystem: 'Any',
            browserRequirements: 'Requires a modern browser with microphone access.',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            author: { '@type': 'Person', name: 'Kennan Hunter', url: 'https://kennan.dev' },
          })}
        />
        <title>Kennan's Tuner</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
