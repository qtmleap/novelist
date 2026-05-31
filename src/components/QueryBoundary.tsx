'use client'

import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { Component, type ReactNode, Suspense } from 'react'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { readApiError } from '@/lib/api/client'

class ReactErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: unknown }> {
  declare state: { error: unknown }
  constructor(props: { children: ReactNode; onReset: () => void }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch() {}

  render() {
    if (this.state.error !== null) {
      const retry = () => {
        this.setState({ error: null })
        this.props.onReset()
      }
      return <ErrorAlert message={readApiError(this.state.error, '取得に失敗しました')} onRetry={retry} />
    }
    return this.props.children
  }
}

type Props = {
  children: ReactNode
  fallback: ReactNode
}

export function QueryBoundary({ children, fallback }: Props) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ReactErrorBoundary onReset={reset}>
          <Suspense fallback={fallback}>{children}</Suspense>
        </ReactErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}
