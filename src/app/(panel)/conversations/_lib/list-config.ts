// Single source of truth for the conversations list page size.
//
// The server prefetch (page.tsx, `prefetchInfinite`) and the client
// `useInfiniteQuery` (conversations-view.tsx) MUST request the same page size,
// or their default (no-filter) react-query keys differ and the server-hydrated
// first page is silently discarded + refetched on the client (lost SSR, no
// type/test error to catch it). Importing this constant in both keeps them in
// lockstep instead of relying on two hand-synced literals.
export const PAGE_SIZE = 20;
