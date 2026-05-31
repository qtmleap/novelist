'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/client'

export type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; email: string }

export function useAuth(): AuthState {
  const { data, isPending } = useQuery({
    queryKey: ['auth'],
    queryFn: () => api.getAuthState(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY
  })
  if (isPending) return { status: 'loading' }
  if (!data || data.email === null) return { status: 'anonymous' }
  return { status: 'authenticated', email: data.email }
}

export function canEdit(state: AuthState): boolean {
  return state.status === 'authenticated'
}
