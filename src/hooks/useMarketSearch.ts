/* Marktanalyse — TanStack Query wrappers around the backend's
 * cache-aware /api/market/search endpoint.
 *
 * Two hooks:
 *   useMarketSearch(query, enabled)
 *     Fetches via POST (backend itself caches 24h in Postgres). The
 *     client also caches 6h via staleTime, so flipping back to the tab
 *     in the same session is instant. `enabled` lets the consumer
 *     keep the input "armed" without firing until the user clicks Suchen.
 *
 *   useMarketRefresh()
 *     Mutation for the force-refresh button. Invalidates the matching
 *     query key on success so the cached card swap-replaces with fresh
 *     data without a flash.
 *
 * Backend rate-limits force-refresh to 1/60s per user (429); we surface
 * the error so the UI can show a friendly message. */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { searchMarket } from '@/marathonApi';
import type { MarketSearchResponse } from '@/types/api';

const STALE_6H_MS = 6 * 60 * 60 * 1000;

function normalize(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function useMarketSearch(
  query: string,
  enabled: boolean,
): UseQueryResult<MarketSearchResponse, Error> {
  const normalized = normalize(query);
  return useQuery<MarketSearchResponse, Error>({
    queryKey: ['market-search', normalized],
    queryFn: () => searchMarket(normalized, false),
    enabled: enabled && normalized.length > 0,
    staleTime: STALE_6H_MS,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useMarketRefresh(): UseMutationResult<
  MarketSearchResponse,
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation<MarketSearchResponse, Error, string>({
    mutationFn: (query: string) => searchMarket(normalize(query), true),
    onSuccess: (data, query) => {
      qc.setQueryData(['market-search', normalize(query)], data);
    },
  });
}
