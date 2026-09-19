import { Title } from "@solidjs/meta";
import type { RouteDefinition } from "@solidjs/router";
import { httpStatus } from "@solidjs/web";

export const route = {
  preload: () => httpStatus(404),
} satisfies RouteDefinition;

export default function NotFound() {
  return (
    <main class="h-screen w-screen bg-neutral-950 text-neutral-200 grid place-items-center px-6">
      <Title>Not Found - Kennan's Tuner</Title>
      <div class="text-center grid gap-4 justify-items-center max-w-sm">
        <img src="/half-sharp.svg" alt="" width="64" height="64" />
        <h1 class="text-2xl font-medium tracking-tight">Off pitch</h1>
        <p class="text-sm text-neutral-400 leading-relaxed">
          That page doesn't exist.
        </p>
        <a
          href="/"
          class="mt-2 px-5 py-3 text-sm font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950"
        >
          Back to the tuner
        </a>
      </div>
    </main>
  );
}
