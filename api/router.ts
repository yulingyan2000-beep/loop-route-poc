import { createRouter, publicQuery } from "./middleware";
import { loopRouter } from "./loop/router";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  loop: loopRouter,
});

export type AppRouter = typeof appRouter;
