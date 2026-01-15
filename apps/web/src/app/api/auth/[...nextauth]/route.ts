import NextAuth, { NextAuthOptions } from "next-auth"
import GithubProvider from "next-auth/providers/github"
import { PrismaAdapter } from "@auth/prisma-adapter"
import prisma from "@/lib/prisma"

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma) as any,
    providers: [
        GithubProvider({
            clientId: process.env.GITHUB_CLIENT_ID!,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        }),
    ],
    session: {
        strategy: "jwt",
    },
    callbacks: {
        async signIn({ user }) {
            if (!user.email) return false

            const allowed = await prisma.allowedAdminEmail.findUnique({
                where: { email: user.email },
            })

            return !!allowed
        },
        async session({ session, token }) {
            if (session.user) {
                session.user.email = token.email
            }
            return session
        }
    },
}

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
