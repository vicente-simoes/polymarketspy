import { redirect } from "next/navigation"

export default function PortfolioPositionRedirectPage({
    params,
}: {
    params: { assetId: string }
}) {
    redirect(`/paper-portfolio/positions/${encodeURIComponent(params.assetId)}`)
}

