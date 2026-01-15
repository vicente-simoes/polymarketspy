export const fetcher = async (url: string) => {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
        const error = new Error('An error occurred while fetching the data.')
        // Attach extra info to the error object
        const info = await res.json().catch(() => ({}))
        ;(error as Error & { info?: unknown; status?: number }).info = info
        ;(error as Error & { info?: unknown; status?: number }).status = res.status
        throw error
    }
    return res.json()
}
