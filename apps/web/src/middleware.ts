import { withAuth } from "next-auth/middleware"

export default withAuth({
    callbacks: {
        authorized({ req, token }) {
            return !!token
        },
    },
})

// Protect all routes except auth endpoints and static files
export const config = {
    matcher: [
        /*
         * Match all request paths except:
         * - api/auth (NextAuth endpoints)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon)
         */
        "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
    ],
}
