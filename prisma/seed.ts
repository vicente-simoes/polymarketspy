import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Default guardrails from planning.md section 6
const DEFAULT_GUARDRAILS = {
    maxWorseningVsTheirFillMicros: 10_000,   // $0.01
    maxOverMidMicros: 15_000,                 // $0.015
    maxSpreadMicros: 20_000,                  // $0.02
    minDepthMultiplierBps: 12_500,            // 1.25x
    noNewOpensWithinMinutesToClose: 30,
    decisionLatencyMs: 750,
    jitterMsMax: 250,
    maxTotalExposureBps: 7000,                // 70%
    maxExposurePerMarketBps: 500,             // 5%
    maxExposurePerUserBps: 2000,              // 20%
    dailyLossLimitBps: 300,                   // 3%
    weeklyLossLimitBps: 800,                  // 8%
    maxDrawdownLimitBps: 1200,                // 12%
}

// Default sizing from planning.md section 5.2
const DEFAULT_SIZING = {
    copyPctNotionalBps: 100,                  // 1%
    minTradeNotionalMicros: 5_000_000,        // 5 USDC
    maxTradeNotionalMicros: 250_000_000,      // 250 USDC
    maxTradeBankrollBps: 75,                  // 0.75%
}

async function main() {
    // Seed admin email
    const adminEmail = process.env.ADMIN_EMAIL
    if (adminEmail) {
        await prisma.allowedAdminEmail.upsert({
            where: { email: adminEmail },
            update: {},
            create: { email: adminEmail },
        })
        console.log(`Seeded admin email: ${adminEmail}`)
    } else {
        console.warn('ADMIN_EMAIL not set in env, skipping admin email seed.')
    }

    // Seed global guardrail config
    const existingGuardrail = await prisma.guardrailConfig.findFirst({
        where: { scope: 'GLOBAL', followedUserId: null }
    })
    if (!existingGuardrail) {
        await prisma.guardrailConfig.create({
            data: {
                scope: 'GLOBAL',
                followedUserId: null,
                configJson: DEFAULT_GUARDRAILS,
            }
        })
        console.log('Seeded global guardrail config')
    } else {
        console.log('Global guardrail config already exists, skipping')
    }

    // Seed global sizing config
    const existingSizing = await prisma.copySizingConfig.findFirst({
        where: { scope: 'GLOBAL', followedUserId: null }
    })
    if (!existingSizing) {
        await prisma.copySizingConfig.create({
            data: {
                scope: 'GLOBAL',
                followedUserId: null,
                configJson: DEFAULT_SIZING,
            }
        })
        console.log('Seeded global sizing config')
    } else {
        console.log('Global sizing config already exists, skipping')
    }

    console.log('Seed completed successfully')
}

main()
    .then(async () => {
        await prisma.$disconnect()
    })
    .catch(async (e) => {
        console.error(e)
        await prisma.$disconnect()
        process.exit(1)
    })
